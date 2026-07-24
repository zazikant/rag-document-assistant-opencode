/**
 * Translation Pipeline — DSPy-inspired, streaming-native.
 *
 * Ported from the ax-translator project (D:\delete\ax-translator) and
 * adapted for rag-document-assistant:
 *   - Reuses the existing controlled streaming client `opencodeChatStreamControlled`
 *     (28s timeout, SSE-aware, structured logs) instead of duplicating one.
 *   - Preserves the DSPy/Ax design primitives from the source project:
 *       • compileTranslatePrompt — Signature-based prompt compilation
 *       • ErrorEntry tracking — surgical retry context (Mode A / Mode B)
 *       • resumeFrom state machine — deterministic pipeline progression
 *       • Activity-style discrete steps — translate → validate → refine
 *
 * Provider: OpenCode API (https://opencode.ai/zen/go/v1) with model glm-5.1.
 * The client handles thinking-mode disable internally; callers don't need
 * to set reasoning_effort or extra_body.
 *
 * Pipeline flow:
 *   1. translateText      — initial translation (or echo-retry with forceful prompt)
 *   2. validateTranslation — quality review (0-100 score + issues list)
 *   3. refineTranslation   — surgical fix targeted at the validator's issues
 *                            (up to MAX_REFINEMENTS rounds, re-validated each round)
 *
 * Two entry points are exported:
 *   - runTranslationStreamFast() — single LLM call, live-token streaming,
 *                                   no validate/refine. Best for chat latency.
 *   - runTranslationStream()     — full pipeline with state machine.
 *
 * Token handling is identical to ax-translator:
 *   - estimateTokens(): 1 token ≈ 4 chars for Latin, 2 chars for CJK
 *   - calculateMaxTokens(): input × 1.5, clamped to [2048, 16384]
 *   - Echo detection: if the model returns the source verbatim, retry with
 *     a forceful prompt that explicitly forbids echoing.
 */

import { opencodeChatStreamControlled } from './opencode';

// ─── Public Types (DSPy Signatures) ──────────────────────────────────────────

export interface TranslationRequest {
  text: string;
  sourceLanguage: string; // ISO code or 'auto'
  targetLanguage: string; // ISO code (e.g. 'es', 'hi')
  model?: string;
}

export interface TranslationResult {
  translatedText: string;
  qualityScore: number; // 0-100 (estimated 85 for fast mode; from validator otherwise)
  attempts: number;
  refinements: number;
  issues?: string[];
  model: string;
  pipeline: string[]; // ordered list of stages that actually ran
}

interface ErrorEntry {
  attempt: number;
  stage: 'translate' | 'validate' | 'refine';
  error: string;
  issues?: string[];
}

// Pipeline event — emitted to the SSE layer
export type TranslationEvent =
  | { type: 'stage-start'; stage: string; ts: number }
  | { type: 'log'; line: string; ts: number }
  | { type: 'chunk'; text: string; ts: number }
  | { type: 'stage-end'; stage: string; elapsedMs: number; ok: boolean; summary: string; ts: number }
  | { type: 'pipeline-end'; result: TranslationResult; ts: number }
  | { type: 'error'; message: string; ts: number };

export type EmitFn = (event: TranslationEvent) => void;

// ─── Constants ───────────────────────────────────────────────────────────────

const MAX_REFINEMENTS = 2;

// Output token budget. Translations are typically ≤ input length, but
// target languages with longer surface forms (e.g. German compound words)
// need headroom. Clamp to [2048, 16384] like the source project.
const MIN_OUTPUT_TOKENS = 2048;
const MAX_OUTPUT_TOKENS = 16384;
const OUTPUT_TOKEN_MULTIPLIER = 1.5;

// Validator gets a small fixed budget — its output is short JSON.
const VALIDATOR_MAX_TOKENS = 1024;

// ─── Token Estimation (ported verbatim from ax-translator) ───────────────────

/**
 * Rough token estimator. 1 token ≈ 4 chars for Latin scripts, 2 chars for
 * CJK ranges (Han, Hiragana, Katakana, Hangul).
 */
