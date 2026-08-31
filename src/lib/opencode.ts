import OpenAI from 'openai';

/**
 * Lazy OpenAI client. We avoid constructing the client at module load time
 * because the OpenAI SDK strictly requires a non-empty `apiKey` — and at
 * Next.js build time, `process.env.OPENCODE_API_KEY` is undefined, which
 * would fail "Collecting page data" with "Missing credentials".
 *
 * The client is created on first use, at which point the env var is set
 * (in production on Vercel, or in `.env.local` for local dev).
 */
let _opencode: OpenAI | null = null;
function getOpencodeClient(): OpenAI {
  if (!_opencode) {
    const apiKey = process.env.OPENCODE_API_KEY;
    if (!apiKey) {
      throw new Error('OPENCODE_API_KEY env var is not set');
    }
    _opencode = new OpenAI({
      baseURL: 'https://opencode.ai/zen/go/v1',
      apiKey,
      timeout: 60_000, // 60s per-request timeout (legacy non-streaming path)
    });
  }
  return _opencode;
}

export const opencodeClient = new Proxy({} as OpenAI, {
  get(_target, prop) {
    return (getOpencodeClient() as any)[prop];
  },
});

export type ChatCompletion = OpenAI.Chat.ChatCompletion;

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 15_000; // 15 seconds between retries (legacy)

// ─── Streaming constants (ax-translator pattern) ─────────────
// 120s per-call timeout — proven reliable for GLM-5.1 on Vercel Edge.
// 1 attempt per server call — pipeline-level retry handles additional attempts.
export const STREAM_CALL_TIMEOUT_MS = 120_000;
export const STREAM_MAX_ATTEMPTS = 1;

/**
 * CRITICAL: GLM 5.3 (currently served behind the glm-5.1 alias on the
 * opencode.ai/zen/go gateway) is a thinking-only model. Disabling thinking
 * via `reasoning_effort: "none"` or `thinking: { type: "disabled" }`
 * triggers upstream errors. We use `reasoning_effort: "low"` to keep
 * reasoning overhead minimal while still producing the final answer in
 * `content`.
 *
 * NOTE: Do NOT combine `reasoning_effort` with `thinking.type="disabled"` —
 * the upstream rejects: "thinking.type='disabled' conflicts with a
 * non-'none' reasoning_effort".
 */
const LOW_REASONING = {
  reasoning_effort: 'low' as const,
};

/**
 * Determines if an error is retryable (timeout, rate limit, or server error).
 */
function isRetryableError(error: any): boolean {
  const status = error?.status || error?.statusCode || 0;
  if ([429, 500, 502, 503, 504].includes(status)) return true;
  if (error?.code === 'ECONNRESET' || error?.code === 'ETIMEDOUT' || error?.code === 'UND_ERR_CONNECT_TIMEOUT') return true;
  const errName: string = error?.constructor?.name || '';
  if (['APIConnectionError', 'APITimeoutError', 'ConnectionError'].includes(errName)) return true;
  const msg: string = (error?.message || '').toLowerCase();
  if (msg.includes('timeout') || msg.includes('rate limit') || msg.includes('too many requests') || msg.includes('econnreset')) return true;
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * OpenCode (GLM-5.1) chat completion with automatic retry on timeout / rate-limit errors.
 * Legacy non-streaming path — kept for backward compatibility.
 */
export async function opencodeChatCompletion({
  model = 'glm-5.1',
  messages,
  temperature = 0.7,
  maxTokens = 2048,
  maxRetries = MAX_RETRIES,
  retryDelay = RETRY_DELAY_MS,
}: {
  model?: string;
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[];
  temperature?: number;
  maxTokens?: number;
  maxRetries?: number;
  retryDelay?: number;
}): Promise<ChatCompletion> {
  let lastError: any;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await getOpencodeClient().chat.completions.create({
        model,
        messages,
        temperature,
        max_tokens: maxTokens,
        stream: false,
        ...LOW_REASONING,
      } as any);
    } catch (error: any) {
      lastError = error;
      if (attempt === maxRetries || !isRetryableError(error)) {
        throw error;
      }
      console.warn(
        `[OpenCode Retry] Attempt ${attempt + 1}/${maxRetries} failed ` +
        `(status: ${error?.status || 'N/A'}, message: ${error?.message || 'unknown'}). ` +
        `Retrying in ${retryDelay / 1000}s...`
      );
      await sleep(retryDelay);
    }
  }
  throw lastError;
}

