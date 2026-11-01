import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { z } from "zod";
import { checkAnswer, contextToText, faithfulnessScore } from "../lib/checker";
import { AppError } from "../lib/errors";
import type { JsonCompleter, JsonCompletionRequest } from "../lib/groq";

const context =
  "The study enrolled 412 adults aged 18 to 65 across three hospitals in Ohio between 2019 and 2021.\n" +
  "Participants who received the intervention had 23% fewer hospital readmissions than the control group. " +
  "The trial did not measure long-term mortality.";

const request = {
  question: "What did the study find about readmissions?",
  context,
  answer: "The study enrolled 412 adults in Ohio. Readmissions fell by 32%. It lowered mortality. Sites were rural.",
};

type Handlers = Record<string, (request: JsonCompletionRequest<unknown>) => unknown>;

/** A fake Groq completer keyed by schema name that records every call. */
function fakeCompleter(handlers: Handlers) {
  const calls: JsonCompletionRequest<unknown>[] = [];
  const complete = (async (call: JsonCompletionRequest<unknown>) => {
    calls.push(call);
    const handler = handlers[call.schemaName];
    if (!handler) throw new Error(`unexpected schema ${call.schemaName}`);
    return call.schema.parse(handler(call));
  }) as JsonCompleter;
  return { complete, calls };
}

/** Property names, in order, of one verification result in the schema sent to Groq. */
function resultKeys(call: JsonCompletionRequest<unknown>): string[] {
  const schema = z.toJSONSchema(call.schema) as unknown as { properties: { results: { items: { properties: Record<string, unknown> } } } };
  return Object.keys(schema.properties.results.items.properties);
}

const claims = [
  "The study enrolled 412 adults.",
  "The study took place in Ohio.",
  "Readmissions fell by 32%.",
  "The intervention lowered mortality.",
];

const standardHandlers: Handlers = {
  claim_extraction: () => ({ claims: [...claims, "the study enrolled 412 adults"] }), // duplicate is dropped
  claim_verification: () => ({
    results: [
      // literalMatch is only kept by the strict schema; the standard schema strips it.
      { id: "c1", verdict: "Supported", evidence: "The study enrolled 412 adults aged 18 to 65", literalMatch: true, confidence: 0.99, reasoning: "Stated." },
      // Different whitespace than the context: still located, and the exact source text is returned.
      { id: "c2", verdict: "Supported", evidence: "three hospitals in   Ohio", literalMatch: true, confidence: 0.9, reasoning: "Stated." },
      { id: "c3", verdict: "Contradicted", evidence: "had 23% fewer hospital readmissions", literalMatch: false, confidence: 0.97, reasoning: "23%, not 32%." },
      { id: "c4", verdict: "Unsupported", evidence: "", literalMatch: false, confidence: 0.8, reasoning: "Not measured." },
    ],
  }),
  rag_metrics: () => ({
    answerRelevance: 88,
    answerRelevanceReason: "Mostly on topic.",
    contextRelevance: 0.7, // a 0-1 answer is rescaled to 0-100
    contextRelevanceReason: "Relevant.",
  }),
};

