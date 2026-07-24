import { NextRequest } from 'next/server';
import { searchRecords, rerankAndAggregate, buildContextFromAggregated } from '@/lib/pinecone-edge';
import { opencodeChatStreamControlled } from '@/lib/opencode';
import {
  calculateMaxTokens,
  isEcho,
  languageLabel,
  isLargeInput,
  splitIntoChunks,
  CHUNK_TARGET_TOKENS,
  MAX_CHUNK_ATTEMPTS,
  adaptiveCooldownSec,
} from '@/lib/translation-pipeline';

// Note: We use pinecone-edge (direct REST API) instead of pinecone (SDK)
// because the Pinecone SDK pulls in node:stream which is unsupported in
// Edge runtime. Same for @supabase/supabase-js — we use the REST API
// directly when source validation is needed.

/**
 * Streaming RAG query endpoint (Server-Sent Events) — DSPy-style.
 *
 * POST /api/query-stream
 *   { query, top_k?, filters?, mode?, targetLanguage? }
 *
 *   targetLanguage (optional): ISO code (e.g. 'es', 'hi'). When set,
 *   after the RAG answer is generated, an additional `translate` stage
 *   stream-translates the answer into the requested language using the
 *   DSPy-style translation pipeline (ax-translator pattern).
 *
 * Response: text/event-stream with structured events:
 *   stage-start / log / chunk / stage-end / pipeline-end / error
 *
 *   `chunk` events carry an optional `stage` field:
 *     - stage === 'answer'    → tokens of the RAG answer (default)
 *     - stage === 'translate' → tokens of the translated answer
 *   Clients that only render `liveText` should reset their buffer when
 *   `stage-start: translate` arrives, then append `stage=translate`
 *   chunks to a separate "translated answer" buffer.
 *
 * DSPy-style pipeline (ax-translator pattern):
 *   1. Search Pinecone
 *   2. Validate sources (Supabase) — skipped if Supabase not configured
 *   3. Aggregate by document
 *   4. Reduce (Signature: "context, question -> synthesized_context")
 *      — only if multi-chunk aggregation
 *   5. Answer (Signature: "context, question -> intelligent_answer")
 *      — streams tokens live, up to 30K chars
 *   6. Translate (Signature: "answer, target_language -> translated_answer")
 *      — only when targetLanguage is set
 *      — small answer (≤4000 tokens): single streaming translate call
 *      — large answer (>4000 tokens): chunked at paragraph/sentence
 *        boundaries into ~3K-token chunks, each translated with up to 3
 *        attempts and an adaptive inter-chunk cooldown (ax-translator's
 *        isLargeInput + splitIntoChunks logic, ported server-side)
 *
 * Each LLM call uses the ax-translator controlled-call pattern:
 *   - 28s per-call timeout (proven reliable for GLM-5.1 on Vercel Edge)
 *   - 1 attempt per server call
 *   - stream:true + drain SSE chunks
 *   - Structured log lines emitted as SSE events
 *
 * Edge runtime: required because Vercel Node serverless hangs on
 * GLM-5.1 (confirmed via extensive testing on ax-translator +
 * atomic-graph). Edge uses a different egress that works.
 */
export const maxDuration = 30;
export const runtime = 'edge';
export const dynamic = 'force-dynamic';

interface QueryRequest {
  query: string;
  top_k?: number;
  filters?: {
    doc_type?: string;
    project?: string;
  };
  mode?: 'conversational' | 'precise';
  targetLanguage?: string; // ISO code (e.g. 'es'). When set, run a translate stage after answer.
}

// ─── DSPy-style Signature Prompts (ax-translator pattern) ─────
// Like DSPy Modules — each prompt is a focused Signature with clear
// input/output contracts. The model is told WHEN to be short vs long.

