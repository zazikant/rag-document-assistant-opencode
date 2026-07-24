/**
 * Intelligent record-aware text chunking.
 * - JSON: one complete {} object = one chunk
 * - Plain text: split on record delimiters like "Transaction ID:", "Candidate:"
 * - Never split a named record across chunks
 * - Chunk size: 200-400 tokens (using ~4 chars per token)
 * - 15% overlap between chunks
 */

interface ChunkResult {
  chunks: string[];
  recordsFound: number;
}

// Record delimiter patterns for plain text
const RECORD_DELIMITERS = [
  /Transaction\s+ID:/i,
  /Candidate:/i,
  /Employee\s+ID:/i,
  /Invoice\s+Number:/i,
  /Order\s+ID:/i,
  /Customer\s+ID:/i,
  /Account\s+Number:/i,
  /Record\s+ID:/i,
  /Document\s+ID:/i,
  /User\s+ID:/i,
  /ID:\s*\d+/i,
  /^\s*\d+\.\s+/m,           // numbered lists like "1. "
  /^={3,}/m,                  // markdown headers like "==="
  /^-{3,}/m,                  // markdown dividers like "---"
];

const TOKEN_TO_CHARS = 4;
const TARGET_TOKENS_MIN = 200;
const TARGET_TOKENS_MAX = 400;
const CHUNK_SIZE_MIN = TARGET_TOKENS_MIN * TOKEN_TO_CHARS;  // 800 chars
const CHUNK_SIZE_MAX = TARGET_TOKENS_MAX * TOKEN_TO_CHARS;  // 1600 chars
const OVERLAP_PERCENT = 0.15;

function isJsonRecord(text: string): boolean {
  const trimmed = text.trim();
  return (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
         (trimmed.startsWith('[') && trimmed.endsWith(']'));
}

function findJsonRecords(text: string): string[] {
  const records: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escape = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (escape) {
      escape = false;
      continue;
    }

    if (char === '\\') {
      escape = true;
      continue;
    }

    if (char === '"' && !escape) {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (char === '{' || char === '[') {
      if (depth === 0) start = i;
      depth++;
    } else if (char === '}' || char === ']') {
      depth--;
      if (depth === 0 && start !== -1) {
        records.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }

  return records;
}

function findRecordBoundaries(text: string): number[] {
  const boundaries: number[] = [0];

  for (const pattern of RECORD_DELIMITERS) {
    const matches = text.matchAll(new RegExp(pattern.source, pattern.flags + 'g'));
    for (const match of matches) {
      if (match.index !== undefined) {
        boundaries.push(match.index);
      }
    }
  }

  return [...new Set(boundaries)].sort((a, b) => a - b);
}

function smartChunkText(text: string): ChunkResult {
  if (!text || text.length === 0) return { chunks: [], recordsFound: 0 };

  const jsonRecords = findJsonRecords(text);
  if (jsonRecords.length > 1) {
    return { chunks: jsonRecords, recordsFound: jsonRecords.length };
  }

  const boundaries = findRecordBoundaries(text);

  if (boundaries.length <= 2) {
    return fixedSizeChunking(text);
  }

  return recordBasedChunking(text, boundaries);
}

function recordBasedChunking(text: string, boundaries: number[]): ChunkResult {
  const chunks: string[] = [];
  const overlapSize = Math.floor(CHUNK_SIZE_MAX * OVERLAP_PERCENT);

  for (let i = 0; i < boundaries.length; i++) {
    const start = boundaries[i];
    const end = i + 1 < boundaries.length ? boundaries[i + 1] : text.length;
    let record = text.slice(start, end).trim();

    if (record.length < CHUNK_SIZE_MIN) {
      let merged = record;
      let nextIdx = i + 1;
      while (merged.length < CHUNK_SIZE_MIN && nextIdx < boundaries.length) {
        const nextEnd = nextIdx + 1 < boundaries.length ? boundaries[nextIdx + 1] : text.length;
        const nextRecord = text.slice(boundaries[nextIdx], nextEnd).trim();
        if (merged.length + nextRecord.length + 2 <= CHUNK_SIZE_MAX) {
          merged = merged + '\n' + nextRecord;
          nextIdx++;
        } else {
          break;
        }
      }
      record = merged;
      i = nextIdx - 1;
    } else if (record.length > CHUNK_SIZE_MAX) {
      const subChunks = fixedSizeChunking(record);
      chunks.push(...subChunks.chunks);
      continue;
    }

    if (record.length > 0) {
      chunks.push(record);
    }

    if (i + 1 < boundaries.length && chunks.length > 0) {
      const lastChunk = chunks[chunks.length - 1];
      const nextStart = boundaries[i + 1];
      if (nextStart - end < CHUNK_SIZE_MIN) {
        const nextEnd = i + 2 < boundaries.length ? boundaries[i + 2] : text.length;
        const overlapText = text.slice(end - overlapSize, nextEnd).trim();
        if (overlapText.length > 0 && overlapText !== lastChunk.slice(-overlapSize)) {
          chunks[chunks.length - 1] = lastChunk + '\n' + overlapText;
        }
      }
    }
  }

  return { chunks, recordsFound: boundaries.length - 1 };
}

function fixedSizeChunking(text: string): ChunkResult {
  const chunks: string[] = [];
  const overlapSize = Math.floor(CHUNK_SIZE_MAX * OVERLAP_PERCENT);
  let start = 0;

  while (start < text.length) {
    let end = start + CHUNK_SIZE_MAX;

    if (end < text.length) {
      const searchStart = Math.max(start + CHUNK_SIZE_MAX - 100, start);
      const searchRegion = text.slice(searchStart, end + 50);

      let breakPos = -1;

      for (const delimiter of ['}\n', ']\n', '.\n', ';\n', '\n\n']) {
        const pos = searchRegion.lastIndexOf(delimiter);
        if (pos > 0) {
          breakPos = searchStart + pos + delimiter.length;
          break;
        }
      }

      if (breakPos === -1) {
        const sentenceEnd = searchRegion.lastIndexOf('. ');
        const newlineEnd = searchRegion.lastIndexOf('\n');
        const bestBreak = Math.max(sentenceEnd, newlineEnd);

        if (bestBreak > 0) {
          end = searchStart + bestBreak + 1;
        } else {
          const wordBreak = text.lastIndexOf(' ', end);
          if (wordBreak > start) {
            end = wordBreak;
          }
        }
      } else {
        end = breakPos;
      }
    }

    const chunk = text.slice(start, end).trim();
    if (chunk.length > 0) {
      chunks.push(chunk);
    }

    start = end - overlapSize;
    if (start < 0) start = 0;
    if (end - start < CHUNK_SIZE_MIN) {
      start = end;
    }
  }

  return { chunks, recordsFound: chunks.length };
}

export function chunkText(
  text: string,
  chunkSize: number = CHUNK_SIZE_MAX
): { chunks: string[]; recordsFound: number } {
  if (!text || text.length === 0) return { chunks: [], recordsFound: 0 };
  if (text.length <= chunkSize) return { chunks: [text], recordsFound: 1 };

  return smartChunkText(text);
}

export function getChunkMetadata(
  filename: string,
  docType?: string,
  project?: string,
  version?: string
): Record<string, string | number | boolean> {
  return {
    filename,
    doc_type: docType || 'unknown',
    project: project || 'default',
    version: version || '1.0',
    uploaded_at: Date.now(),
  };
}