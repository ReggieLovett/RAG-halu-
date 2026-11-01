import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChromaRecord } from "../lib/chroma";
import { AppError } from "../lib/errors";
import { collectText, detectField, getPath, importHuggingFaceDataset } from "../lib/huggingface-importer";

const squadContext = "Architecturally, the school has a Catholic character. Atop the Main Building's gold dome is a golden statue of the Virgin Mary.";

function squadRow(index: number, question: string, context = squadContext) {
  return {
    row_idx: index,
    row: { id: `id${index}`, title: "Notre_Dame", context, question, answers: { text: ["a golden statue of the Virgin Mary"], answer_start: [92] } },
    truncated_cells: [],
  };
}

function mockFetch(routes: Record<string, (url: URL) => Response>) {
  const calls: URL[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    calls.push(url);
    const handler = routes[url.pathname];
    if (!handler) throw new Error(`unexpected ${url}`);
    return handler(url);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const json = (body: unknown, status = 200) => Response.json(body, { status });

describe("field helpers", () => {
  it("detects common column names and validates explicit ones", () => {
    const columns = ["id", "title", "context", "question", "answers"];
    assert.equal(detectField("question", columns), "question");
    assert.equal(detectField("answer", columns), "answers");
    assert.equal(detectField("context", columns), "context");
    assert.equal(detectField("context", ["Knowledge", "query", "response"]), "Knowledge");
    assert.equal(detectField("answer", columns, "answers.text.0"), "answers.text.0");
    assert.throws(() => detectField("answer", columns, "response"), (error: unknown) =>
      error instanceof AppError && error.code === "HF_FIELD_NOT_FOUND" && /Available columns: id, title/.test(error.message));
    assert.throws(() => detectField("question", ["a", "b"]), /Could not detect the question column/);
  });

  it("resolves dotted and indexed paths", () => {
    const row = { answers: { text: ["first", "second"] }, docs: [{ text: "x" }, { text: "y" }] };
    assert.equal(getPath(row, "answers.text.1"), "second");
    assert.equal(getPath(row, "answers.text[0]"), "first");
    assert.deepEqual(getPath(row, "docs.text"), ["x", "y"]);
    assert.equal(getPath(row, "missing.path"), undefined);
  });

  it("flattens strings, arrays, and text-bearing objects", () => {
    assert.deepEqual(collectText({ text: ["a", " "], answer_start: [1] }), ["a"]);
    assert.deepEqual(collectText({ title: ["T"], sentences: [["s1", "s2"], ["s3"]] }), ["s1", "s2", "s3"]);
    assert.deepEqual(collectText([{ content: "c1" }, "c2", 3]), ["c1", "c2", "3"]);
    assert.deepEqual(collectText(null), []);
  });
});

describe("importHuggingFaceDataset", () => {
  it("picks a split, maps rows to batch items, skips bad rows, and embeds unique contexts", async () => {
    const { fetchImpl, calls } = mockFetch({
      "/splits": () => json({ splits: [
        { dataset: "rajpurkar/squad", config: "plain_text", split: "train" },
        { dataset: "rajpurkar/squad", config: "plain_text", split: "validation" },
      ] }),
      "/rows": () => json({
        features: ["id", "title", "context", "question", "answers"].map((name, feature_idx) => ({ feature_idx, name, type: {} })),
        rows: [
          squadRow(5, "What sits atop the Main Building?"),
          squadRow(6, "What is the school's character?"), // same context: embedded once
          { ...squadRow(7, "Truncated?"), truncated_cells: ["context"] },
          squadRow(8, "   "),
        ],
        num_rows_total: 10570,
      }),
    });
    const upserted: ChromaRecord[][] = [];
    const upsert = async (collection: string, records: ChromaRecord[]) => {
      assert.equal(collection, "hf_test_contexts");
      upserted.push(records);
      return records.length;
    };

    const result = await importHuggingFaceDataset({ dataset: "rajpurkar/squad", offset: 5, limit: 4, config: "" }, { fetchImpl, upsert });

    const rowsCall = calls.find((url) => url.pathname === "/rows")!;
    assert.equal(rowsCall.searchParams.get("split"), "validation");
    assert.equal(rowsCall.searchParams.get("config"), "plain_text");
    assert.equal(rowsCall.searchParams.get("offset"), "5");
    assert.equal(rowsCall.searchParams.get("length"), "4");
    assert.deepEqual(result.fields, { question: "question", answer: "answers", context: "context" });
    assert.equal(result.totalRows, 10570);
    assert.equal(result.rowsFetched, 4);
    assert.deepEqual(result.items.map((item) => item.id), ["squad-validation-5", "squad-validation-6"]);
    assert.deepEqual(result.items[0], {
      id: "squad-validation-5",
      question: "What sits atop the Main Building?",
      answer: "a golden statue of the Virgin Mary",
      context: squadContext,
      source: "https://huggingface.co/datasets/rajpurkar/squad/viewer/plain_text/validation?row=5",
    });
    assert.deepEqual(result.skipped.map((row) => row.rowIndex), [7, 8]);
    assert.match(result.skipped[0].reason, /truncated/);
    assert.deepEqual(result.embedding, { status: "ok", collection: "hf_test_contexts", uniqueContexts: 1, chunksUpserted: 1 });
    assert.equal(upserted.flat()[0].document, squadContext);
    assert.equal(upserted.flat()[0].metadata.dataset, "rajpurkar/squad");
  });

  it("keeps the items when embedding fails, and skips embedding on request", async () => {
    const routes = {
      "/rows": () => json({ features: [{ name: "question" }, { name: "answer" }, { name: "knowledge" }], rows: [
        { row_idx: 0, row: { question: "Q?", answer: "A.", knowledge: "K." }, truncated_cells: [] },
      ], num_rows_total: 1 }),
    };
    const failing = async () => {
      throw new AppError(503, "CHROMA_UNAVAILABLE", "Cannot reach ChromaDB.");
    };
    const failed = await importHuggingFaceDataset(
      { dataset: "pminervini/HaluEval", config: "qa_samples", split: "data" },
      { fetchImpl: mockFetch(routes).fetchImpl, upsert: failing },
    );
    assert.equal(failed.items.length, 1);
    assert.deepEqual(failed.fields, { question: "question", answer: "answer", context: "knowledge" });
    assert.deepEqual(failed.embedding, { status: "failed", collection: "hf_test_contexts", code: "CHROMA_UNAVAILABLE", message: "Cannot reach ChromaDB." });

    const skipped = await importHuggingFaceDataset(
      { dataset: "pminervini/HaluEval", config: "qa_samples", split: "data", embed: false },
      { fetchImpl: mockFetch(routes).fetchImpl, upsert: failing },
    );
    assert.equal(skipped.embedding.status, "skipped");
  });

  it("explains missing datasets, configs, and gated access", async () => {
    const missing = mockFetch({ "/splits": () => json({ error: "The dataset does not exist." }, 404) });
    await assert.rejects(importHuggingFaceDataset({ dataset: "nobody/nothing" }, { fetchImpl: missing.fetchImpl }),
      (error: unknown) => error instanceof AppError && error.code === "HF_NOT_FOUND" && /does not exist/.test(error.message));

    const configs = mockFetch({ "/splits": () => json({ splits: [{ config: "default", split: "train" }] }) });
    await assert.rejects(importHuggingFaceDataset({ dataset: "a/b", config: "other" }, { fetchImpl: configs.fetchImpl }),
      (error: unknown) => error instanceof AppError && error.code === "HF_CONFIG_NOT_FOUND" && /default/.test(error.message));

    const gated = mockFetch({ "/rows": () => json({ error: "gated" }, 401) });
    await assert.rejects(importHuggingFaceDataset({ dataset: "a/b", config: "c", split: "d" }, { fetchImpl: gated.fetchImpl }),
      (error: unknown) => error instanceof AppError && error.code === "HF_ACCESS_DENIED" && /HF_TOKEN/.test(error.message));

    await assert.rejects(importHuggingFaceDataset({ dataset: "not a dataset id" }), /dataset ID/);
  });
});
