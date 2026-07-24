import { NextRequest } from 'next/server';
import {
  runTranslationStream,
  runTranslationStreamFast,
  runTranslationStreamAuto,
  runTranslationStreamChunked,
  type TranslationEvent as TranslationPipelineEvent,
  type TranslationRequest,
} from '@/lib/translation-pipeline';

/**
 * Streaming translation endpoint (Server-Sent Events) — DSPy-style.
 *
 * POST /api/translate-stream
 *   {
 *     text: string,
 *     sourceLanguage?: string,   // default 'auto'
 *     targetLanguage: string,    // e.g. 'es', 'hi'
 *     fast?: boolean,            // default true → single streaming translate call
 *                                // false → full translate→validate→refine pipeline
 *     chunked?: 'auto' | 'never' | 'always'
 *                                // default 'auto' → chunked for large inputs (>4K tokens)
 *                                // 'never'  → always single-call
 *                                // 'always' → force chunked even for small inputs
 *   }
 *
 * Response: text/event-stream
 *   data: {"type":"stage-start","stage":"translate","ts":...}
 *   data: {"type":"log","line":"[opencode] start  model=...","ts":...}
 *   data: {"type":"chunk","text":"न","ts":...}
 *   data: {"type":"stage-end","stage":"translate","elapsedMs":...,"ok":true,...}
 *   data: {"type":"pipeline-end","result":{...},"ts":...}
 *
 * For large inputs (>4000 tokens, ax-translator's isLargeInput threshold),
 * the stream automatically splits the text into ~3K-token chunks at
 * paragraph/sentence boundaries and translates each one sequentially
 * with up to 3 attempts and an adaptive inter-chunk cooldown
 * (10s/30s/60s based on prior chunk outcome). Each chunk emits its own
 * `chunk-{i+1}-{total}` stage-start/stage-end events.
 *
 * Edge runtime: required for GLM-5.1 on Vercel (same reason as
 * /api/query-stream — Node serverless hangs on the model's egress).
 *
 * This endpoint is a faithful port of ax-translator's
 * /api/translate-stream/route.ts, adapted to use the shared
 * `opencodeChatStreamControlled` client from src/lib/opencode.ts and to
 * host the large-input chunking logic server-side (ax-translator did
 * it client-side in page.tsx).
 */
export const maxDuration = 30; // Edge runtime limit on Vercel
export const dynamic = 'force-dynamic';
export const runtime = 'edge';

function sse(event: TranslationPipelineEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { text, sourceLanguage = 'auto', targetLanguage, fast = true, chunked } = body as {
    text?: string;
    sourceLanguage?: string;
    targetLanguage?: string;
    fast?: boolean;
    chunked?: 'auto' | 'never' | 'always';
  };

  if (!text || typeof text !== 'string' || text.trim().length === 0) {
    return new Response(
      JSON.stringify({ error: 'Missing required field: text (non-empty string)' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }
  if (!targetLanguage || typeof targetLanguage !== 'string') {
    return new Response(
      JSON.stringify({ error: 'Missing required field: targetLanguage' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }

  const apiKey = process.env.OPENCODE_API_KEY;
  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: 'Server missing OPENCODE_API_KEY env var.' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }

  const input: TranslationRequest = {
    text,
    sourceLanguage,
    targetLanguage,
  };

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (event: TranslationPipelineEvent) => {
        try {
          controller.enqueue(encoder.encode(sse(event)));
        } catch {
          // Controller may be closed if client disconnected
        }
      };

      try {
        // Route selection (matches ax-translator's isLargeInput branch):
        //   - chunked: 'auto' (default)  → auto-route based on token count
        //   - chunked: 'never'           → force single-call (fast or full)
        //   - chunked: 'always'          → force chunked path
        //
        // When fast=false (full pipeline) we always run the full pipeline
        // (chunking only applies to fast mode, since validate/refine don't
        // make sense per-chunk across a single answer).
        const chunkedMode = chunked ?? 'auto';
        const useChunked =
          chunkedMode === 'always'
            ? true
            : chunkedMode === 'never'
              ? false
              : fast; // 'auto' → chunk only in fast mode

        if (fast) {
          if (useChunked) {
            // Auto-route: chunked for large inputs, single-call otherwise.
            // 'always' forces the chunked path even for small inputs
            // (useful for testing the chunking codepath).
            if (chunkedMode === 'always') {
              await runTranslationStreamChunked(input, emit);
            } else {
              await runTranslationStreamAuto(input, emit);
            }
          } else {
            await runTranslationStreamFast(input, emit);
          }
        } else {
          // Full pipeline — always single call (validate/refine are not
          // chunk-aware). The full pipeline has its own internal state
          // machine and retry, so chunking isn't beneficial here.
          await runTranslationStream(input, emit);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        emit({ type: 'error', message: msg, ts: Date.now() });
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
      'X-Accel-Buffering': 'no', // disable proxy buffering
    },
  });
}
