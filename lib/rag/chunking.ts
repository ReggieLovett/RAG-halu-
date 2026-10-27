import { createHash } from "node:crypto";

export const CHUNKING_VERSION = "characters-v1";
export const DEFAULT_CHUNK_SIZE = 800;
export const DEFAULT_CHUNK_OVERLAP = 120;

export function normalizeDocument(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/[\t ]+/g, " ").trim();
}

/** Character-bounded chunks with overlap; no sentence or suffix is discarded. */
export function chunkText(
  text: string,
  size = DEFAULT_CHUNK_SIZE,
  overlap = DEFAULT_CHUNK_OVERLAP,
): string[] {
  if (!Number.isInteger(size) || size < 32 || !Number.isInteger(overlap) || overlap < 0 || overlap >= size) {
    throw new Error("Chunk size must be at least 32 and overlap must be between 0 and size - 1.");
  }
  const normalized = normalizeDocument(text);
  if (!normalized) return [];
  const chunks: string[] = [];
  let start = 0;
  while (start < normalized.length) {
    const end = Math.min(start + size, normalized.length);
    const chunk = normalized.slice(start, end).trim();
    if (chunk) chunks.push(chunk);
    if (end === normalized.length) break;
    start = end - overlap;
  }
  return chunks;
}

export function stableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Independent of row offset so duplicate SQuAD contexts and reruns share IDs. */
export function chunkId(namespace: string, document: string, chunkIndex: number): string {
  return stableHash(JSON.stringify([namespace, CHUNKING_VERSION, normalizeDocument(document), chunkIndex]));
}
