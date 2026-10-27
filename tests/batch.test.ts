import assert from "node:assert/strict";
import { test } from "node:test";
import { BATCH_LIMITS, batchReportCsv, createBatchChecker, parseBatchInput, parseBatchText, readBatchRequest } from "../lib/rag/batch";
import { RagError } from "../lib/rag/errors";
import { POST } from "../app/api/batch/route";
import type { Passage, VerificationResult } from "../lib/rag/types";

const passage: Passage = { id: "p1", text: "Paris is in France.", source: "manual", metadata: {}, distance: null };
const empty: VerificationResult = { claims: [], totalClaims: 0, supportedClaims: 0, contradictedClaims: 0, unsupportedClaims: 0, faithfulnessScore: null };

function score(supported: number, total: number): VerificationResult {
  return { ...empty, totalClaims: total, supportedClaims: supported, unsupportedClaims: total - supported, faithfulnessScore: total ? supported / total * 100 : null };
}

test("batch JSON and JSONL inputs enforce file and row limits without dropping rows", () => {
  assert.equal(parseBatchText('[{"question":"Where?"}]').items.length, 1);
  assert.equal(parseBatchText('{"question":"One?"}\n\n{"question":"Two?"}', "input.jsonl").items.length, 2);
  assert.equal(parseBatchText('\uFEFF{"items":[{"question":"Where?"}],"concurrency":2}').concurrency, 2);
  assert.throws(() => parseBatchInput({ items: [] }), (e: unknown) => e instanceof RagError && e.code === "INVALID_BATCH");
  assert.throws(() => parseBatchInput({ items: Array.from({ length: 51 }, () => ({})) }));
  assert.throws(() => parseBatchInput({ items: [{}], concurrency: 3 }));
  assert.throws(() => parseBatchText("a".repeat(BATCH_LIMITS.bytes + 1)), (e: unknown) => e instanceof RagError && e.status === 413);
  assert.throws(() => parseBatchText('{"question":"valid"}\ninvalid', "input.jsonl"), /line 2/);
});

test("manual answers use explicit context including [] and do not retrieve or regenerate", async () => {
  const contexts: Passage[][] = [];
  const run = createBatchChecker({
    retrieve: async () => { throw new Error("Unexpected retrieval"); },
    generate: async () => { throw new Error("Unexpected generation"); },
    verify: async (_question, context, answer) => { contexts.push(context); assert.equal(answer, "A"); return empty; },
  });
  const report = await run(parseBatchInput({ items: [
    { question: "Q1", answer: "A", context: [{ id: "p1", text: passage.text }] },
    { question: "Q2", answer: "A", context: [] },
  ] }));
  assert.equal(report.summary.verifiedItems, 2);
  assert.equal(contexts[0][0].source, "p1");
  assert.deepEqual(contexts[1], []);
  assert.equal(report.summary.faithfulnessScore, null);
});

test("batch supports retrieved manual answers and full RAG with the exact same evidence", async () => {
  const calls: string[] = [];
  const context = [passage];
  const run = createBatchChecker({
    retrieve: async (question, topK) => { calls.push(`retrieve:${question}:${topK}`); return context; },
    generate: async (_q, received) => { assert.equal(received, context); calls.push("generate"); return "generated"; },
    verify: async (_q, received, answer) => { assert.equal(received, context); calls.push(`verify:${answer}`); return score(1, 1); },
  });
  const report = await run(parseBatchInput({ items: [
    { question: "Q1", answer: "manual", topK: 2 },
    { question: "Q2" },
  ] }));
  assert.deepEqual(calls, ["retrieve:Q1:2", "verify:manual", "retrieve:Q2:5", "generate", "verify:generated"]);
  assert.equal(report.summary.faithfulnessScore, 100);
});

test("missing answers generate against supplied passages and abstain for empty passages", async () => {
  let generations = 0;
  let verifications = 0;
  const run = createBatchChecker({
    retrieve: async () => { throw new Error("Unexpected retrieval"); },
    generate: async (_q, context) => { generations++; assert.equal(context[0].id, "p1"); return "A"; },
    verify: async () => { verifications++; return empty; },
  });
  const report = await run(parseBatchInput({ items: [
    { question: "Q1", context: [{ id: "p1", text: passage.text }] },
    { question: "Q2", context: [] },
  ] }));
  assert.equal(generations, 1);
  assert.equal(verifications, 1);
  assert.equal(report.results[1].status, "no_context");
  assert.equal(report.summary.noContextItems, 1);
  assert.equal(report.summary.totalClaims, 0);
});