const SYSTEM_PROMPT = `You are an intelligent second-brain assistant with deep reasoning ability. You don't merely retrieve — you REASON through the context to produce the smartest, most useful answer.

STRICT FIDELITY RULES:
1. Use ONLY the provided Context to answer. Do NOT guess or assume details not in Context.
2. If the Context does NOT contain relevant information, say: "I don't have that information in my knowledge base."
3. When discussing specific entities (people, products, companies), use ONLY attributes explicitly stated — never transfer characteristics from one entity to another.
4. Always cite sources inline as [Document: filename] when using information from Context.
5. Never fabricate APIs, function names, or implementation details not in Context.

ADAPTIVE LENGTH (the key skill):
Match your answer length to the question's complexity. Be CONCISE when the question is simple; be COMPREHENSIVE when the question is complex.

- SHORT (2-4 sentences, ~200 chars): factual lookups — "What is X?", "Who owns Y?", "When did Z happen?"
- MEDIUM (1-3 paragraphs, ~800 chars): how/why questions about a single concept
- LONG (multiple sections, ~3000 chars): multi-faceted questions, architecture explanations, comparisons
- VERY LONG (detailed with code/examples, up to 30000 chars): complex technical questions, full implementation guides, deep architectural reasoning, multi-step tutorials

QUALITY RULES:
- Lead with the direct answer, then expand. Don't bury the lede.
- For coding questions: provide concrete code examples, patterns, and architecture when the context supports it.
- For conceptual questions: structure with headers, bullet points, and clear reasoning.
- For multi-part questions: address each part explicitly.
- When the context has gaps, say what you CAN answer and explicitly note what's missing.
- Be the smartest version of yourself — synthesize, infer logical consequences, draw connections the writer implied but didn't state.`;

const REDUCER_PROMPT = `You are a research synthesis engine. Given multiple document chunks about the same topic, REASON through them to produce a coherent, comprehensive synthesis.

Task:
1. Extract key information from each chunk
2. Merge overlapping information intelligently (don't just concatenate)
3. Note any conflicts or differences between sources
4. Infer connections that span multiple chunks
5. Provide a unified, comprehensive synthesis

Format your response as:
- Key Points: (bulleted list of main findings, each 1-2 sentences)
- Details: (comprehensive synthesis combining all sources, with inline citations)
- Conflicts: (any disagreements between sources, or "None" if consistent)
- Sources: (list of which documents contributed)

Be thorough — this synthesis will be used as context for the final answer, so include all relevant details from the chunks.`;

interface SSEEvent {
  type: string;
  stage?: string;
  [k: string]: unknown;
}

