import type { AnswerSpan, Verdict, VerifiedClaim } from "./types";

export type AnswerSegment = {
  text: string;
  start: number;
  end: number;
  verdict: Verdict | null;
  claimIds: string[];
};

function isCharacterBoundary(text: string, position: number): boolean {
  if (position <= 0 || position >= text.length) return true;
  const previous = text.charCodeAt(position - 1);
  const current = text.charCodeAt(position);
  return !(previous >= 0xd800 && previous <= 0xdbff && current >= 0xdc00 && current <= 0xdfff);
}

/** Resolve exact quotations locally; do not trust model-generated character offsets. */
export function locateAnswerQuotes(answer: string, quotes: readonly string[]): AnswerSpan[] | null {
  if (!quotes.length) return null;
  const spans = new Map<string, AnswerSpan>();
  for (const quote of quotes) {
    if (!quote.trim()) return null;
    let start = answer.indexOf(quote);
    if (start === -1) return null;
    while (start !== -1) {
      const end = start + quote.length;
      if (!isCharacterBoundary(answer, start) || !isCharacterBoundary(answer, end)) return null;
      spans.set(`${start}:${end}`, { start, end, text: quote });
      // Include repeated and overlapping occurrences rather than only the first.
      start = answer.indexOf(quote, start + 1);
    }
  }
  return Array.from(spans.values()).sort((a, b) => a.start - b.start || a.end - b.end);
}

const priority: Record<Verdict, number> = { Supported: 1, Unsupported: 2, Contradicted: 3 };

/**
 * Partition original answer text exactly once for safe React text rendering.
 * Unmapped text remains unverified (null); overlapping verdicts use the most
 * conservative status. No HTML is generated or interpreted.
 */
export function segmentAnswer(
  answer: string,
  claims: readonly Pick<VerifiedClaim, "id" | "verdict" | "answerSpans">[],
): AnswerSegment[] {
  if (!answer) return [];
  const events = new Map<number, { index: number; delta: number }[]>();
  const addEvent = (position: number, index: number, delta: number) => {
    const values = events.get(position) || [];
    values.push({ index, delta });
    events.set(position, values);
  };
  claims.forEach((claim, index) => {
    if (!Object.hasOwn(priority, claim.verdict)) return;
    for (const span of claim.answerSpans || []) {
      if (
        !Number.isInteger(span.start) || !Number.isInteger(span.end) ||
        span.start < 0 || span.end > answer.length || span.start >= span.end ||
        answer.slice(span.start, span.end) !== span.text ||
        !isCharacterBoundary(answer, span.start) || !isCharacterBoundary(answer, span.end)
      ) continue;
      addEvent(span.start, index, 1);
      addEvent(span.end, index, -1);
    }
  });
  const boundaries = Array.from(new Set([0, answer.length, ...Array.from(events.keys())])).sort((a, b) => a - b);
  const activeCounts = new Map<number, number>();
  const segments: AnswerSegment[] = [];
  for (let i = 0; i < boundaries.length - 1; i += 1) {
    const start = boundaries[i];
    const end = boundaries[i + 1];
    for (const { index, delta } of events.get(start) || []) {
      const count = (activeCounts.get(index) || 0) + delta;
      if (count > 0) activeCounts.set(index, count);
      else activeCounts.delete(index);
    }
    let verdict: Verdict | null = null;
    const claimIds: string[] = [];
    claims.forEach((claim, index) => {
      if (!activeCounts.has(index)) return;
      if (!claimIds.includes(claim.id)) claimIds.push(claim.id);
      if (verdict === null || priority[claim.verdict] > priority[verdict]) verdict = claim.verdict;
    });
    const previous = segments[segments.length - 1];
    if (previous && previous.verdict === verdict && previous.claimIds.length === claimIds.length && previous.claimIds.every((id, index) => id === claimIds[index])) {
      previous.end = end;
      previous.text = answer.slice(previous.start, end);
    } else {
      segments.push({ text: answer.slice(start, end), start, end, verdict, claimIds });
    }
  }
  return segments;
}