describe("checkAnswer", () => {
  it("extracts, verifies, and scores claims", async () => {
    const { complete, calls } = fakeCompleter(standardHandlers);
    const result = await checkAnswer(request, { complete, model: "test-model" });

    assert.deepEqual(result.claims.map((claim) => claim.verdict), ["Supported", "Supported", "Contradicted", "Unsupported"]);
    assert.deepEqual(result.counts, { total: 4, supported: 2, contradicted: 1, unsupported: 1 });
    assert.equal(result.metrics.faithfulness, 50);
    assert.equal(result.metrics.answerRelevance, 88);
    assert.equal(result.metrics.contextRelevance, 70);
    assert.equal(result.claims[1].evidence, "three hospitals in Ohio");
    assert.ok(result.claims.every((claim) => claim.adjustments.length === 0));
    assert.equal(result.supportThreshold, null);
    assert.deepEqual(calls.map((call) => call.schemaName).sort(), ["claim_extraction", "claim_verification", "rag_metrics"]);
    const verification = calls.find((call) => call.schemaName === "claim_verification")!;
    assert.equal((verification.data as { claims: unknown[] }).claims.length, 4);
    assert.doesNotMatch(verification.system, /HEALTHCARE/);
    assert.deepEqual(resultKeys(verification), ["id", "verdict", "evidence", "confidence", "reasoning"]);
    assert.deepEqual(result.claims.map((claim) => claim.literalMatch), [null, null, null, null]);
  });

  it("requires confidence >= 0.95 for Supported in Healthcare Strictness Mode", async () => {
    const { complete, calls } = fakeCompleter(standardHandlers);
    const result = await checkAnswer({ ...request, strictnessMode: true }, { complete, model: "test-model" });

    const ohio = result.claims[1];
    assert.equal(ohio.modelVerdict, "Supported");
    assert.equal(ohio.verdict, "Unsupported");
    assert.match(ohio.adjustments[0], /Healthcare Mode requires confidence ≥ 0.95 \(got 0.90\)/);
    assert.equal(result.claims[0].verdict, "Supported"); // literal and 0.99: passes both criteria
    assert.equal(result.metrics.faithfulness, 25);
    assert.equal(result.supportThreshold, 0.95);
    assert.deepEqual(result.claims.map((claim) => claim.literalMatch), [true, true, false, false]);
    const verification = calls.find((call) => call.schemaName === "claim_verification")!;
    assert.match(verification.system, /HEALTHCARE STRICTNESS MODE/);
    // The literal judgment comes after the evidence and before the confidence.
    assert.deepEqual(resultKeys(verification), ["id", "verdict", "evidence", "literalMatch", "confidence", "reasoning"]);
  });

  it("requires a literal match for Supported in Healthcare Strictness Mode", async () => {
    const handlers: Handlers = {
      ...standardHandlers,
      claim_extraction: () => ({ claims: ["The study enrolled about 400 adults.", "The study ran in roughly three hospitals."] }),
      claim_verification: () => ({
        results: [
          { id: "c1", verdict: "Supported", evidence: "The study enrolled 412 adults", literalMatch: false, confidence: 0.99, reasoning: "412 is about 400." },
          { id: "c2", verdict: "Supported", evidence: "three hospitals in Ohio", literalMatch: false, confidence: 0.9, reasoning: "Approximate." },
        ],
      }),
    };

    const strict = await checkAnswer({ ...request, strictnessMode: true }, { complete: fakeCompleter(handlers).complete, model: "test-model" });
    assert.deepEqual(strict.claims.map((claim) => claim.verdict), ["Unsupported", "Unsupported"]);
    assert.deepEqual(strict.claims.map((claim) => claim.modelVerdict), ["Supported", "Supported"]);
    assert.equal(strict.claims[0].adjustments.length, 1, "0.99 confidence does not rescue a non-literal match");
    assert.match(strict.claims[0].adjustments[0], /state the claim literally/);
    assert.equal(strict.claims[1].adjustments.length, 2, "both strict criteria are reported");
    assert.equal(strict.metrics.faithfulness, 0);

    // Standard mode never asks for the flag, so the same verdicts stand.
    const standard = await checkAnswer(request, { complete: fakeCompleter(handlers).complete, model: "test-model" });
    assert.deepEqual(standard.claims.map((claim) => claim.verdict), ["Supported", "Supported"]);
    assert.deepEqual(standard.claims.map((claim) => claim.literalMatch), [null, null]);
    assert.equal(standard.metrics.faithfulness, 100);
  });

  it("downgrades verdicts whose evidence is not in the context", async () => {
    const { complete } = fakeCompleter({
      ...standardHandlers,
      claim_extraction: () => ({ claims: ["Readmissions fell by 32%.", "The study enrolled 412 adults."] }),
      claim_verification: () => ({
        results: [
          { id: "c1", verdict: "Supported", evidence: "readmissions fell by 32 percent", confidence: 1, reasoning: "Invented quote." },
          { id: "c2", verdict: "Contradicted", evidence: "", confidence: 0.6, reasoning: "No quote." },
        ],
      }),
    });
    const result = await checkAnswer(request, { complete, model: "test-model" });
    assert.deepEqual(result.claims.map((claim) => claim.verdict), ["Unsupported", "Unsupported"]);
    assert.equal(result.claims[0].evidenceFound, false);
    assert.match(result.claims[0].adjustments[0], /does not appear in the context/);
    assert.match(result.claims[1].adjustments[0], /no evidence quote/);
    assert.equal(result.metrics.faithfulness, 0);
  });

  it("retries claims the verifier skipped, then fails without a partial score", async () => {
    let verificationCalls = 0;
    const { complete } = fakeCompleter({
      ...standardHandlers,
      claim_verification: (call) => {
        verificationCalls++;
        const pending = (call.data as { claims: { id: string }[] }).claims;
        // Only ever answers the first pending claim.
        return { results: [{ id: pending[0].id, verdict: "Unsupported", evidence: "", confidence: 0.5, reasoning: "?" }] };
      },
    });
    await assert.rejects(checkAnswer(request, { complete, model: "test-model" }), (error: unknown) =>
      error instanceof AppError && error.code === "CHECKER_INCOMPLETE");
    assert.equal(verificationCalls, 2);
  });

  it("returns a null faithfulness score when the answer has no claims", async () => {
    const { complete, calls } = fakeCompleter({ ...standardHandlers, claim_extraction: () => ({ claims: [] }) });
    const result = await checkAnswer(request, { complete, model: "test-model" });
    assert.equal(result.metrics.faithfulness, null);
    assert.equal(result.claims.length, 0);
    assert.ok(!calls.some((call) => call.schemaName === "claim_verification"));
  });

  it("validates input and joins multi-passage context", async () => {
    const { complete } = fakeCompleter(standardHandlers);
    await assert.rejects(checkAnswer({ ...request, context: "   " }, { complete }), z.ZodError);
    await assert.rejects(checkAnswer({ ...request, answer: "" }, { complete }), z.ZodError);
    await assert.rejects(checkAnswer({ question: "q" }, { complete }), z.ZodError);
    assert.equal(contextToText([" first ", "", "second"]), "first\n\nsecond");
  });

  it("computes faithfulness as supported / total * 100", () => {
    assert.equal(faithfulnessScore({ total: 3, supported: 2, contradicted: 0, unsupported: 1 }), 66.67);
    assert.equal(faithfulnessScore({ total: 0, supported: 0, contradicted: 0, unsupported: 0 }), null);
  });
});
