import { Pinecone } from '@pinecone-database/pinecone';
import { v4 as uuidv4 } from 'uuid';

const pinecone = new Pinecone({
  apiKey: process.env.PINECONE_API_KEY!,
});

export const pineconeIndex = pinecone.Index('rag-documents');
export const PINECONE_INDEX_NAME = 'rag-documents';
export const EMBEDDING_MODEL = 'multilingual-e5-large';
export const EMBEDDING_DIMENSION = 1024;

/**
 * Chunk text into overlapping pieces for embedding.
 */
function chunkText(text: string, chunkSize: number = 500, overlap: number = 50): string[] {
  if (!text || text.length === 0) return [];

  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    const end = start + chunkSize;
    const chunk = text.slice(start, end).trim();
    if (chunk.length > 0) {
      chunks.push(chunk);
    }
    start = end - overlap;
  }

  return chunks;
}

export interface ChunkMetadata {
  filename: string;
  doc_type?: string;
  project?: string;
  version?: string;
  uploaded_at?: number;
}

/**
 * Upsert document chunks into Pinecone using multilingual-e5-large.
 */
export async function upsertRecords(
  text: string,
  filename: string,
  metadata?: ChunkMetadata
): Promise<{ status: string; filename: string; chunks: number }> {
  if (!text || !filename) {
    throw new Error('text and filename are required');
  }

  const chunkSize = 500;
  const chunks = chunkText(text, chunkSize);

  if (chunks.length === 0) {
    return { status: 'error', filename, chunks: 0 };
  }

  try {
    await pineconeIndex.deleteMany({
      filter: { filename: { $eq: filename } },
    });
  } catch (error: any) {
    if (error.status !== 404 && error.statusCode !== 404 && !error.message?.includes('404')) {
      throw error;
    }
  }

  const embeddingsResponse = await pinecone.inference.embed({
    model: EMBEDDING_MODEL,
    inputs: chunks,
    parameters: {
      input_type: 'passage',
      truncate: 'END',
    },
  });

  const vectors = embeddingsResponse.data.map((emb: any, i: number) => ({
    id: `${filename}_${i}_${uuidv4().slice(0, 8)}`,
    values: emb.values as number[],
    metadata: {
      filename,
      text: chunks[i],
      chunk_index: i,
      total_chunks: chunks.length,
      doc_type: metadata?.doc_type || 'unknown',
      project: metadata?.project || 'default',
      version: metadata?.version || '1.0',
      uploaded_at: metadata?.uploaded_at || Date.now(),
    },
  }));

  if (vectors.length > 0) {
    await pineconeIndex.upsert({ records: vectors });
  }


  return {
    status: 'success',
    filename,
    chunks: chunks.length,
  };
}

/**
 * Delete all records for a given filename from Pinecone.
 */
export async function deleteRecords(filename: string): Promise<void> {
  try {
    await pineconeIndex.deleteMany({
      filter: { filename: { $eq: filename } },
    });
  } catch (error: any) {
    if (error.status === 404 || error.statusCode === 404 || error.message?.includes('404')) {
      return;
    }
    throw error;
  }
}

const QUERY_EXPANSION_MAP: Record<string, string[]> = {
  'owner': ['responsible', 'lead', 'manager', 'accountable', 'main'],
  'owners': ['responsible', 'lead', 'manager', 'accountable', 'main'],
  'lead': ['leader', 'manager', 'head', 'owner', 'responsible'],
  'leads': ['leader', 'manager', 'head', 'owner', 'responsible'],
  'manager': ['lead', 'leader', 'head', 'owner', 'responsible'],
  'team': ['group', 'department', 'squad', 'unit', 'members'],
  'project': ['initiative', 'system', 'application', 'service', 'platform'],
  'architecture': ['design', 'structure', 'system design', 'technical design'],
  'database': ['db', 'storage', 'postgres', 'postgresql', 'data'],
  'api': ['endpoint', 'rest', 'service', 'interface', 'route'],
  'deploy': ['deployment', 'release', 'publish', 'host', 'server'],
  'config': ['configuration', 'settings', 'env', 'environment'],
  'error': ['bug', 'issue', 'problem', 'failure', 'exception'],
  'test': ['testing', 'qa', 'unit test', 'integration test'],
};

function expandQuery(query: string): string[] {
  const words = query.toLowerCase().split(/\s+/);
  const expanded = [query];

  for (const word of words) {
    const synonyms = QUERY_EXPANSION_MAP[word];
    if (synonyms) {
      for (const synonym of synonyms) {
        const expandedQuery = query.toLowerCase().replace(word, synonym);
        if (expandedQuery.toLowerCase() !== query.toLowerCase()) {
          expanded.push(expandedQuery);
        }
      }
    }
  }

  return expanded;
}

export interface SearchHit {
  text: string;
  filename: string;
  score: number;
  chunk_index?: number;
  total_chunks?: number;
}

export interface AggregatedHit {
  filename: string;
  chunks: { text: string; score: number }[];
  totalScore: number;
  avgScore: number;
  chunkCount: number;
}