/**
 * OpenCode (GLM-5.1) streaming chat completion with automatic retry.
 * Legacy streaming path — yields OpenAI SDK chunks.
 */
export async function* opencodeChatStream({
  model = 'glm-5.1',
  messages,
  temperature = 0.7,
  maxTokens = 2048,
  maxRetries = MAX_RETRIES,
  retryDelay = RETRY_DELAY_MS,
}: {
  model?: string;
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[];
  temperature?: number;
  maxTokens?: number;
  maxRetries?: number;
  retryDelay?: number;
}): AsyncGenerator<OpenAI.Chat.Completions.ChatCompletionChunk> {
  let lastError: any;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      // `extra_body` (for thinking-disable) is not a standard OpenAI param, so
      // the SDK's return-type inference widens to non-streaming. Force the
      // streaming shape explicitly.
      const stream = (await getOpencodeClient().chat.completions.create({
        model,
        messages,
        temperature,
        max_tokens: maxTokens,
        stream: true,
        ...LOW_REASONING,
      } as any)) as unknown as AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>;
      for await (const chunk of stream) {
        yield chunk;
      }
      return;
    } catch (error: any) {
      lastError = error;
      if (attempt === maxRetries || !isRetryableError(error)) {
        throw error;
      }
      console.warn(
        `[OpenCode Stream Retry] Attempt ${attempt + 1}/${maxRetries} failed ` +
        `(status: ${error?.status || 'N/A'}, message: ${error?.message || 'unknown'}). ` +
        `Retrying in ${retryDelay / 1000}s...`
      );
      await sleep(retryDelay);
    }
  }
  throw lastError;
}

// ─── Controlled streaming call (ax-translator pattern) ───────
// Used by /api/query-stream. Bounded timeout, structured logging,
// live token streaming via onChunk callback.

export interface ControlledStreamOptions {
  model?: string;
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[];
  temperature?: number;
  maxTokens?: number;
  /** Per-call timeout in ms. Default 120000. */
  timeoutMs?: number;
  /** Max attempts (including the first). Default 1. */
  maxRetries?: number;
  /** Callback fired for every log line. */
  onLog?: (line: string) => void;
  /** Callback fired for every content chunk as it arrives. */
  onChunk?: (text: string) => void;
}

export interface ControlledStreamResult {
  content: string;
  reasoning: string;
  model: string;
  elapsedMs: number;
  attempts: number;
}

/**
 * Controlled, logged, time-bounded streaming chat completion via OpenCode.
 * Uses raw fetch + SSE parsing (not OpenAI SDK) for maximum control.
 *
 * - 28s per-call timeout (proven reliable for GLM-5.1 on Vercel Edge)
 * - 1 attempt per call (pipeline-level retry handles additional attempts)
 * - Streams chunks via onChunk callback
 * - Emits structured log lines via onLog callback
 * - Returns full content + reasoning + timing metadata
 *
 * CRITICAL: Sends `reasoning_effort: "low"` to keep GLM 5.3's reasoning
 * overhead minimal while still ensuring the final answer lands in
 * `content`. Do NOT pair with `thinking: { type: "disabled" }` — the
 * upstream rejects the combination.
 */