test("partial errors stay in file order and aggregate faithfulness is claim weighted", async () => {
  const run = createBatchChecker({
    retrieve: async () => [passage], generate: async () => "A",
    verify: async (question) => {
      if (question === "fail") throw new Error("secret upstream token");
      if (question === "safe") throw new RagError("secret private path", 500, "GROQ_TIMEOUT");
      return question === "one" ? score(1, 1) : score(0, 3);
    },
  });
  const report = await run(parseBatchInput({ items: [
    { id: "first", question: "one" },
    { id: "second", question: "three" },
    { question: "fail" },
    { question: "safe" },
    { question: "", answer: "invalid" },
    { question: "duplicate", answer: "A", context: [{ id: "p", text: "A" }, { id: "p", text: "B" }] },
  ], concurrency: 2 }));
  assert.deepEqual(report.results.map(r => r.id), ["first", "second", "row-3", "row-4", "row-5", "row-6"]);
  assert.equal(report.summary.verifiedItems, 2);
  assert.equal(report.summary.failedItems, 4);
  assert.equal(report.summary.faithfulnessScore, 25);
  assert.equal(report.summary.totalClaims, 4);
  assert.equal(JSON.stringify(report).includes("secret"), false);
});

test("concurrency is bounded and cancellation stops new model work while preserving report rows", async () => {
  let active = 0;
  let maxActive = 0;
  let calls = 0;
  const controller = new AbortController();
  const run = createBatchChecker({
    retrieve: async () => [passage], generate: async () => "A",
    verify: async (_q, _p, _a, signal) => {
      assert.equal(signal, controller.signal);
      calls++; active++; maxActive = Math.max(active, maxActive);
      await new Promise(resolve => setTimeout(resolve, 5));
      active--;
      controller.abort();
      return empty;
    },
  });
  const report = await run(parseBatchInput({ items: Array.from({ length: 10 }, (_, i) => ({ question: String(i) })), concurrency: 2 }), controller.signal);
  assert.equal(maxActive, 2);
  assert.equal(calls, 2);
  assert.equal(report.results.length, 10);
  assert.equal(report.summary.cancelledItems, 10);
  assert.equal(report.summary.totalClaims, 0);
});

test("request reader supports multipart JSONL and checks actual bytes for oversized bodies", async () => {
  const form = new FormData();
  form.append("file", new Blob(['{"question":"Q","answer":"A","context":[]}']), "items.jsonl");
  form.append("concurrency", "2");
  const parsed = await readBatchRequest(new Request("http://127.0.0.1/api/batch", { method: "POST", body: form }));
  assert.equal(parsed.concurrency, 2);
  assert.equal(parsed.items.length, 1);
  const request = new Request("http://127.0.0.1/api/batch", { method: "POST", headers: { "content-type": "application/json" }, body: " ".repeat(BATCH_LIMITS.bytes + 1) });
  await assert.rejects(readBatchRequest(request), (e: unknown) => e instanceof RagError && e.status === 413);
  await assert.rejects(readBatchRequest(new Request("http://127.0.0.1/api/batch", { method: "POST", body: "{}" })), (e: unknown) => e instanceof RagError && e.status === 415);
});

test("CSV quotes cells, includes claim evidence, and prevents spreadsheet formula execution", async () => {
  const run = createBatchChecker({ retrieve: async () => [], generate: async () => "A", verify: async () => empty });
  const report = await run(parseBatchInput({ items: [{ id: '=HYPERLINK("bad")', question: "\t+SUM(1,2)", answer: "A", context: [] }] }));
  const csv = batchReportCsv(report);
  assert.ok(csv.includes('"\'=HYPERLINK(""bad"")"'));
  assert.ok(csv.includes('"\'+SUM(1,2)"'));
  assert.equal(csv.trim().split("\r\n").length, 2);
  assert.equal(csv.includes("secret"), false);
});

test("batch route exports JSON or CSV and rejects invalid uploads before model calls", async () => {
  const request = (suffix: string, body: unknown) => new Request(`http://127.0.0.1/api/batch${suffix}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const body = { items: [{ question: "Unknown?", context: [] }] };
  const json = await POST(request("?download=1", body));
  assert.equal(json.status, 200);
  assert.ok(json.headers.get("content-disposition")?.includes("rag-batch-report.json"));
  assert.equal((await json.json()).summary.noContextItems, 1);
  const csv = await POST(request("?format=csv", body));
  assert.equal(csv.status, 200);
  assert.ok(csv.headers.get("content-type")?.startsWith("text/csv"));
  assert.ok((await csv.text()).includes("no_context"));
  const invalid = await POST(request("", { items: [] }));
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).code, "INVALID_BATCH");
});
