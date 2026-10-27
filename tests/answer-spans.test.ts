import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { locateAnswerQuotes, segmentAnswer } from "../lib/rag/answer-spans";
import type { AnswerSpan, Verdict } from "../lib/rag/types";

function claim(id: string, verdict: Verdict, spans: AnswerSpan[]) {
  return { id, verdict, answerSpans: spans };
}

describe("original answer claim spans", () => {
  test("maps every repeated and overlapping quote occurrence using exact original text", () => {
    assert.deepEqual(locateAnswerQuotes("aaaa", ["aa", "aa"]), [
      { start: 0, end: 2, text: "aa" },
      { start: 1, end: 3, text: "aa" },
      { start: 2, end: 4, text: "aa" },
    ]);
  });

  test("requires every answer quotation to exist exactly", () => {
    for (const quotes of [[], [""], ["   "], ["paris"], ["Paris", "invented"], ["Paris is"]]) {
      assert.equal(locateAnswerQuotes("Paris  is in France.", quotes), null);
    }
  });

  test("computes UTF-16 offsets without splitting Unicode surrogate pairs", () => {
    const answer = "🗼 Paris — café e\u0301. 🗼 Paris";
    const spans = locateAnswerQuotes(answer, ["Paris", "café e\u0301."])!;
    assert.deepEqual(spans, [
      { start: 3, end: 8, text: "Paris" },
      { start: 11, end: 19, text: "café e\u0301." },
      { start: 23, end: 28, text: "Paris" },
    ]);
    assert.equal(locateAnswerQuotes(answer, ["\uddfc"]), null);
    assert.equal(locateAnswerQuotes(answer, ["\ud83d"]), null);
    assert.deepEqual(locateAnswerQuotes(answer, ["🗼"])?.map((span) => span.end - span.start), [2, 2]);
  });

  test("keeps gaps and punctuation unverified and partitions original answer exactly once", () => {
    const answer = "Hello! Paris is the capital. [p1]\nI cannot say more.";
    const spans = locateAnswerQuotes(answer, ["Paris is the capital."])!;
    const segments = segmentAnswer(answer, [claim("c1", "Supported", spans)]);
    assert.deepEqual(segments, [
      { start: 0, end: 7, text: "Hello! ", verdict: null, claimIds: [] },
      { start: 7, end: 28, text: "Paris is the capital.", verdict: "Supported", claimIds: ["c1"] },
      { start: 28, end: answer.length, text: " [p1]\nI cannot say more.", verdict: null, claimIds: [] },
    ]);
    assert.equal(segments.map((segment) => segment.text).join(""), answer);
  });

  test("colors independent facts within a compound sentence separately", () => {
    const answer = "The tower opened in 1900 and has 200 elevators.";
    const segments = segmentAnswer(answer, [
      claim("c1", "Contradicted", locateAnswerQuotes(answer, ["The tower opened in 1900"])!),
      claim("c2", "Unsupported", locateAnswerQuotes(answer, ["has 200 elevators."])!),
    ]);
    assert.deepEqual(segments.map(({ text, verdict }) => ({ text, verdict })), [
      { text: "The tower opened in 1900", verdict: "Contradicted" },
      { text: " and ", verdict: null },
      { text: "has 200 elevators.", verdict: "Unsupported" },
    ]);
  });

  test("uses Contradicted then Unsupported then Supported for overlaps", () => {
    const answer = "abcdefghij";
    const segments = segmentAnswer(answer, [
      claim("c1", "Supported", [{ start: 0, end: 8, text: "abcdefgh" }]),
      claim("c2", "Unsupported", [{ start: 2, end: 6, text: "cdef" }]),
      claim("c3", "Contradicted", [{ start: 4, end: 7, text: "efg" }]),
    ]);
    assert.deepEqual(segments.map(({ text, verdict, claimIds }) => ({ text, verdict, claimIds })), [
      { text: "ab", verdict: "Supported", claimIds: ["c1"] },
      { text: "cd", verdict: "Unsupported", claimIds: ["c1", "c2"] },
      { text: "ef", verdict: "Contradicted", claimIds: ["c1", "c2", "c3"] },
      { text: "g", verdict: "Contradicted", claimIds: ["c1", "c3"] },
      { text: "h", verdict: "Supported", claimIds: ["c1"] },
      { text: "ij", verdict: null, claimIds: [] },
    ]);
    assert.equal(segments.map((segment) => segment.text).join(""), answer);
  });

  test("overlapping quotes for one claim remain active until every quote ends", () => {
    const answer = "aaaa";
    assert.deepEqual(segmentAnswer(answer, [claim("c1", "Supported", locateAnswerQuotes(answer, ["aa"])!)]), [
      { text: answer, start: 0, end: 4, verdict: "Supported", claimIds: ["c1"] },
    ]);
  });

  test("ignores invalid persisted spans and handles old claims without span data", () => {
    const answer = "🗼 Paris";
    const invalid = [
      { start: -1, end: 2, text: "🗼" },
      { start: 0, end: 100, text: answer },
      { start: 0.5, end: 2, text: "🗼" },
      { start: 3, end: 8, text: "wrong" },
      { start: 1, end: 2, text: "\uddfc" },
      { start: 2, end: 2, text: "" },
    ];
    assert.deepEqual(segmentAnswer(answer, [claim("c1", "Supported", invalid), { id: "c2", verdict: "Supported" }]), [
      { start: 0, end: answer.length, text: answer, verdict: null, claimIds: [] },
    ]);
    assert.deepEqual(segmentAnswer("", []), []);
  });

  test("retains malicious markup as literal text rather than producing HTML", () => {
    const answer = '<img src=x onerror="alert(1)"> Paris is in France. <script>steal()</script>';
    const segments = segmentAnswer(answer, [claim("c1", "Supported", locateAnswerQuotes(answer, ["Paris is in France."])!)]);
    assert.equal(segments.map((segment) => segment.text).join(""), answer);
    assert.equal(segments[0].text, '<img src=x onerror="alert(1)"> ');
    assert.equal(segments[2].text, " <script>steal()</script>");
  });
});
