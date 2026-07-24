import { NextRequest, NextResponse } from 'next/server';
import { searchRecords, rerankAndAggregate, buildContextFromAggregated } from '@/lib/pinecone';
import { opencodeChatCompletion } from '@/lib/opencode';
import { supabase, DOCUMENTS_TABLE } from '@/lib/supabase';

export const maxDuration = 180;

interface QueryRequest {
  query: string;
  top_k?: number;
  filters?: {
    doc_type?: string;
    project?: string;
  };
  mode?: 'conversational' | 'precise';
}

const SYSTEM_PROMPT = `You are a helpful coding assistant and second brain. STRICT RULES:
1. Use ONLY the provided Context to answer the Question. Do NOT guess or assume details.
2. If the Context mentions something related to the question, use that information.
3. If the Context does NOT contain relevant information, say "I don't have that information in my knowledge base."
4. CRITICAL: When answering about specific entities (people, products, companies, etc.):
   - ONLY use attributes explicitly stated in the Context
   - Do NOT attribute characteristics from one entity to another
   - If you cannot verify an attribute in Context, do NOT include it
5. Be concise but comprehensive in your answers.
6. Always cite sources using [Document: filename] when using information from Context.
7. For coding questions: suggest code examples, patterns, or architecture when relevant.
8. Never make up APIs, function names, or implementation details not in Context.`;

const REDUCER_PROMPT = `You are a research assistant. Given multiple document chunks about the same topic, synthesize them into a coherent summary.

Task:
1. Extract key information from each chunk
2. Merge overlapping information
3. Note any conflicts or differences
4. Provide a unified, comprehensive response

Format your response as:
- Key Points: (bulleted list of main findings)
- Details: (comprehensive answer combining all sources)
- Conflicts: (any disagreements between sources, or "None" if consistent)
- Sources: (list of which documents contributed)`;

export async function POST(request: NextRequest) {
  try {
    const body: QueryRequest = await request.json();
    const { query, top_k, filters, mode = 'conversational' } = body;

    if (!query || query.trim().length === 0) {
      return NextResponse.json(
        { status: 'Error', error: 'Query is required' },
        { status: 400 }
      );
    }

    const effectiveTopK = mode === 'precise' ? 5 : 12;

    // =================== STEP 1: SEARCH PINECONE ===================
    let hits;
    try {
      hits = await searchRecords(query, effectiveTopK, 0.50, filters);
    } catch (error: any) {
      console.error('Pinecone search error:', error);
      return NextResponse.json(
        { status: 'Error', error: `Search failed: ${error.message}` },
        { status: 500 }
      );
    }

    if (!hits || hits.length === 0) {
      return NextResponse.json({
        answer: 'No relevant documents found. Upload some documents to build your knowledge base.',
        sources: [],
        aggregatedContext: null,
      });
    }

    // =================== STEP 2: VALIDATE SOURCES ===================
    const rawSources = [...new Set(hits.map((h) => h.filename))];

    const { data: validDocuments } = await supabase
      .from(DOCUMENTS_TABLE)
      .select('filename')
      .in('filename', rawSources);

    const validFilenames = new Set((validDocuments || []).map((d: any) => d.filename));
    const sources = rawSources.filter((f: string) => validFilenames.has(f));
    const validHits = hits.filter((h) => validFilenames.has(h.filename));

    if (validHits.length === 0) {
      return NextResponse.json({
        answer: 'Found documents but none are in the verified index. Try re-uploading.',
        sources: [],
        aggregatedContext: null,
      });
    }

    // =================== STEP 3: AGGREGATE BY DOCUMENT ===================
    const aggregated = rerankAndAggregate(validHits);


    // =================== STEP 4: BUILD CONTEXT ===================
    const context = buildContextFromAggregated(aggregated, 5000);

    // =================== STEP 5: REDUCE/SUMMARIZE (for multi-chunk answers) ===================
    let reducedContext = context;

    if (aggregated.some(a => a.chunkCount > 1)) {
      try {
        const reduceMessages = [
          { role: 'system' as const, content: REDUCER_PROMPT },
          { role: 'user' as const, content: `Question: ${query}\n\nContext:\n${context}\n\nPlease synthesize this information.` }
        ];

        const reduced = await opencodeChatCompletion({
          messages: reduceMessages,
          temperature: 0.2,
          maxTokens: 1024,
        });

        reducedContext = reduced.choices[0]?.message?.content || context;
      } catch (error: any) {
        console.warn('Reducer failed, using raw context:', error.message);
      }
    }

    // =================== STEP 6: FINAL ANSWER ===================
    const messages = [
      { role: 'system' as const, content: SYSTEM_PROMPT },
      {
        role: 'user' as const,
        content: `Context:\n${reducedContext}\n\n---\n\nQuestion: ${query}`,
      },
    ];

    try {
      const completion = await opencodeChatCompletion({
        messages,
        temperature: mode === 'precise' ? 0.1 : 0.3,
        maxTokens: 2048,
      });

      const answer = completion.choices[0]?.message?.content || 'No answer generated.';

      return NextResponse.json({
        answer,
        sources,
        aggregatedContext: reducedContext !== context ? reducedContext : null,
        debug: {
          hitsFound: validHits.length,
          documentsAggregated: aggregated.length,
          reducerUsed: aggregated.some(a => a.chunkCount > 1),
        }
      });
    } catch (error: any) {
      console.error('LLM error after retries:', error);
      const errMsg = error?.status === 429
        ? 'LLM rate limit exceeded — please try again'
        : error?.status >= 500
          ? 'LLM server error — please try again later'
          : `LLM error: ${error.message}`;
      return NextResponse.json(
        { status: 'Error', error: errMsg },
        { status: 502 }
      );
    }
  } catch (error: any) {
    console.error('Query error:', error);
    return NextResponse.json(
      { status: 'Error', error: error.message || 'Internal server error' },
      { status: 500 }
    );
  }
}