function sse(event: SSEEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

// ─── Translation system prompt (fast-mode, ax-translator pattern) ───────────
// Single streaming call. Token budget sized via calculateMaxTokens() so the
// translated answer can match (or modestly exceed) the original length.

function buildTranslateSystemPrompt(targetLabel: string, isRetry: boolean): string {
  if (isRetry) {
    return `You are a professional translator. Your task is to TRANSLATE the given text into ${targetLabel}.

CRITICAL INSTRUCTION: You MUST output the text IN ${targetLabel.toUpperCase()}. Do NOT output the same text in the original language. This is a translation task, not a repetition task. The previous attempt returned the original text unchanged — you must actually translate it this time.

Rules:
- Produce a clean, natural, and understandable translation in ${targetLabel}
- Preserve the original meaning exactly — do not add, remove, or change information
- Use natural phrasing that a native speaker of ${targetLabel} would use
- Output ONLY the translated text in ${targetLabel}, nothing else.`;
  }
  return `You are a professional translator. Translate the given text into ${targetLabel}.

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

/**
 * Translate a single chunk of text via the controlled streaming client.
 * Used by both the single-call path and the chunked path below.
 *
 * Streams tokens via `stage: 'translate'` chunks. Echo detection: if the
 * model returns the source unchanged, retries once with a forceful prompt.
 * Returns the cleaned translation + the elapsed time from the (final)
 * successful call. Throws if the underlying call fails.
 */
async function translateChunk(
  sourceText: string,
  targetLabel: string,
  onLog: (line: string) => void,
  onChunk: (text: string) => void,
): Promise<{ translated: string; elapsedMs: number }> {
  const maxTokens = calculateMaxTokens(sourceText);
  let raw = '';

  const result = await opencodeChatStreamControlled({
    messages: [
      { role: 'system', content: buildTranslateSystemPrompt(targetLabel, false) },
      { role: 'user', content: `Translate the following text into ${targetLabel}. The output must be in ${targetLabel}:\n\n${sourceText}` },
    ],
    temperature: 0.3,
    maxTokens,
    onLog,
    onChunk: (text) => {
      raw += text;
      onChunk(text);
    },
  });

  let cleaned = raw
    .replace(/^```[\w]*\n?/m, '')
    .replace(/\n?```$/m, '')
    .replace(/^["']|["']$/g, '')
    .trim();

  // Echo detection — retry once with forceful prompt
  if (isEcho(sourceText, cleaned)) {
    onLog(`[pipeline] Echo detected in translate stage — retrying with forceful prompt…`);
    raw = '';
    await opencodeChatStreamControlled({
      messages: [
        { role: 'system', content: buildTranslateSystemPrompt(targetLabel, true) },
        { role: 'user', content: `Translate the following text into ${targetLabel}. The output must be in ${targetLabel}:\n\n${sourceText}` },
      ],
      temperature: 0.3,
      maxTokens,
      onLog,
      onChunk: (text) => {
        raw += text;
        onChunk(text);
      },
    });
    cleaned = raw
      .replace(/^```[\w]*\n?/m, '')
      .replace(/\n?```$/m, '')
      .replace(/^["']|["']$/g, '')
      .trim();
  }

  return { translated: cleaned, elapsedMs: result.elapsedMs };
}

export async function POST(request: NextRequest) {
  const body: QueryRequest = await request.json();
  const { query, filters, mode = 'conversational', targetLanguage } = body;

  if (!query || query.trim().length === 0) {
    return new Response(
      JSON.stringify({ error: 'Query is required' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }

  // Validate targetLanguage if provided — must be a known ISO code.
  // We don't strictly enforce against LANGUAGES, but we reject empty /
  // suspiciously long values to avoid prompt injection.
  if (targetLanguage !== undefined) {
    if (typeof targetLanguage !== 'string' || targetLanguage.trim().length === 0) {
      return new Response(
        JSON.stringify({ error: 'targetLanguage must be a non-empty ISO code string' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (targetLanguage.length > 16) {
      return new Response(
        JSON.stringify({ error: 'targetLanguage must be a short ISO code (≤16 chars)' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      );
    }
  }

  const effectiveTopK = mode === 'precise' ? 5 : 12;
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (event: SSEEvent) => {
        try {
          controller.enqueue(encoder.encode(sse({ ...event, ts: Date.now() })));
        } catch {
          // Controller may be closed if client disconnected
        }
      };

      try {
        // ─── STEP 1: SEARCH PINECONE ──────────────────────────
        emit({ type: 'stage-start', stage: 'search' });
        emit({ type: 'log', line: `[pipeline] Searching Pinecone (topK=${effectiveTopK}, mode=${mode})…` });

        let hits;
        try {
          hits = await searchRecords(query, effectiveTopK, 0.50, filters);
        } catch (error: any) {
          emit({ type: 'error', message: `Search failed: ${error.message}` });
          emit({ type: 'pipeline-end', result: { error: error.message } });
          controller.close();
          return;
        }

        emit({
          type: 'stage-end',
          stage: 'search',
          ok: true,
          elapsedMs: 0,
          summary: `${hits?.length || 0} hits`,
        });

        if (!hits || hits.length === 0) {
          const result = {
            answer: 'No relevant documents found. Upload some documents to build your knowledge base.',
            sources: [],
            aggregatedContext: null,
            debug: { hitsFound: 0, documentsAggregated: 0, reducerUsed: false },
          };
          emit({ type: 'pipeline-end', result });
          controller.close();
          return;
        }

        // ─── STEP 2: VALIDATE SOURCES ─────────────────────────
        // Use Supabase REST API directly (not the JS client) because the
        // JS client pulls in node:stream which is unsupported in Edge runtime.
        // If Supabase env vars are not set, skip validation and trust all hits.
        emit({ type: 'stage-start', stage: 'validate-sources' });

        const rawSources = [...new Set(hits.map((h) => h.filename))];
        let sources: string[];
        let validHits: typeof hits;

        const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
        const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

        if (!supabaseUrl || !supabaseServiceKey) {
          emit({ type: 'log', line: `[pipeline] Supabase not configured — skipping source validation (trusting all ${rawSources.length} hits)` });
          sources = rawSources;
          validHits = hits;
        } else {
          emit({ type: 'log', line: `[pipeline] Validating sources against Supabase documents table…` });
          try {
            // Fetch all documents and filter client-side.
            // PostgREST's `in.()` filter breaks on filenames with parens
            // (e.g. "file (1).md"), so we fetch all and filter in JS.
            // The documents table is small (typically <100 rows).
            const restUrl = `${supabaseUrl}/rest/v1/documents?select=filename`;
            const restResponse = await fetch(restUrl, {
              headers: {
                apikey: supabaseServiceKey,
                Authorization: `Bearer ${supabaseServiceKey}`,
              },
            });
            const allDocs = restResponse.ok ? await restResponse.json() : [];
            const validFilenames = new Set((allDocs || []).map((d: any) => d.filename));
            sources = rawSources.filter((f: string) => validFilenames.has(f));
            validHits = hits.filter((h) => validFilenames.has(h.filename));
          } catch (supabaseError: any) {
            emit({ type: 'log', line: `[pipeline] Supabase validation failed: ${supabaseError.message?.slice(0, 100)} — trusting all hits` });
            sources = rawSources;
            validHits = hits;
          }
        }

        emit({
          type: 'stage-end',
          stage: 'validate-sources',
          ok: true,
          elapsedMs: 0,
          summary: `${sources.length}/${rawSources.length} sources valid`,
        });

        if (validHits.length === 0) {
          const result = {
            answer: 'Found documents but none are in the verified index. Try re-uploading.',
            sources: [],
            aggregatedContext: null,
            debug: { hitsFound: 0, documentsAggregated: 0, reducerUsed: false },
          };
          emit({ type: 'pipeline-end', result });
          controller.close();
          return;
        }

        // ─── STEP 3: AGGREGATE BY DOCUMENT ────────────────────
        emit({ type: 'stage-start', stage: 'aggregate' });
        const aggregated = rerankAndAggregate(validHits);
        const context = buildContextFromAggregated(aggregated, 5000);
        emit({
          type: 'stage-end',
          stage: 'aggregate',
          ok: true,
          elapsedMs: 0,
          summary: `${aggregated.length} documents aggregated, ${context.length} chars context`,
        });

        // ─── STEP 4: REDUCE (optional LLM call) ───────────────
        let reducedContext = context;
        const reducerNeeded = aggregated.some((a) => a.chunkCount > 1);

        if (reducerNeeded) {
          emit({ type: 'stage-start', stage: 'reduce' });
          emit({ type: 'log', line: `[pipeline] Multi-chunk aggregation — calling OpenCode to reduce context…` });

          try {
            const reduceResult = await opencodeChatStreamControlled({
              messages: [
                { role: 'system', content: REDUCER_PROMPT },
                { role: 'user', content: `Question: ${query}\n\nContext:\n${context}\n\nPlease synthesize this information.` },
              ],
              temperature: 0.2,
              maxTokens: 1024,
              onLog: (line) => emit({ type: 'log', line }),
              // Don't stream reduce chunks to the user — they're internal
            });
            reducedContext = reduceResult.content;
            emit({
              type: 'stage-end',
              stage: 'reduce',
              ok: true,
              elapsedMs: reduceResult.elapsedMs,
              summary: `${reducedContext.length} chars reduced context`,
            });
          } catch (reduceError: any) {
            emit({
              type: 'stage-end',
              stage: 'reduce',
              ok: false,
              elapsedMs: 0,
              summary: `Reduce failed: ${reduceError.message?.slice(0, 100)} — using raw context`,
            });
            // Continue with raw context — reduce is optional
          }
        } else {
          emit({ type: 'log', line: `[pipeline] Single-chunk answers — skipping reduce step` });
        }

        // ─── STEP 5: FINAL ANSWER (LLM call with live streaming) ──
        // Signature: "context, question -> intelligent_answer"
        // max_tokens=32768 supports up to ~30K char outputs for complex
        // technical questions. The SYSTEM_PROMPT tells the model to be
        // adaptive — short for simple lookups, long for complex reasoning.
        // Each chunk is tagged `stage: 'answer'` so clients routing
        // translate-stage chunks to a separate buffer can distinguish them.
        emit({ type: 'stage-start', stage: 'answer' });
        emit({ type: 'log', line: `[pipeline] Generating final answer (streaming tokens live, up to 30K chars)…` });

        let answer = '';
        let answerElapsedMs = 0;
        let answerErrorMsg = '';
        try {
          const answerResult = await opencodeChatStreamControlled({
            messages: [
              { role: 'system', content: SYSTEM_PROMPT },
              { role: 'user', content: `Context:\n${reducedContext}\n\n---\n\nQuestion: ${query}` },
            ],
            temperature: mode === 'precise' ? 0.1 : 0.3,
            maxTokens: 32768, // supports up to ~30K char outputs
            onLog: (line) => emit({ type: 'log', line }),
            onChunk: (text) => {
              answer += text;
              emit({ type: 'chunk', text, stage: 'answer' });
            },
          });
          answerElapsedMs = answerResult.elapsedMs;

          emit({
            type: 'stage-end',
            stage: 'answer',
            ok: true,
            elapsedMs: answerElapsedMs,
            summary: `${answer.length} chars answer`,
          });
        } catch (answerError: any) {
          answerErrorMsg = answerError?.message ?? String(answerError);
          emit({
            type: 'stage-end',
            stage: 'answer',
            ok: false,
            elapsedMs: 0,
            summary: `Answer failed: ${answerErrorMsg.slice(0, 150)}`,
          });
          emit({ type: 'error', message: answerErrorMsg });
          emit({
            type: 'pipeline-end',
            result: {
              answer: '',
              sources,
              error: answerErrorMsg,
              debug: {
                hitsFound: validHits.length,
                documentsAggregated: aggregated.length,
                reducerUsed: reducerNeeded,
              },
            },
          });
          // Skip translate stage if answer failed
          return;
        }

        // ─── STEP 6 (OPTIONAL): TRANSLATE ANSWER ─────────────────────
        // Signature: "answer, target_language -> translated_answer"
        // Runs only when `targetLanguage` was provided.
        //
        // Two paths (ax-translator's isLargeInput branch, ported server-side):
        //   - Small answer (≤4000 tokens): single streaming translate call
        //     with echo-retry. Fast mode (no validate/refine) to stay
        //     within Vercel Edge's 30s cap.
        //   - Large answer (>4000 tokens): split at paragraph/sentence
        //     boundaries into ~3K-token chunks; translate each chunk
        //     sequentially with up to 3 attempts and an adaptive
        //     inter-chunk cooldown (10s/30s/60s based on prior chunk).
        //
        // All translate-stage chunks are tagged `stage: 'translate'` so
        // the client routes them to a separate "translated answer" buffer.
        let translatedAnswer: string | undefined;
        let translateOk = false;

        if (targetLanguage) {
          const targetLabel = languageLabel(targetLanguage);
          emit({ type: 'stage-start', stage: 'translate' });

          const useChunkedTranslate = isLargeInput(answer);
          if (useChunkedTranslate) {
            emit({
              type: 'log',
              line: `[pipeline] Large answer detected — chunked translation into ${targetLabel} (${targetLanguage})…`,
            });

            // Chunk the answer at paragraph/sentence boundaries.
            const chunks = splitIntoChunks(answer, CHUNK_TARGET_TOKENS);
            emit({
              type: 'log',
              line: `[pipeline] Split answer into ${chunks.length} chunks × ~${CHUNK_TARGET_TOKENS} tokens each.`,
            });
            if (chunks.length >= 3) {
              emit({
                type: 'log',
                line: `[pipeline] ⚠️ ${chunks.length} chunks with inter-chunk cooldowns may exceed Vercel's 30s function cap.`,
              });
            }

            const translatedChunks: string[] = [];
            let succeededChunks = 0;
            let lastChunkError = '';

            for (let i = 0; i < chunks.length; i++) {
              emit({
                type: 'log',
                line: `[pipeline] Translate chunk ${i + 1}/${chunks.length} starting…`,
              });

              let chunkOk = false;
              let chunkTranslated = '';

              for (let chunkAttempt = 1; chunkAttempt <= MAX_CHUNK_ATTEMPTS; chunkAttempt++) {
                if (chunkAttempt > 1) {
                  emit({
                    type: 'log',
                    line: `[pipeline] Translate chunk ${i + 1}/${chunks.length} attempt ${chunkAttempt}/${MAX_CHUNK_ATTEMPTS} — retrying…`,
                  });
                }
                try {
                  const r = await translateChunk(
                    chunks[i],
                    targetLabel,
                    (line) => emit({ type: 'log', line }),
                    (text) => emit({ type: 'chunk', text, stage: 'translate' }),
                  );
                  chunkTranslated = r.translated;
                  if (!chunkTranslated.trim()) {
                    throw new Error('Empty translation result.');
                  }
                  chunkOk = true;
                  lastChunkError = '';
                  break;
                } catch (chunkErr: any) {
                  lastChunkError = chunkErr?.message ?? String(chunkErr);
                  emit({
                    type: 'log',
                    line: `[pipeline] Translate chunk ${i + 1}/${chunks.length} attempt ${chunkAttempt}/${MAX_CHUNK_ATTEMPTS} FAILED: ${lastChunkError.slice(0, 150)}`,
                  });
                  if (chunkAttempt === MAX_CHUNK_ATTEMPTS) {
                    emit({
                      type: 'log',
                      line: `[pipeline] Translate chunk ${i + 1}/${chunks.length} failed ${MAX_CHUNK_ATTEMPTS}× — using placeholder.`,
                    });
                  }
                }
              }

              if (chunkOk && chunkTranslated.trim()) {
                if (chunkTranslated.trim() === chunks[i].trim()) {
                  emit({
                    type: 'log',
                    line: `[pipeline] Translate chunk ${i + 1} returned same text — echo detected`,
                  });
                }
                translatedChunks.push(chunkTranslated);
                succeededChunks++;
              } else {
                translatedChunks.push(`[Chunk ${i + 1} failed: ${lastChunkError.slice(0, 100)}]`);
              }

              // Adaptive inter-chunk cooldown (skip after the last chunk)
              if (i < chunks.length - 1) {
                const attemptsUsed = chunkOk ? 1 : MAX_CHUNK_ATTEMPTS;
                const delaySec = adaptiveCooldownSec(chunkOk, attemptsUsed, lastChunkError);
                emit({
                  type: 'log',
                  line: `[pipeline] Cooldown: waiting ${delaySec}s before translate chunk ${i + 2}/${chunks.length}…`,
                });
                await new Promise((resolve) => setTimeout(resolve, delaySec * 1000));
              }
            }

            translatedAnswer = translatedChunks.join('\n\n');
            translateOk = succeededChunks > 0;
            emit({
              type: 'stage-end',
              stage: 'translate',
              ok: translateOk,
              elapsedMs: 0,
              summary: `${succeededChunks}/${chunks.length} chunks ok, ${translatedAnswer.length} chars total`,
            });
          } else {
            // Small answer — single streaming translate call
            emit({
              type: 'log',
              line: `[pipeline] Translating answer into ${targetLabel} (${targetLanguage}) — fast mode, streaming tokens live…`,
            });

            try {
              const r = await translateChunk(
                answer,
                targetLabel,
                (line) => emit({ type: 'log', line }),
                (text) => emit({ type: 'chunk', text, stage: 'translate' }),
              );
              translatedAnswer = r.translated;
              translateOk = !!translatedAnswer;
              emit({
                type: 'stage-end',
                stage: 'translate',
                ok: translateOk,
                elapsedMs: r.elapsedMs,
                summary: `${translatedAnswer.length} chars translated`,
              });
            } catch (translateError: any) {
              const tErr = translateError?.message ?? String(translateError);
              emit({
                type: 'stage-end',
                stage: 'translate',
                ok: false,
                elapsedMs: 0,
                summary: `Translate failed: ${tErr.slice(0, 150)} — returning untranslated answer`,
              });
              emit({ type: 'log', line: `[pipeline] Translate stage error — returning answer in original language.` });
            }
          }
        }

        const result: Record<string, unknown> = {
          answer: answer || 'No answer generated.',
          sources,
          aggregatedContext: reducedContext !== context ? reducedContext : null,
          debug: {
            hitsFound: validHits.length,
            documentsAggregated: aggregated.length,
            reducerUsed: reducerNeeded,
            translated: translateOk,
            targetLanguage: targetLanguage ?? null,
          },
        };
        if (translatedAnswer !== undefined) {
          result.translatedAnswer = translatedAnswer;
          result.targetLanguage = targetLanguage;
        }
        emit({ type: 'pipeline-end', result });
      } catch (error: any) {
        emit({ type: 'error', message: error.message });
        emit({ type: 'pipeline-end', result: { error: error.message } });
      } finally {
        try {
          controller.close();
        } catch {
          // Already closed
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
