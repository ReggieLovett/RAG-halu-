import { createHash } from "node:crypto";

export const DEFAULT_CHUNK_SIZE = 1_000;
export const DEFAULT_CHUNK_OVERLAP = 150;

export function stableHash(value: string, length = 64): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

/** Collapse PDF/DOCX layout whitespace while keeping paragraph breaks. */
export function normalizeText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/­/g, "") // soft hyphens
    .replace(/[^\S\n]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Split normalized text into sentence-sized units. */
function sentenceUnits(text: string): string[] {
  const units: string[] = [];
  for (const paragraph of text.split(/\n{2,}/)) {
    const flat = paragraph.replace(/\n/g, " ").trim();
    if (!flat) continue;
    units.push(...flat.split(/(?<=[.!?]["'”’)\]]?)\s+(?=["'“‘(\[]?[A-Z0-9])/));
  }
  return units.map((unit) => unit.trim()).filter(Boolean);
}

function codePointSafeEnd(text: string, end: number): number {
  const code = text.charCodeAt(end - 1);
  return code >= 0xd800 && code <= 0xdbff ? end - 1 : end;
}

/** Hard-split a unit longer than `size` at word boundaries where possible. */
function splitLongUnit(unit: string, size: number): string[] {
  const parts: string[] = [];
  let rest = unit;
  while (rest.length > size) {
    let end = rest.lastIndexOf(" ", size);
    if (end < size / 2) end = codePointSafeEnd(rest, size);
    parts.push(rest.slice(0, end).trim());
    rest = rest.slice(end).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

/**
 * Sentence-aware chunking: sentences are packed into chunks of at most `size`
 * characters, and each chunk repeats trailing sentences (up to `overlap`
 * characters) of the previous one so facts spanning a boundary stay retrievable.
 */
export function chunkText(text: string, size = DEFAULT_CHUNK_SIZE, overlap = DEFAULT_CHUNK_OVERLAP): string[] {
  if (!Number.isInteger(size) || size < 50 || !Number.isInteger(overlap) || overlap < 0 || overlap >= size) {
    throw new Error("chunkText needs size >= 50 and 0 <= overlap < size.");
  }
  const units = sentenceUnits(normalizeText(text)).flatMap((unit) => splitLongUnit(unit, size));
  const chunks: string[] = [];
  let current: string[] = [];
  let length = 0;

  for (const unit of units) {
    const added = length === 0 ? unit.length : length + 1 + unit.length;
    if (added > size && current.length > 0) {
      chunks.push(current.join(" "));
      // Seed the next chunk with whole trailing sentences that fit the overlap.
      const carried: string[] = [];
      let carriedLength = 0;
      for (let i = current.length - 1; i >= 0; i--) {
        const next = carriedLength + (carried.length ? 1 : 0) + current[i].length;
        if (next > overlap || next + 1 + unit.length > size) break;
        carried.unshift(current[i]);
        carriedLength = next;
      }
      current = carried;
      length = carriedLength;
    }
    current.push(unit);
    length = length === 0 ? unit.length : length + 1 + unit.length;
  }
  if (current.length) chunks.push(current.join(" "));
  return chunks;
}