export async function opencodeChatStreamControlled(
  opts: ControlledStreamOptions,
): Promise<ControlledStreamResult> {
  const model = opts.model || 'glm-5.1';
  const timeoutMs = opts.timeoutMs ?? STREAM_CALL_TIMEOUT_MS;
  const maxRetries = opts.maxRetries ?? STREAM_MAX_ATTEMPTS;
  const callStart = Date.now();
  const apiKey = process.env.OPENCODE_API_KEY;

  if (!apiKey) {
    throw new Error('OPENCODE_API_KEY env var is not set');
  }

  opts.onLog?.(`[opencode] start  model=${model} max_tokens=${opts.maxTokens ?? 2048} temp=${opts.temperature ?? 0.7} timeout=${timeoutMs}ms`);

  let lastErr: Error | null = null;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch('https://opencode.ai/zen/go/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          Accept: 'text/event-stream',
        },
        body: JSON.stringify({
          model,
          messages: opts.messages,
          max_tokens: opts.maxTokens ?? 2048,
          temperature: opts.temperature ?? 0.7,
          stream: true,
          reasoning_effort: 'low',
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`OpenCode API error (${response.status}): ${errText.slice(0, 300)}`);
      }
      if (!response.body) {
        throw new Error('OpenCode API returned no response body');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let content = '';
      let reasoning = '';
      let ttfbMs: number | null = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (ttfbMs === null) ttfbMs = Date.now() - callStart;

        buffer += decoder.decode(value, { stream: true });
        let nlIdx;
        while ((nlIdx = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, nlIdx).trim();
          buffer = buffer.slice(nlIdx + 1);
          if (!line || !line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') {
            const elapsed = Date.now() - callStart;
            opts.onLog?.(`[opencode] ttfb=${ttfbMs ?? 'n/a'}ms  done attempt=${attempt} elapsed=${elapsed}ms content_chars=${content.length} reasoning_chars=${reasoning.length}`);
            if (!content && reasoning) {
              content = reasoning;
              opts.onChunk?.(content);
            }
            if (!content) {
              throw new Error(`empty content (reasoning_chars=${reasoning.length})`);
            }
            return { content, reasoning, model, elapsedMs: elapsed, attempts: attempt };
          }
          try {
            const json = JSON.parse(data);
            const delta = json.choices?.[0]?.delta;
            if (delta) {
              if (typeof delta.content === 'string' && delta.content) {
                content += delta.content;
                opts.onChunk?.(delta.content);
              }
              if (typeof delta.reasoning_content === 'string') {
                reasoning += delta.reasoning_content;
              }
            }
          } catch {
            // Partial JSON across chunks
          }
        }
      }

      // Stream ended without [DONE] — still return what we have
      const elapsed = Date.now() - callStart;
      if (!content && reasoning) {
        content = reasoning;
        opts.onChunk?.(content);
      }
      if (!content) {
        throw new Error(`empty content (stream ended without [DONE], reasoning_chars=${reasoning.length})`);
      }
      opts.onLog?.(`[opencode] ttfb=${ttfbMs ?? 'n/a'}ms  done attempt=${attempt} elapsed=${elapsed}ms content_chars=${content.length} reasoning_chars=${reasoning.length}`);
      return { content, reasoning, model, elapsedMs: elapsed, attempts: attempt };
    } catch (err: unknown) {
      clearTimeout(timeout);
      const e = err as Error;
      const elapsed = Date.now() - callStart;
      lastErr = e;
      if (e.name === 'AbortError') {
        opts.onLog?.(`[opencode] TIMEOUT attempt=${attempt} after ${timeoutMs}ms`);
      } else {
        opts.onLog?.(`[opencode] ERROR attempt=${attempt} after ${elapsed}ms: ${e.name}: ${e.message.slice(0, 200)}`);
      }
      if (attempt < maxRetries) {
        const backoff = 500 * attempt;
        opts.onLog?.(`[opencode] retry  backing off ${backoff}ms before attempt ${attempt + 1}`);
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
  }
  const elapsed = Date.now() - callStart;
  const finalErr = lastErr ?? new Error('unknown error');
  throw new Error(`OpenCode call failed after ${maxRetries} attempts (${elapsed}ms): ${finalErr.name}: ${finalErr.message}`);
}

export default opencodeClient;
