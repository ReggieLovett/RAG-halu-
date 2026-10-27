import assert from "node:assert/strict";
import test from "node:test";
import { chunkId, chunkText, normalizeDocument } from "../lib/rag/chunking";
import { chromaSettings, validateCollection, type IngestedChunk } from "../lib/rag/chroma";
import { EMBEDDING_DIMENSIONS, EMBEDDING_DTYPE, EMBEDDING_MODEL, EMBEDDING_REVISION, EMBEDDING_VERSION } from "../lib/rag/embeddings";
import { fetchDatasetPage, ingestHuggingFaceDataset, ingestionConfig, type HuggingFaceConfig } from "../lib/rag/huggingface";
import { RagError } from "../lib/rag/errors";

const config = (overrides: Partial<HuggingFaceConfig> = {}): HuggingFaceConfig => ({
  ...ingestionConfig({}), maxRows: 105, ...overrides,
});

function datasetFetch(totalRows: number, textForRow = (index: number) => `Context ${index}.`) {
  const calls: { offset: number; length: number }[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "https://datasets-server.huggingface.co");
    const offset = Number(url.searchParams.get("offset"));
    const length = Number(url.searchParams.get("length"));
    calls.push({ offset, length });
    return Response.json({
      rows: Array.from({ length: Math.min(length, Math.max(0, totalRows - offset)) }, (_, index) => ({
        row_idx: offset + index,
        row: { context: textForRow(offset + index), title: "Test" },
        truncated_cells: [],
      })),
      num_rows_total: totalRows,
      partial: false,
    });
  };
  return { fetchImpl, calls };
}

const embed = async (texts: string[]) => texts.map(() => Array(EMBEDDING_DIMENSIONS).fill(1 / Math.sqrt(EMBEDDING_DIMENSIONS)) as number[]);

test("overlapping chunks preserve the complete text, bounds and final suffix", () => {
  const text = "abcdefghijklmnopqrstuvwxyz0123456789".repeat(100);
  const chunks = chunkText(text, 120, 20);
  assert.ok(chunks.every((chunk) => chunk.length <= 120));
  assert.equal(chunks[0] + chunks.slice(1).map((chunk) => chunk.slice(20)).join(""), text);
  assert.equal(normalizeDocument("  One\t two.\r\nThree.  "), "One two.\nThree.");
  assert.deepEqual(chunkText("  "), []);
  assert.throws(() => chunkText(text, 120, 120));
});

test("stable IDs deduplicate normalized contexts and isolate datasets/chunk indexes", () => {
  assert.equal(chunkId("squad", "One   two.\r\nThree.", 0), chunkId("squad", "One two.\nThree.", 0));
  assert.notEqual(chunkId("squad", "Context", 0), chunkId("other", "Context", 0));
  assert.notEqual(chunkId("squad", "Context", 0), chunkId("squad", "Context", 1));
});

test("ingestion paginates at 100, limits rows, deduplicates contexts, and reruns idempotently", async () => {
  const { fetchImpl, calls } = datasetFetch(300, (index) => `Shared context ${Math.floor(index / 3)}.`);
  const records = new Map<string, IngestedChunk>();
  const upsert = async (chunks: IngestedChunk[]) => { chunks.forEach((chunk) => records.set(chunk.id, chunk)); };
  const first = await ingestHuggingFaceDataset(config(), { fetchImpl, embed, upsert });
  assert.deepEqual(calls, [{ offset: 0, length: 100 }, { offset: 100, length: 5 }]);
  assert.equal(first.rowsRead, 105);
  assert.equal(first.nextOffset, 105);
  assert.equal(first.uniqueDocuments, 35);
  assert.equal(records.size, 35);
  const firstIds = Array.from(records.keys()).sort();
  await ingestHuggingFaceDataset(config(), { fetchImpl, embed, upsert });
  assert.equal(records.size, 35);
  assert.deepEqual(Array.from(records.keys()).sort(), firstIds);
});

test("resume offsets bound the requested range and stop at the dataset end", async () => {
  const { fetchImpl, calls } = datasetFetch(108);
  const result = await ingestHuggingFaceDataset(config({ startOffset: 105, maxRows: 20 }), {
    fetchImpl, embed, upsert: async () => {},
  });
  assert.deepEqual(calls, [{ offset: 105, length: 20 }]);
  assert.equal(result.rowsRead, 3);
  assert.equal(result.nextOffset, 108);
});