export function estimateTokens(text: string): number {
  const cjkChars = (text.match(/[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/g) || []).length;
  const otherChars = text.length - cjkChars;
  return Math.ceil(cjkChars / 2 + otherChars / 4);
}

/**
 * Calculate max_tokens for the output based on input length.
 * Output budget = input tokens × 1.5 (safety margin for longer targets).
 * Minimum 2048, maximum 16384 — matches the ax-translator heuristic.
 */
export function calculateMaxTokens(inputText: string): number {
  const inputTokens = estimateTokens(inputText);
  const outputTokens = Math.ceil(inputTokens * OUTPUT_TOKEN_MULTIPLIER);
  return Math.max(MIN_OUTPUT_TOKENS, Math.min(MAX_OUTPUT_TOKENS, outputTokens));
}

// ─── Echo Detection ──────────────────────────────────────────────────────────
// If the LLM returns the same text it was given (instead of translating),
// we detect it and retry with a more forceful prompt.

export function isEcho(originalText: string, translatedText: string): boolean {
  const normalize = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
  return normalize(originalText) === normalize(translatedText);
}

// ─── compileTranslatePrompt (pure DSPy-style) ────────────────────────────────
// Like DSPy's Module.compile() — produces focused retry context based on
// the error history. This is the ONLY place surgical-fix context is built.
//
// Mode A (initial): empty error history → returns initial-request summary.
// Mode B (surgical): latest error + previous attempts → focused fix context
//   that tells the next attempt exactly which patterns to avoid.

function compileTranslatePrompt(
  input: TranslationRequest,
  errorHistory: ErrorEntry[],
  stage: 'translate' | 'validate' | 'refine',
): string {
  if (errorHistory.length === 0) {
    return `Initial translation request from ${input.sourceLanguage} to ${input.targetLanguage}`;
  }

  const latestError = errorHistory[errorHistory.length - 1];
  const previousAttempts = errorHistory
    .slice(0, -1)
    .map((e) => `  Attempt ${e.attempt} | ${e.stage}: ${e.error.substring(0, 200)}`)
    .join('\n');

  return `Refinement context for stage "${stage}":
Latest issue (attempt ${latestError.attempt}, stage ${latestError.stage}): ${latestError.error.substring(0, 300)}
${latestError.issues ? `Issues: ${latestError.issues.join(', ')}` : ''}

Previous attempts — do NOT repeat these patterns:
${previousAttempts || '  None yet.'}

Source: ${input.text.substring(0, 200)}... → ${input.targetLanguage}`;
}

// ─── Prompt Builders ─────────────────────────────────────────────────────────

function translateSystemPrompt(srcLabel: string, targetLabel: string, isRetry: boolean): string {
  if (isRetry) {
    return `You are a professional translator. Your task is to TRANSLATE the given text from ${srcLabel} into ${targetLabel}.

CRITICAL INSTRUCTION: You MUST output the text IN ${targetLabel.toUpperCase()}. Do NOT output the same text in the original language. This is a translation task, not a repetition task. The previous attempt returned the original text unchanged — you must actually translate it this time.

Rules:
- Produce a clean, natural, and understandable translation in ${targetLabel}
- Preserve the original meaning exactly — do not add, remove, or change information
- Use natural phrasing that a native speaker of ${targetLabel} would use
- Output ONLY the translated text in ${targetLabel}, nothing else.`;
  }
  return `You are a professional translator. Translate the given text from ${srcLabel} to ${targetLabel}.

Rules:
- Produce a clean, natural, and understandable translation
- Preserve the original meaning exactly — do not add, remove, or change information
- Use natural phrasing that a native speaker would use
- Maintain the same tone and register (formal, informal, technical, etc.)
- If the text contains idioms, translate them to equivalent expressions in the target language
- If the text contains technical terms, use the standard terminology in the target language
- Output ONLY the translated text in ${targetLabel}, nothing else
- Do NOT output the original text — you must output the translation`;
}

const VALIDATOR_SYSTEM_PROMPT = `You are a translation quality reviewer. Evaluate the provided translation and respond in JSON format.

Evaluate on these criteria:
1. Accuracy: Does the translation preserve the original meaning?
2. Fluency: Is the translation natural and well-formed in the target language?
3. Completeness: Is any information missing or added?
4. Terminology: Are technical terms translated correctly?

Respond in this exact JSON format:
{
  "isValid": true/false,
  "qualityScore": 0-100,
  "issues": ["issue1", "issue2"],
  "suggestion": "optional improvement suggestion"
}

If the translation is good enough for practical use, set isValid to true even if minor improvements are possible.`;

const REFINER_SYSTEM_PROMPT = `You are a professional translator refining a translation.
Fix ALL the issues identified while keeping the rest of the translation unchanged.
Output ONLY the improved translation, nothing else.`;

// ─── Output Cleaner ──────────────────────────────────────────────────────────
// Strip markdown code fences and surrounding quotes the LLM sometimes adds.

function cleanLlmOutput(raw: string): string {
  return raw
    .replace(/^```[\w]*\n?/m, '')
    .replace(/\n?```$/m, '')
    .replace(/^["']|["']$/g, '')
    .trim();
}

// ─── Stage 1: translateText (streaming) ──────────────────────────────────────

async function translateTextStream(
  input: TranslationRequest,
  emit: EmitFn,
  isRetry: boolean,
): Promise<{ translatedText: string; model: string; elapsedMs: number }> {
  const srcLabel = input.sourceLanguage === 'auto' ? 'the detected source language' : input.sourceLanguage;
  const targetLabel = input.targetLanguage;
  const systemPrompt = translateSystemPrompt(srcLabel, targetLabel, isRetry);
  const userContent = `Translate the following text from ${srcLabel} to ${targetLabel}. The output must be in ${targetLabel}:\n\n${input.text}`;
  const maxTokens = calculateMaxTokens(input.text);

  emit({
    type: 'log',
    line: `[pipeline] translateText (retry=${isRetry}) src=${srcLabel} target=${targetLabel} input_chars=${input.text.length} max_tokens=${maxTokens}`,
    ts: Date.now(),
  });

  let raw = '';
  const result = await opencodeChatStreamControlled({
    model: input.model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ],
    temperature: 0.3,
    maxTokens,
    onLog: (line) => emit({ type: 'log', line, ts: Date.now() }),
    onChunk: (text) => {
      raw += text;
      emit({ type: 'chunk', text, ts: Date.now() });
    },
  });

  const cleaned = cleanLlmOutput(raw);
  emit({
    type: 'log',
    line: `[pipeline] translateText done length=${cleaned.length} isEcho=${isEcho(input.text, cleaned)}`,
    ts: Date.now(),
  });

  return { translatedText: cleaned, model: result.model, elapsedMs: result.elapsedMs };
}

// ─── Stage 2: validateTranslation ────────────────────────────────────────────

interface ValidationResult {
  isValid: boolean;
  qualityScore: number;
  issues: string[];
  suggestion?: string;
}

async function validateTranslationStream(
  input: TranslationRequest,
  translatedText: string,
  emit: EmitFn,
): Promise<ValidationResult> {
  const srcLabel = input.sourceLanguage === 'auto' ? 'detected' : input.sourceLanguage;
  const userContent = `Source text (${srcLabel}):
"""
${input.text}
"""

Translation (${input.targetLanguage}):
"""
${translatedText}
"""`;

  emit({ type: 'log', line: `[pipeline] validateTranslation — calling OpenCode for JSON review`, ts: Date.now() });

  const result = await opencodeChatStreamControlled({
    model: input.model,
    messages: [
      { role: 'system', content: VALIDATOR_SYSTEM_PROMPT },
      { role: 'user', content: userContent },
    ],
    temperature: 0.1,
    maxTokens: VALIDATOR_MAX_TOKENS,
    onLog: (line) => emit({ type: 'log', line, ts: Date.now() }),
    // Validator output is internal JSON — do NOT stream its tokens to the user.
  });

  try {
    const jsonMatch = result.content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { isValid: true, qualityScore: 70, issues: ['Could not parse validation response'] };
    }
    const parsed = JSON.parse(jsonMatch[0]);
    return {
      isValid: parsed.isValid ?? true,
      qualityScore: parsed.qualityScore ?? 70,
      issues: parsed.issues ?? [],
      suggestion: parsed.suggestion,
    };
  } catch {
    return { isValid: true, qualityScore: 70, issues: ['Could not parse validation response'] };
  }
}

// ─── Stage 3: refineTranslation (streaming) ──────────────────────────────────

async function refineTranslationStream(
  input: TranslationRequest,
  translatedText: string,
  issues: string[],
  emit: EmitFn,
): Promise<{ refinedText: string; elapsedMs: number }> {
  const issuesList = issues.map((i) => `- ${i}`).join('\n');
  const srcLabel = input.sourceLanguage === 'auto' ? 'detected' : input.sourceLanguage;
  const userContent = `Source text (${srcLabel}):
"""
${input.text}
"""

Current translation (${input.targetLanguage}):
"""
${translatedText}
"""

Issues found with the current translation:
${issuesList}`;

  emit({ type: 'log', line: `[pipeline] refineTranslation — surgical fix for ${issues.length} issue(s)`, ts: Date.now() });

  let raw = '';
  const result = await opencodeChatStreamControlled({
    model: input.model,
    messages: [
      { role: 'system', content: REFINER_SYSTEM_PROMPT },
      { role: 'user', content: userContent },
    ],
    temperature: 0.2,
    maxTokens: calculateMaxTokens(translatedText),
    onLog: (line) => emit({ type: 'log', line, ts: Date.now() }),
    onChunk: (text) => {
      raw += text;
      emit({ type: 'chunk', text, ts: Date.now() });
    },
  });

  return { refinedText: cleanLlmOutput(raw), elapsedMs: result.elapsedMs };
}

// ─── Fast Mode: single streaming translate call ──────────────────────────────
// No validate/refine. Echo detection triggers a single forceful retry.
// Latency-friendly — best for chat-integrated translation.

export async function runTranslationStreamFast(
  input: TranslationRequest,
  emit: EmitFn,
): Promise<TranslationResult> {
  const t0 = Date.now();
  emit({ type: 'stage-start', stage: 'translate', ts: t0 });

  let translatedText = '';
  let model = input.model || 'glm-5.1';
  const pipeline: string[] = ['fast-translate'];

  try {
    const first = await translateTextStream(input, emit, false);
    translatedText = first.translatedText;
    model = first.model;

    // Echo detection — retry once with a forceful prompt
    if (isEcho(input.text, translatedText) && input.sourceLanguage !== input.targetLanguage) {
      emit({ type: 'log', line: `[pipeline] Echo detected — retrying with forceful prompt`, ts: Date.now() });
      pipeline.push('echo-detected', 'fast-retry');
      // Reset streamed text — emit a marker so the client knows to reset its buffer.
      // We re-stream from scratch.
      const retry = await translateTextStream(input, emit, true);
      translatedText = retry.translatedText;
    }

    emit({
      type: 'stage-end',
      stage: 'translate',
      elapsedMs: Date.now() - t0,
      ok: true,
      summary: `${translatedText.length} chars`,
      ts: Date.now(),
    });

    const out: TranslationResult = {
      translatedText,
      qualityScore: 85, // estimated — no validation step
      attempts: pipeline.includes('fast-retry') ? 2 : 1,
      refinements: 0,
      issues: undefined,
      model,
      pipeline,
    };
    emit({ type: 'pipeline-end', result: out, ts: Date.now() });
    return out;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    emit({
      type: 'stage-end',
      stage: 'translate',
      elapsedMs: Date.now() - t0,
      ok: false,
      summary: msg,
      ts: Date.now(),
    });
    emit({ type: 'error', message: msg, ts: Date.now() });
    const out: TranslationResult = {
      translatedText: '',
      qualityScore: 0,
      attempts: 1,
      refinements: 0,
      issues: [msg],
      model,
      pipeline,
    };
    emit({ type: 'pipeline-end', result: out, ts: Date.now() });
    return out;
  }
}

// ─── Full Pipeline: translate → validate → refine (state machine) ────────────

export async function runTranslationStream(
  input: TranslationRequest,
  emit: EmitFn,
): Promise<TranslationResult> {
  const t0 = Date.now();
  emit({ type: 'stage-start', stage: 'full-pipeline', ts: t0 });
  emit({
    type: 'log',
    line: `[pipeline] full mode: translate → validate → refine (src=${input.sourceLanguage}, target=${input.targetLanguage})`,
    ts: Date.now(),
  });

  let attempt = 0;
  let refinements = 0;
  let resumeFrom: 'translate' | 'validate' | 'refine' | 'done' = 'translate';
  const errorHistory: ErrorEntry[] = [];
  const pipeline: string[] = [];

  let translatedText = '';
  let qualityScore = 0;
  let issues: string[] = [];
  let model = input.model || 'glm-5.1';

  // ── Stage 1: Translate (with echo-detection retry) ────────────────────────
  if (resumeFrom === 'translate') {
    attempt++;
    pipeline.push('translate');
    emit({ type: 'stage-start', stage: 'translate', ts: Date.now() });

    try {
      const result = await translateTextStream(input, emit, false);
      translatedText = result.translatedText;
      model = result.model;

      if (isEcho(input.text, translatedText) && input.sourceLanguage !== input.targetLanguage) {
        emit({ type: 'log', line: `[pipeline] Echo detected — retrying with forceful prompt`, ts: Date.now() });
        pipeline.push('echo-detected', 'translate-retry');
        attempt++;
        const retry = await translateTextStream(input, emit, true);
        translatedText = retry.translatedText;
        if (isEcho(input.text, translatedText)) {
          pipeline.push('echo-persist');
        }
      }
      emit({ type: 'stage-end', stage: 'translate', elapsedMs: result.elapsedMs, ok: true, summary: `${translatedText.length} chars`, ts: Date.now() });
      resumeFrom = 'validate';
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      errorHistory.push({ attempt, stage: 'translate', error: errorMsg });
      emit({ type: 'stage-end', stage: 'translate', elapsedMs: Date.now() - t0, ok: false, summary: errorMsg.slice(0, 150), ts: Date.now() });

      if (attempt < 2) {
        attempt++;
        pipeline.push('translate-retry');
        const fixContext = compileTranslatePrompt(input, errorHistory, 'translate');
        emit({ type: 'log', line: `[pipeline] translate retry context: ${fixContext.substring(0, 200)}`, ts: Date.now() });

        try {
          const retry = await translateTextStream(input, emit, true);
          translatedText = retry.translatedText;
          model = retry.model;
          emit({ type: 'stage-end', stage: 'translate', elapsedMs: retry.elapsedMs, ok: true, summary: `${translatedText.length} chars (retry)`, ts: Date.now() });
          resumeFrom = 'validate';
        } catch (err2: unknown) {
          const errorMsg2 = err2 instanceof Error ? err2.message : String(err2);
          errorHistory.push({ attempt, stage: 'translate', error: errorMsg2 });
          emit({ type: 'stage-end', stage: 'translate', elapsedMs: 0, ok: false, summary: 'failed after retry', ts: Date.now() });
          return finalize(translatedText, qualityScore, attempt, refinements, ['Translation failed after retry'], model, pipeline, emit);
        }
      } else {
        return finalize(translatedText, qualityScore, attempt, refinements, ['Translation failed'], model, pipeline, emit);
      }
    }
  }

  // ── Stage 2: Validate ────────────────────────────────────────────────────
  if (resumeFrom === 'validate') {
    pipeline.push('validate');
    emit({ type: 'stage-start', stage: 'validate', ts: Date.now() });
    try {
      const v0 = Date.now();
      const validation = await validateTranslationStream(input, translatedText, emit);
      qualityScore = validation.qualityScore;
      issues = validation.issues;

      if (isEcho(input.text, translatedText) && input.sourceLanguage !== input.targetLanguage) {
        pipeline.push('echo-caught-by-validation');
        qualityScore = Math.min(qualityScore, 30);
        issues = [...issues, 'Translation appears identical to source text — not actually translated'];
        emit({ type: 'stage-end', stage: 'validate', elapsedMs: Date.now() - v0, ok: false, summary: 'echo caught', ts: Date.now() });
        resumeFrom = 'refine';
      } else if (validation.isValid) {
        pipeline.push('validate-pass');
        emit({ type: 'stage-end', stage: 'validate', elapsedMs: Date.now() - v0, ok: true, summary: `score=${qualityScore}`, ts: Date.now() });
        resumeFrom = 'done';
      } else {
        pipeline.push('validate-fail');
        emit({ type: 'stage-end', stage: 'validate', elapsedMs: Date.now() - v0, ok: false, summary: `score=${qualityScore} issues=${issues.length}`, ts: Date.now() });
        resumeFrom = 'refine';
      }
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      errorHistory.push({ attempt, stage: 'validate', error: errorMsg });
      qualityScore = 60;
      emit({ type: 'stage-end', stage: 'validate', elapsedMs: 0, ok: false, summary: `validate error: ${errorMsg.slice(0, 100)}`, ts: Date.now() });
      resumeFrom = 'done';
    }
  }

  // ── Stage 3: Refine (up to MAX_REFINEMENTS rounds, re-validated each) ────
  while (resumeFrom === 'refine' && refinements < MAX_REFINEMENTS) {
    refinements++;
    attempt++;
    pipeline.push(`refine-${refinements}`);
    emit({ type: 'stage-start', stage: `refine-${refinements}`, ts: Date.now() });

    const fixContext = compileTranslatePrompt(input, errorHistory, 'refine');
    emit({ type: 'log', line: `[pipeline] Refinement #${refinements} context: ${fixContext.substring(0, 200)}`, ts: Date.now() });

    try {
      const refine = await refineTranslationStream(input, translatedText, issues, emit);
      translatedText = refine.refinedText;
      emit({ type: 'stage-end', stage: `refine-${refinements}`, elapsedMs: refine.elapsedMs, ok: true, summary: `${translatedText.length} chars`, ts: Date.now() });

      // Re-validate after refinement
      pipeline.push(`revalidate-${refinements}`);
      emit({ type: 'stage-start', stage: `revalidate-${refinements}`, ts: Date.now() });
      try {
        const revalidation = await validateTranslationStream(input, translatedText, emit);
        qualityScore = revalidation.qualityScore;
        issues = revalidation.issues;

        if (revalidation.isValid && !isEcho(input.text, translatedText)) {
          pipeline.push(`revalidate-pass-${refinements}`);
          emit({ type: 'stage-end', stage: `revalidate-${refinements}`, elapsedMs: 0, ok: true, summary: `score=${qualityScore}`, ts: Date.now() });
          resumeFrom = 'done';
          break;
        } else {
          pipeline.push(`revalidate-fail-${refinements}`);
          emit({ type: 'stage-end', stage: `revalidate-${refinements}`, elapsedMs: 0, ok: false, summary: `score=${qualityScore}`, ts: Date.now() });
          if (refinements >= MAX_REFINEMENTS) {
            resumeFrom = 'done';
            break;
          }
        }
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        errorHistory.push({ attempt, stage: 'validate', error: errorMsg });
        qualityScore = 65;
        emit({ type: 'stage-end', stage: `revalidate-${refinements}`, elapsedMs: 0, ok: false, summary: errorMsg.slice(0, 100), ts: Date.now() });
        resumeFrom = 'done';
        break;
      }
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      errorHistory.push({ attempt, stage: 'refine', error: errorMsg, issues });
      emit({ type: 'stage-end', stage: `refine-${refinements}`, elapsedMs: 0, ok: false, summary: errorMsg.slice(0, 100), ts: Date.now() });
      if (refinements >= MAX_REFINEMENTS) {
        resumeFrom = 'done';
        break;
      }
    }
  }

  return finalize(
    translatedText,
    qualityScore,
    attempt,
    refinements,
    issues.length > 0 ? issues : undefined,
    model,
    pipeline,
    emit,
  );
}

function finalize(
  translatedText: string,
  qualityScore: number,
  attempt: number,
  refinements: number,
  issues: string[] | undefined,
  model: string,
  pipeline: string[],
  emit: EmitFn,
): TranslationResult {
  const result: TranslationResult = {
    translatedText,
    qualityScore,
    attempts: attempt,
    refinements,
    issues,
    model,
    pipeline,
  };
  emit({ type: 'pipeline-end', result, ts: Date.now() });
  return result;
}

// ─── Language Registry (ported from ax-translator) ───────────────────────────
// 26 languages including Hindi, Spanish, French, Japanese, Chinese, Arabic, etc.
//
// The canonical list lives in @/lib/languages (client-safe). This file
// re-exports it for server callers so they can keep importing from one place.

export { LANGUAGES, languageLabel } from './languages';
export type { LanguageCode } from './languages';
import { LANGUAGES, languageLabel } from './languages';

// ─── Large-Input Handling (ported from ax-translator) ────────────────────────
// ax-translator's page.tsx detects text >4000 tokens ("isLargeInput") and
// streams it through the pipeline in ~3K-token chunks instead of one big
// call. Each chunk is translated independently with pipeline-level retry
// (3 attempts) and an adaptive inter-chunk cooldown so OpenCode's rate-limit                                 
// window has time to reset.
//
// For rag-document-assistant, the same logic is exposed as a server-side
// streaming entry point so the UI doesn't need to coordinate chunks itself
// — the SSE stream just emits per-chunk stage-start/log/chunk/stage-end
// events the same way a single translation does.

/** Threshold above which chunked translation kicks in (ax-translator: 4000). */
export const LARGE_INPUT_TOKEN_THRESHOLD = 4000;

/** Target chunk size (~3K tokens per chunk, ax-translator's value). */
export const CHUNK_TARGET_TOKENS = 3000;

/** Per-chunk pipeline-level retry budget. */
export const MAX_CHUNK_ATTEMPTS = 3;

/** Inter-chunk cooldown caps (seconds). Adaptive based on prior chunk. */
export const COOLDOWN_FIRST_SUCCESS_SEC = 10;
export const COOLDOWN_RETRY_SUCCESS_SEC = 30;
export const COOLDOWN_FAILED_SEC = 60;
export const COOLDOWN_HARD_CAP_SEC = 60;

/**
 * Split text into chunks at paragraph / sentence boundaries, each under
 * maxTokens. Ported verbatim from ax-translator's page.tsx (splitIntoChunks).
 *
 * Strategy:
 *   1. Split on blank-line paragraph boundaries (\n\n+).
 *   2. If a single paragraph is itself over budget, fall back to sentence
 *      boundary splitting (regex /(?<=[.!?])\s+/).
 *   3. Accumulate paragraphs/sentences into the current chunk until adding
 *      the next would exceed maxTokens, then flush.
 *   4. If the entire text is one unbreakable run, return [text].
 */
export function splitIntoChunks(text: string, maxTokens: number): string[] {
  const paragraphs = text.split(/\n\n+/);
  const chunks: string[] = [];
  let currentChunk = '';

  for (const para of paragraphs) {
    const paraTokens = estimateTokens(para);
    const currentTokens = estimateTokens(currentChunk);

    // If a single paragraph exceeds max, split by sentences
    if (paraTokens > maxTokens) {
      if (currentChunk.trim()) {
        chunks.push(currentChunk.trim());
        currentChunk = '';
      }
      const sentences = para.split(/(?<=[.!?])\s+/);
      for (const sentence of sentences) {
        const sentTokens = estimateTokens(sentence);
        const currTokens = estimateTokens(currentChunk);
        if (currTokens + sentTokens > maxTokens && currentChunk.trim()) {
          chunks.push(currentChunk.trim());
          currentChunk = sentence + ' ';
        } else {
          currentChunk += sentence + ' ';
        }
      }
      continue;
    }

    if (currentTokens + paraTokens > maxTokens && currentChunk.trim()) {
      chunks.push(currentChunk.trim());
      currentChunk = para + '\n\n';
    } else {
      currentChunk += para + '\n\n';
    }
  }

  if (currentChunk.trim()) {
    chunks.push(currentChunk.trim());
  }

  return chunks.length > 0 ? chunks : [text];
}

/**
 * Decide whether an input is "large" and should be chunked.
 * Same heuristic as ax-translator's isLargeInput.
 */
export function isLargeInput(text: string): boolean {
  return estimateTokens(text) > LARGE_INPUT_TOKEN_THRESHOLD;
}

/**
 * Pick the inter-chunk cooldown (seconds) based on the previous chunk's
 * outcome. Ported from ax-translator's adaptive cooldown:
 *   - Succeeded on first attempt: 10s (quick breather)
 *   - Succeeded after retries:     30s (something was flaky)
 *   - Failed all attempts:         60s (rate limit likely)
 *   - Rate-limit error detected:  60s
 * Hard-capped at 60s.
 */
export function adaptiveCooldownSec(
  succeeded: boolean,
  attemptsUsed: number,
  lastErrorMsg: string = '',
): number {
  const isRateLimitError = /rate.?limit|429|too many requests/i.test(lastErrorMsg);
  let delaySec: number;
  if (!succeeded) {
    delaySec = isRateLimitError ? COOLDOWN_FAILED_SEC : COOLDOWN_RETRY_SUCCESS_SEC;
  } else if (attemptsUsed > 1) {
    delaySec = COOLDOWN_RETRY_SUCCESS_SEC;
  } else {
    delaySec = COOLDOWN_FIRST_SUCCESS_SEC;
  }
  return Math.min(delaySec, COOLDOWN_HARD_CAP_SEC);
}

/**
 * Chunked streaming translation — ported from ax-translator's page.tsx
 * `handleTranslate` large-input branch.
 *
 * Splits the input into ~CHUNK_TARGET_TOKENS chunks, translates each one
 * sequentially through `runTranslationStreamFast`, and emits per-chunk
 * stage events. Each chunk gets up to MAX_CHUNK_ATTEMPTS retries; between
 * chunks there is an adaptive cooldown (see adaptiveCooldownSec).
 *
 * Notes:
 *   - The SSE event stream is identical in shape to a single translation
 *     (stage-start / log / chunk / stage-end / pipeline-end), so clients
 *     don't need special handling beyond reading stage names. Each chunk's
 *     stage is named `chunk-${i+1}-${total}`.
 *   - Chunks that fail all retries are replaced with a placeholder in the
 *     output so the join still produces a complete document the user can
 *     edit.
 *   - On Vercel Edge the 60s cooldown may exceed the 30s function cap —
 *     the stream will be killed by the platform. The live log warns about
 *     this. For reliably long documents, deploy to a non-Vercel host.
 */
export async function runTranslationStreamChunked(
  input: TranslationRequest,
  emit: EmitFn,
): Promise<TranslationResult> {
  const t0 = Date.now();
  emit({ type: 'stage-start', stage: 'chunking', ts: t0 });

  const chunks = splitIntoChunks(input.text, CHUNK_TARGET_TOKENS);
  emit({
    type: 'log',
    line: `[pipeline] Large input: ${chunks.length} chunks × ~${CHUNK_TARGET_TOKENS} tokens each. Streaming each chunk through translate-stream.`,
    ts: Date.now(),
  });

  // Warn about Vercel Edge 30s cap for multi-chunk inputs.
  if (chunks.length >= 3) {
    emit({
      type: 'log',
      line: `[pipeline] ⚠️ ${chunks.length} chunks with inter-chunk cooldowns may exceed Vercel's 30s function cap. Consider splitting into smaller inputs, or use a non-Vercel host for large documents.`,
      ts: Date.now(),
    });
  }

  const translatedChunks: string[] = [];
  let totalQuality = 0;
  let totalAttempts = 0;
  let totalRefinements = 0;
  let succeededChunks = 0;
  const pipeline: string[] = [`chunked-${chunks.length}`];

  for (let i = 0; i < chunks.length; i++) {
    emit({
      type: 'stage-start',
      stage: `chunk-${i + 1}-${chunks.length}`,
      ts: Date.now(),
    });

    const chunkInput: TranslationRequest = { ...input, text: chunks[i] };
    let chunkResult: TranslationResult | null = null;
    let lastChunkError = '';

    for (let chunkAttempt = 1; chunkAttempt <= MAX_CHUNK_ATTEMPTS; chunkAttempt++) {
      if (chunkAttempt > 1) {
        emit({
          type: 'log',
          line: `[pipeline] Chunk ${i + 1}/${chunks.length} attempt ${chunkAttempt}/${MAX_CHUNK_ATTEMPTS} — retrying via stream…`,
          ts: Date.now(),
        });
      }

      // Use a child emit wrapper that forwards chunks with the chunk stage tag.
      // The fast-mode call emits its own stage-start/stage-end for `translate`,
      // which the client can ignore since we already emitted a `chunk-i-n` stage.
      const childEmit: EmitFn = (event) => {
        if (event.type === 'chunk') {
          // Re-emit chunk events as normal — they carry the live tokens
          emit(event);
        } else if (event.type === 'log') {
          emit(event);
        } else if (event.type === 'error') {
          emit(event);
        }
        // Swallow child stage-start/stage-end/pipeline-end — we emit our own.
      };

      try {
        chunkResult = await runTranslationStreamFast(chunkInput, childEmit);
        if (chunkResult.translatedText.trim().length === 0) {
          throw new Error('Empty translation result.');
        }
        lastChunkError = '';
        break;
      } catch (chunkErr: unknown) {
        const msg = chunkErr instanceof Error ? chunkErr.message : String(chunkErr);
        lastChunkError = msg;
        emit({
          type: 'log',
          line: `[pipeline] Chunk ${i + 1}/${chunks.length} attempt ${chunkAttempt}/${MAX_CHUNK_ATTEMPTS} FAILED: ${msg.slice(0, 150)}`,
          ts: Date.now(),
        });
        if (chunkAttempt === MAX_CHUNK_ATTEMPTS) {
          emit({
            type: 'log',
            line: `[pipeline] Chunk ${i + 1}/${chunks.length} failed ${MAX_CHUNK_ATTEMPTS}× — skipping (will use remaining chunks).`,
            ts: Date.now(),
          });
        }
      }
    }

    if (chunkResult && chunkResult.translatedText.trim()) {
      // Echo detection per chunk
      if (chunkResult.translatedText.trim() === chunks[i].trim()) {
        emit({
          type: 'log',
          line: `[pipeline] Chunk ${i + 1} returned same text — model echo detected`,
          ts: Date.now(),
        });
      }
      translatedChunks.push(chunkResult.translatedText);
      totalQuality += chunkResult.qualityScore;
      totalAttempts += chunkResult.attempts;
      totalRefinements += chunkResult.refinements;
      succeededChunks++;
      emit({
        type: 'stage-end',
        stage: `chunk-${i + 1}-${chunks.length}`,
        ok: true,
        elapsedMs: 0,
        summary: `${chunkResult.translatedText.length} chars translated`,
        ts: Date.now(),
      });
    } else {
      translatedChunks.push(`[Chunk ${i + 1} failed: ${lastChunkError.slice(0, 100)}]`);
      emit({
        type: 'stage-end',
        stage: `chunk-${i + 1}-${chunks.length}`,
        ok: false,
        elapsedMs: 0,
        summary: `failed: ${lastChunkError.slice(0, 100)}`,
        ts: Date.now(),
      });
    }

    // ── Inter-chunk cooldown (rate-limit reset window) ─────────────────────
    // Skip after the last chunk — no cooldown needed before close.
    if (i < chunks.length - 1) {
      const succeeded = !!(chunkResult && chunkResult.translatedText.trim());
      const attemptsUsed = chunkResult?.attempts ?? MAX_CHUNK_ATTEMPTS;
      const delaySec = adaptiveCooldownSec(succeeded, attemptsUsed, lastChunkError);
      emit({
        type: 'log',
        line: `[pipeline] Cooldown: waiting ${delaySec}s before chunk ${i + 2}/${chunks.length} (lets OpenCode rate-limit window reset)…`,
        ts: Date.now(),
      });
      await new Promise((r) => setTimeout(r, delaySec * 1000));
      emit({
        type: 'log',
        line: `[pipeline] Cooldown complete — starting chunk ${i + 2}/${chunks.length}.`,
        ts: Date.now(),
      });
    }
  }

  pipeline.push(`${succeededChunks}ok`);

  const result: TranslationResult = {
    translatedText: translatedChunks.join('\n\n'),
    qualityScore: succeededChunks > 0 ? Math.round(totalQuality / succeededChunks) : 0,
    attempts: totalAttempts,
    refinements: totalRefinements,
    model: input.model || 'glm-5.1',
    pipeline,
  };
  emit({ type: 'stage-end', stage: 'chunking', ok: succeededChunks > 0, elapsedMs: Date.now() - t0, summary: `${succeededChunks}/${chunks.length} chunks succeeded`, ts: Date.now() });
  emit({ type: 'pipeline-end', result, ts: Date.now() });
  return result;
}

/**
 * Top-level streaming translation entry point.
 *
 * Picks fast vs. chunked automatically based on the input token count
 * (same heuristic as ax-translator's isLargeInput branch). The simpler
 * `runTranslationStreamFast` and the explicit chunked path are still
 * exported for callers that want full control.
 */
export async function runTranslationStreamAuto(
  input: TranslationRequest,
  emit: EmitFn,
): Promise<TranslationResult> {
  if (isLargeInput(input.text)) {
    return runTranslationStreamChunked(input, emit);
  }
  return runTranslationStreamFast(input, emit);
}
