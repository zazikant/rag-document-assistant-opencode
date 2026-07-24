import { createHash } from 'crypto';

/**
 * Generate SHA-256 hash of text content
 */
export function hashText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
