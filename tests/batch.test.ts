import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { z } from "zod";
import { forEachConcurrent, runBatchCheck } from "../lib/batch";
import { checkRequestSchema } from "../lib/checker";
import { AppError } from "../lib/errors";
import type { ClaimCheck } from "../lib/types";
import { checkResult } from "./fixtures";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function claims(supported: number, unsupported: number): ClaimCheck[] {
  const make = (verdict: ClaimCheck["verdict"], index: number): ClaimCheck => ({
    id: `c${index}`, claim: `claim ${index}`, verdict, modelVerdict: verdict, evidence: "", evidenceFound: false, literalMatch: null, confidence: 1, reasoning: "", adjustments: [],
  });
  return [
    ...Array.from({ length: supported }, (_, index) => make("Supported", index)),
    ...Array.from({ length: unsupported }, (_, index) => make("Unsupported", supported + index)),
  ];
}

const item = (question: string) => ({ question, answer: `answer to ${question}`, context: "context" });

describe("forEachConcurrent", () => {
  it("never exceeds the concurrency limit and visits every item", async () => {
    let inFlight = 0;
    let peak = 0;
    const seen: number[] = [];
    await forEachConcurrent([30, 5, 20, 1, 10, 15, 2], 3, async (delay, index) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await sleep(delay);
      seen.push(index);
      inFlight--;
    });
    assert.equal(peak, 3);
    assert.deepEqual(seen.sort(), [0, 1, 2, 3, 4, 5, 6]);
  });
});

describe("runBatchCheck", () => {
  it("checks items concurrently, keeps input order, and reports per-item failures", async () => {
    const strictFlags: boolean[] = [];
    const check = async (request: unknown) => {
      const input = checkRequestSchema.parse(request); // the batch forwards raw items
      strictFlags.push(input.strictnessMode);
      if (input.question === "slow") await sleep(30);
      if (input.question === "fail") throw new AppError(504, "GROQ_TIMEOUT", "Groq did not respond.");
      const result = input.question === "none" ? claims(0, 0) : input.question === "half" ? claims(1, 1) : claims(3, 0);
      return checkResult({ question: input.question, answer: input.answer, claims: result });
    };

    const report = await runBatchCheck({
      items: [
        { id: "a", ...item("slow"), source: "hf://row/1" },
        item("half"),
        item("fail"),
        { question: "missing answer and context" },
        item("none"),
      ],
      strictnessMode: true,
      concurrency: 2,
    }, { check });

    assert.deepEqual(report.results.map((result) => result.index), [0, 1, 2, 3, 4]);
    assert.deepEqual(report.results.map((result) => result.status), ["ok", "ok", "error", "error", "ok"]);
    assert.deepEqual(report.results.map((result) => result.id), ["a", "item-2", "item-3", "item-4", "item-5"]);
    assert.equal(report.results[0].source, "hf://row/1");
    const timeout = report.results[2];
    assert.ok(timeout.status === "error" && timeout.error.code === "GROQ_TIMEOUT");
    const invalid = report.results[3];
    assert.ok(invalid.status === "error" && invalid.error.code === "INVALID_ITEM" && /answer/.test(invalid.error.message));
    assert.ok(strictFlags.every(Boolean));
    assert.equal(report.strictnessMode, true);
    assert.equal(report.concurrency, 2);

    // 4 supported of 5 claims overall; per-item mean of 100 and 50 (the zero-claim item is excluded).
    assert.deepEqual(report.summary, {
      totalItems: 5,
      succeeded: 3,
      failed: 2,
      totalClaims: 5,
      supportedClaims: 4,
      contradictedClaims: 0,
      unsupportedClaims: 1,
      overallFaithfulness: 80,
      averageFaithfulness: 75,
      averageAnswerRelevance: 80,
      averageContextRelevance: 60,
      itemsWithFailedClaims: 1,
    });
  });

  it("accepts a bare array and rejects empty or oversized batches", async () => {
    const check = async (request: unknown) => {
      const input = checkRequestSchema.parse(request);
      return checkResult({ question: input.question, answer: input.answer, claims: claims(1, 0) });
    };
    const report = await runBatchCheck([item("one")], { check });
    assert.equal(report.summary.succeeded, 1);
    assert.equal(report.strictnessMode, false);
    await assert.rejects(runBatchCheck([], { check }), z.ZodError);
    await assert.rejects(runBatchCheck(Array.from({ length: 51 }, (_, index) => item(String(index))), { check }), z.ZodError);
    await assert.rejects(runBatchCheck({ items: [item("x")], concurrency: 9 }, { check }), z.ZodError);
  });
});
