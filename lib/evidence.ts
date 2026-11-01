export type LocatedQuote = { start: number; end: number; text: string };

type NormalizedText = {
  text: string;
  /** For each normalized character: [start, end) of its source code point. */
  starts: number[];
  ends: number[];
};

const TYPOGRAPHY: [RegExp, string][] = [
  [/[‘’‚‛′`´]/g, "'"],
  [/[“”„‟″]/g, '"'],
  [/[‐‑‒–—―−]/g, "-"],
];

/**
 * Normalize for matching only: NFKC (ligatures, ellipsis), unified quotes and
 * dashes, collapsed whitespace, optional lowercasing. Every normalized
 * character remembers its source span so matches map back to exact source text.
 */
function normalize(source: string, lowerCase: boolean): NormalizedText {
  const result: NormalizedText = { text: "", starts: [], ends: [] };
  let pendingSpace = false;
  for (let index = 0; index < source.length;) {
    const char = String.fromCodePoint(source.codePointAt(index)!);
    const end = index + char.length;
    let replacement = char.normalize("NFKC");
    for (const [pattern, value] of TYPOGRAPHY) replacement = replacement.replace(pattern, value);
    if (lowerCase) replacement = replacement.toLowerCase();
    if (/^[​-‍⁠﻿]$/.test(replacement)) {
      // Zero-width characters from PDF extraction carry no meaning.
    } else if (/^\s+$/.test(replacement)) {
      pendingSpace = result.text.length > 0;
    } else {
      if (pendingSpace) {
        result.text += " ";
        result.starts.push(index);
        result.ends.push(index);
        pendingSpace = false;
      }
      for (const part of replacement) {
        result.text += part;
        result.starts.push(index);
        result.ends.push(end);
      }
    }
    index = end;
  }
  return result;
}

/** Remove a wrapping pair of quotation marks and leading/trailing ellipses models often add. */
export function cleanQuote(quote: string): string {
  let text = quote.trim();
  if (text.length >= 2 && /^["'“”‘’«»][\s\S]*["'“”‘’«»]$/.test(text)) text = text.slice(1, -1).trim();
  return text.replace(/^(?:\.\.\.|…)\s*|\s*(?:\.\.\.|…)$/g, "").trim();
}

/**
 * Locate model-quoted evidence inside the source. Tries an exact match, then a
 * whitespace/typography-insensitive match, then a case-insensitive one, and
 * always returns the exact source substring. A quote stitched together with an
 * ellipsis is matched by its longest fragment. Normalization never drops
 * letters, digits, or punctuation, so "3.5 mg" can never match "35 mg".
 */
export function createQuoteLocator(source: string): (quote: string) => LocatedQuote | null {
  let caseSensitive: NormalizedText | undefined;
  let caseInsensitive: NormalizedText | undefined;

  const find = (fragment: string): LocatedQuote | null => {
    const exact = source.indexOf(fragment);
    if (exact >= 0) return { start: exact, end: exact + fragment.length, text: fragment };
    for (const lowerCase of [false, true]) {
      const haystack = lowerCase
        ? (caseInsensitive ??= normalize(source, true))
        : (caseSensitive ??= normalize(source, false));
      const needle = normalize(fragment, lowerCase).text;
      if (!needle) return null;
      const at = haystack.text.indexOf(needle);
      if (at >= 0) {
        const start = haystack.starts[at];
        const end = haystack.ends[at + needle.length - 1];
        return { start, end, text: source.slice(start, end) };
      }
    }
    return null;
  };

  return (quote) => {
    const cleaned = cleanQuote(quote);
    if (!cleaned) return null;
    // The "wrapping" quotes may have been part of the source text after all.
    const whole = find(cleaned) ?? (cleaned !== quote.trim() ? find(quote.trim()) : null);
    if (whole) return whole;
    const fragments = cleaned.split(/\s*(?:\.\.\.|…)\s*/).filter((part) => part.length >= 20);
    if (fragments.length < 2) return null;
    const longest = fragments.reduce((a, b) => (b.length > a.length ? b : a));
    return find(longest);
  };
}

export function locateQuote(source: string, quote: string): LocatedQuote | null {
  return createQuoteLocator(source)(quote);
}