function rerankAndAggregate(hits: SearchHit[]): AggregatedHit[] {
  const byFile = new Map<string, AggregatedHit>();

  for (const hit of hits) {
    if (!byFile.has(hit.filename)) {
      byFile.set(hit.filename, {
        filename: hit.filename,
        chunks: [],
        totalScore: 0,
        avgScore: 0,
        chunkCount: 0,
      });
    }

    const agg = byFile.get(hit.filename)!;
    agg.chunks.push({ text: hit.text, score: hit.score });
    agg.totalScore += hit.score;
    agg.chunkCount++;
  }

  for (const agg of byFile.values()) {
    agg.avgScore = agg.totalScore / agg.chunkCount;
  }

  const aggregated = Array.from(byFile.values());

  return aggregated.sort((a, b) => {
    const scoreA = a.avgScore * Math.log(a.chunkCount + 1);
    const scoreB = b.avgScore * Math.log(b.chunkCount + 1);
    return scoreB - scoreA;
  });
}

function buildContextFromAggregated(aggregated: AggregatedHit[], maxChars: number = 4000): string {
  let context = '';
  let remaining = maxChars;

  for (const hit of aggregated) {
    const sortedChunks = hit.chunks.sort((a, b) => b.score - a.score);
    const combined = sortedChunks.map(c => c.text).join('\n\n');

    if (combined.length <= remaining) {
      context += `[Document: ${hit.filename}]\n${combined}\n\n---\n\n`;
      remaining -= combined.length;
    } else {
      let acc = '';
      for (const chunk of sortedChunks) {
        if (acc.length + chunk.text.length + 50 <= remaining) {
          acc += chunk.text + '\n\n';
        } else {
          break;
        }
      }
      if (acc.length > 0) {
        context += `[Document: ${hit.filename}]\n${acc}\n\n---\n\n`;
      }
    }
  }

  return context.trim();
}

const PERSON_QUERY_KEYWORDS = [
  'who', 'person', 'rep', 'sales rep', 'account', 'manager', 'lead',
  'founder', 'director', 'ceo', 'cto', 'vp', 'head of',
];

function isPersonQuery(query: string): boolean {
  const lower = query.toLowerCase();
  return PERSON_QUERY_KEYWORDS.some(kw => lower.includes(kw));
}

function roundRobinDiversify(hits: SearchHit[]): SearchHit[] {
  const byFile = new Map<string, SearchHit[]>();
  for (const hit of hits) {
    if (!byFile.has(hit.filename)) byFile.set(hit.filename, []);
    byFile.get(hit.filename)!.push(hit);
  }

  const diverse: SearchHit[] = [];
  let round = 0;
  while (diverse.length < hits.length && round < 10) {
    for (const [, fileHits] of byFile) {
      const chunk = fileHits[round];
      if (chunk) diverse.push(chunk);
    }
    round++;
  }
  return diverse;
}

/**
 * Search Pinecone for relevant chunks using multilingual-e5-large.
 * Supports query expansion, aggregated results by filename,
 * and intelligent diversity sampling for person/entity queries.
 */
export async function searchRecords(
  query: string,
  topK: number = 8,
  minScore: number = 0.70,
  filter?: { doc_type?: string; project?: string },
  forceAggregation?: boolean
): Promise<SearchHit[]> {
  const aggregationKeywords = ['all', 'every', 'list', 'how many', 'compare', 'show me', 'find all', 'get all', 'total', 'count'];
  const isAggregation = forceAggregation || aggregationKeywords.some(kw => query.toLowerCase().includes(kw));
  const isPersonSearch = isPersonQuery(query);

  const effectiveTopK = isAggregation ? 50 : (isPersonSearch ? 50 : topK);
  const effectiveMinScore = isAggregation ? 0.50 : minScore;

  const expandedQueries = expandQuery(query);
  const allHits: SearchHit[] = [];

  for (const expandedQuery of expandedQueries) {
    const queryEmbedding = await pinecone.inference.embed({
      model: EMBEDDING_MODEL,
      inputs: [expandedQuery],
      parameters: {
        input_type: 'query',
        truncate: 'END',
      },
    });

    const queryVector = (queryEmbedding.data as any[])[0].values as number[];

    const queryOptions: any = {
      vector: queryVector,
      topK: effectiveTopK,
      includeMetadata: true,
    };

    if (filter && (filter.doc_type || filter.project)) {
      const metadataFilter: any = {};
      if (filter.doc_type) metadataFilter.doc_type = { $eq: filter.doc_type };
      if (filter.project) metadataFilter.project = { $eq: filter.project };
      queryOptions.filter = metadataFilter;
    }

    const searchResponse = await pineconeIndex.query(queryOptions);

    const hits: SearchHit[] = (searchResponse.matches || [])
      .filter((match: any) => match.score >= effectiveMinScore)
      .map((match: any) => ({
        text: match.metadata?.text || '',
        filename: match.metadata?.filename || '',
        score: match.score || 0,
        chunk_index: match.metadata?.chunk_index,
        total_chunks: match.metadata?.total_chunks,
      }));

    allHits.push(...hits);
  }

  const deduped = new Map<string, SearchHit>();
  for (const hit of allHits) {
    const key = `${hit.filename}_${hit.text.substring(0, 100)}`;
    if (!deduped.has(key) || deduped.get(key)!.score < hit.score) {
      deduped.set(key, hit);
    }
  }

  const sorted = Array.from(deduped.values()).sort((a, b) => b.score - a.score);

  if (isPersonSearch) {
    return roundRobinDiversify(sorted);
  }

  return sorted;
}

export { rerankAndAggregate, buildContextFromAggregated, expandQuery };

export default pinecone;