test("a failed page never advances the checkpoint; replay preserves earlier upserts", async () => {
  const { fetchImpl } = datasetFetch(6);
  const records = new Map<string, IngestedChunk>();
  const checkpoints: number[] = [];
  let writes = 0;
  const upsert = async (chunks: IngestedChunk[]) => {
    writes++;
    if (writes === 2) throw new Error("Simulated connection loss");
    chunks.forEach((chunk) => records.set(chunk.id, chunk));
  };
  await assert.rejects(ingestHuggingFaceDataset(config({ maxRows: 6, batchSize: 2 }), {
    fetchImpl, embed, upsert, onProgress: (progress) => { checkpoints.push(progress.nextOffset); },
  }), /Simulated connection loss/);
  assert.equal(records.size, 2);
  assert.deepEqual(checkpoints, [0]);
  await ingestHuggingFaceDataset(config({ maxRows: 6, batchSize: 2 }), { fetchImpl, embed, upsert });
  assert.equal(records.size, 6);
});

test("missing, non-string, truncated and incomplete HF text fail explicitly", async () => {
  const cases = [
    { row: { title: "Missing context" }, truncated_cells: [], code: "HF_INVALID_TEXT_FIELD" },
    { row: { context: 123 }, truncated_cells: [], code: "HF_INVALID_TEXT_FIELD" },
    { row: { context: "Partial" }, truncated_cells: ["context"], code: "HF_TRUNCATED_ROW" },
  ];
  for (const entry of cases) {
    await assert.rejects(fetchDatasetPage(config(), 0, 1, {
      fetchImpl: async () => Response.json({ rows: [{ row_idx: 0, ...entry }], num_rows_total: 1 }),
    }), (error: unknown) => error instanceof RagError && error.code === entry.code);
  }
  await assert.rejects(fetchDatasetPage(config(), 0, 2, {
    fetchImpl: async () => Response.json({ rows: [], num_rows_total: 2 }),
  }), (error: unknown) => error instanceof RagError && error.code === "HF_INVALID_PAGE");
});

test("HF errors do not silently create an empty ingestion", async () => {
  let calls = 0;
  await assert.rejects(fetchDatasetPage(config(), 0, 1, {
    fetchImpl: async () => { calls++; return new Response("Forbidden", { status: 403 }); },
  }), (error: unknown) => error instanceof RagError && error.code === "HF_FETCH_FAILED");
  assert.equal(calls, 1, "permanent HTTP failures are not retried");
  await assert.rejects(fetchDatasetPage(config(), 0, 101), /between 1 and 100/);
});

test("transient Hugging Face failures retry and then ingest a valid page", async () => {
  const good = datasetFetch(1);
  let calls = 0;
  const result = await fetchDatasetPage(config(), 0, 1, {
    fetchImpl: async (...args) => ++calls === 1 ? new Response("Busy", { status: 503 }) : good.fetchImpl(...args),
  });
  assert.equal(calls, 2);
  assert.equal(result.rows.length, 1);
});

test("collection validation refuses mismatched embedding revision, dimensions or cosine space", () => {
  const collection = {
    metadata: {
      embedding_model: EMBEDDING_MODEL, embedding_revision: EMBEDDING_REVISION,
      embedding_dimensions: EMBEDDING_DIMENSIONS, embedding_dtype: EMBEDDING_DTYPE,
      embedding_version: EMBEDDING_VERSION, distance_metric: "cosine",
    },
    configuration: { hnsw: { space: "cosine" as const } },
  };
  assert.doesNotThrow(() => validateCollection(collection));
  assert.throws(() => validateCollection({ ...collection, metadata: { ...collection.metadata, embedding_revision: "other" } }), /embedding_revision/);
  assert.throws(() => validateCollection({ ...collection, metadata: { ...collection.metadata, embedding_dimensions: 1536 } }), /embedding_dimensions/);
  assert.throws(() => validateCollection({ ...collection, configuration: { hnsw: { space: "l2" } } }), /cosine/);
});

test("local database config and ingestion budgets reject unsafe or invalid settings", () => {
  const oldHost = process.env.CHROMA_HOST;
  try {
    process.env.CHROMA_HOST = "example.com";
    assert.throws(() => chromaSettings(), /loopback/);
    process.env.CHROMA_HOST = "::1";
    assert.equal(chromaSettings().host, "[::1]");
  } finally {
    if (oldHost === undefined) delete process.env.CHROMA_HOST;
    else process.env.CHROMA_HOST = oldHost;
  }
  assert.throws(() => ingestionConfig({ HF_BATCH_SIZE: "0" }), /HF_BATCH_SIZE/);
  assert.throws(() => ingestionConfig({ HF_MAX_ROWS: "100001" }), /HF_MAX_ROWS/);
  assert.throws(() => ingestionConfig({ HF_START_OFFSET: "-1" }), /HF_START_OFFSET/);
  assert.throws(() => ingestionConfig({ HF_CHUNK_SIZE: "100", HF_CHUNK_OVERLAP: "100" }), /HF_CHUNK_OVERLAP/);
});
