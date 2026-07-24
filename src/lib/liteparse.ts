/**
 * LiteParse — Lightweight text extraction for PDF, TXT, MD files.
 * Uses pdf-parse with dynamic import to avoid its test PDF issue on startup.
 */

export interface ParseResult {
  text: string;
  success: boolean;
  error?: string;
  pages?: number;
}

/**
 * Parse a PDF buffer using pdf-parse with dynamic import.
 */
async function parsePdfBuffer(buffer: Buffer): Promise<ParseResult> {
  const pdfParse = (await import('pdf-parse')).default;
  const data = await pdfParse(buffer);

  let fullText = data.text.trim();

  if (data.numpages && data.numpages > 1) {
    fullText = fullText.replace(/\f/g, '\n\n--- Page Break ---\n\n');
  }

  if (!fullText) {
    return {
      text: '',
      success: false,
      error: 'No extractable text found in PDF (possibly scanned/image-only)',
      pages: data.numpages,
    };
  }

  return {
    text: fullText,
    success: true,
    pages: data.numpages,
  };
}

/**
 * Parse a file and extract text content.
 * @param content - Buffer/ArrayBuffer/Uint8Array/string of the file data, or raw text for type="text"
 * @param type - "pdf" or "text"
 * @param filename - Filename (used to determine extension for pdf/text/md)
 * @returns ParseResult with extracted text
 */
export async function liteParse(
  content: Buffer | ArrayBuffer | Uint8Array | string,
  type: 'pdf' | 'text',
  filename?: string
): Promise<ParseResult> {
  try {
    let buffer: Buffer;
    if (typeof content === 'string') {
      if (type === 'text') {
        return { text: content.trim(), success: true };
      }
      buffer = Buffer.from(content, 'base64');
    } else if (content instanceof ArrayBuffer) {
      buffer = Buffer.from(content);
    } else if (content instanceof Uint8Array) {
      buffer = Buffer.from(content);
    } else {
      buffer = content;
    }

    const ext = filename
      ? filename.toLowerCase().split('.').pop() || ''
      : type === 'pdf' ? 'pdf' : 'txt';

    if (ext === 'pdf') {
      return await parsePdfBuffer(buffer);
    } else if (ext === 'txt' || ext === 'md') {
      const text = buffer.toString('utf-8');
      return { text: text.trim(), success: true };
    } else {
      return {
        text: '',
        success: false,
        error: `Format .${ext} is not supported. Supported: PDF, TXT, MD.`,
      };
    }
  } catch (err: any) {
    console.error('LiteParse error:', err);
    return {
      text: '',
      success: false,
      error: `Parse failed: ${err.message || 'Unknown error'}`,
    };
  }
}