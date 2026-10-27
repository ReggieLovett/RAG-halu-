import { chunkId, chunkText, DEFAULT_CHUNK_OVERLAP, DEFAULT_CHUNK_SIZE, normalizeDocument, stableHash } from "./chunking";
import { upsertChunks, type IngestedChunk } from "./chroma";
import { embedTexts } from "./embeddings";
import { RagError } from "./errors";

export type HuggingFaceConfig = {
  dataset: string;
  config: string;
  split: string;
  textField: string;
  titleField: string;
  startOffset: number;
  maxRows: number;
  batchSize: number;
  chunkSize: number;
  chunkOverlap: number;
  token?: string;
};

export type DatasetRow = {
  rowIndex: number;
  text: string;
  title: string;
};

export type IngestionProgress = {
  rowsRead: number;
  uniqueDocuments: number;
  chunksUpserted: number;
  nextOffset: number;
  totalRows: number | null;
};

function integerSetting(env: Record<string, string | undefined>, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  const value = raw === undefined || raw === "" ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RagError(`${name} must be an integer between ${min} and ${max}.`, 400, "INVALID_INGESTION_CONFIG");
  }
  return value;
}

export function ingestionConfig(env: Record<string, string | undefined> = process.env): HuggingFaceConfig {
  const chunkSize = integerSetting(env, "HF_CHUNK_SIZE", DEFAULT_CHUNK_SIZE, 32, 1200);
  const chunkOverlap = integerSetting(env, "HF_CHUNK_OVERLAP", DEFAULT_CHUNK_OVERLAP, 0, chunkSize - 1);
  const config = {
    dataset: env.HF_DATASET || "rajpurkar/squad",
    config: env.HF_CONFIG || "plain_text",
    split: env.HF_SPLIT || "train",
    textField: env.HF_TEXT_FIELD || "context",
    titleField: env.HF_TITLE_FIELD || "title",
    startOffset: integerSetting(env, "HF_START_OFFSET", 0, 0, 10_000_000),
    maxRows: integerSetting(env, "HF_MAX_ROWS", 1000, 1, 100_000),
    batchSize: integerSetting(env, "HF_BATCH_SIZE", 32, 1, 64),
    chunkSize,
    chunkOverlap,
    token: env.HF_TOKEN || undefined,
  };
  for (const [key, value] of Object.entries(config)) {
    if (typeof value === "string" && key !== "token" && (!value.trim() || value.length > 256)) {
      throw new RagError(`Invalid Hugging Face setting: ${key}.`, 400, "INVALID_INGESTION_CONFIG");
    }
  }
  return config;
}

type FetchOptions = { fetchImpl?: typeof fetch; signal?: AbortSignal };
type DatasetPage = { rows: DatasetRow[]; totalRows: number };

/** Fetch one validated, complete page. This API supports at most 100 rows. */
export async function fetchDatasetPage(
  config: HuggingFaceConfig,
  offset: number,
  length: number,
  { fetchImpl = fetch, signal }: FetchOptions = {},
): Promise<DatasetPage> {
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(length) || length < 1 || length > 100) {
    throw new RagError("Hugging Face page length must be between 1 and 100 and offset nonnegative.", 400, "INVALID_HF_PAGE");
  }
  const url = new URL("https://datasets-server.huggingface.co/rows");
  for (const [key, value] of Object.entries({ dataset: config.dataset, config: config.config, split: config.split, offset, length })) {
    url.searchParams.set(key, String(value));
  }
  let body: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    signal?.throwIfAborted();
    const timeout = AbortSignal.timeout(20_000);
    let response: Response;
    try {
      response = await fetchImpl(url, {
        headers: config.token ? { Authorization: `Bearer ${config.token}` } : {},
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        cache: "no-store",
        redirect: "error",
      });
      if (response.ok) {
        body = await response.json();
        break;
      }
      if (![429, 500, 502, 503, 504].includes(response.status)) {
        throw new RagError(
          `Hugging Face rows request failed with HTTP ${response.status} at offset ${offset}. Check dataset/config/split, viewer availability, and HF_TOKEN for gated datasets.`,
          502,
          "HF_FETCH_FAILED",
        );
      }
      if (attempt === 2) {
        throw new RagError(`Hugging Face is unavailable (HTTP ${response.status}) at offset ${offset}; rerun this range later.`, 502, "HF_FETCH_FAILED");
      }
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (error instanceof RagError) throw error;
      if (attempt === 2) {
        throw new RagError(`Could not download or parse Hugging Face rows at offset ${offset}; check connectivity and rerun this range.`, 502, "HF_FETCH_FAILED");
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
  }
  if (!body || typeof body !== "object") throw invalidPage(offset);
  const page = body as Record<string, unknown>;
  if (!Array.isArray(page.rows) || !Number.isSafeInteger(page.num_rows_total) || Number(page.num_rows_total) < 0) throw invalidPage(offset);
  if (page.partial === true) {
    throw new RagError(`Hugging Face returned a partial dataset at offset ${offset}; retry after viewer processing finishes.`, 502, "HF_PARTIAL_DATASET");
  }
  const totalRows = Number(page.num_rows_total);
  const expectedLength = Math.min(length, Math.max(0, totalRows - offset));
  if (page.rows.length !== expectedLength) throw invalidPage(offset);
  const rows = page.rows.map((value: unknown, index: number): DatasetRow => {
    if (!value || typeof value !== "object") throw invalidPage(offset + index);
    const entry = value as Record<string, unknown>;
    if (entry.row_idx !== offset + index || !entry.row || typeof entry.row !== "object" || Array.isArray(entry.row)) throw invalidPage(offset + index);
    if (!Array.isArray(entry.truncated_cells) || entry.truncated_cells.length > 0) {
      throw new RagError(`Hugging Face row ${offset + index} contains truncated or invalid cells. Use a dataset with complete text in the /rows API.`, 502, "HF_TRUNCATED_ROW");
    }
    const row = entry.row as Record<string, unknown>;
    const text = row[config.textField];
    const title = row[config.titleField];
    if (typeof text !== "string" || !text.trim()) {
      throw new RagError(`Hugging Face row ${offset + index} has no nonempty string field '${config.textField}'. Set HF_TEXT_FIELD to the correct column.`, 502, "HF_INVALID_TEXT_FIELD");
    }
    if (title !== undefined && title !== null && typeof title !== "string") {
      throw new RagError(`Hugging Face row ${offset + index} has a non-string title field '${config.titleField}'. Set HF_TITLE_FIELD to a text column.`, 502, "HF_INVALID_TITLE_FIELD");
    }
    return { rowIndex: offset + index, text: normalizeDocument(text), title: typeof title === "string" ? title : "" };
  });
  return { rows, totalRows };
}

function invalidPage(offset: number): RagError {
  return new RagError(`Hugging Face returned an incomplete or invalid rows page at offset ${offset}; no rows from this page were ingested.`, 502, "HF_INVALID_PAGE");
}

type IngestionDependencies = FetchOptions & {
  embed?: typeof embedTexts;
  upsert?: typeof upsertChunks;
  onProgress?: (progress: IngestionProgress) => void | Promise<void>;
};

export async function ingestHuggingFaceDataset(
  config: HuggingFaceConfig,
  { embed = embedTexts, upsert = upsertChunks, onProgress, ...fetchOptions }: IngestionDependencies = {},
): Promise<IngestionProgress> {
  const seenDocuments = new Set<string>();
  const progress: IngestionProgress = {
    rowsRead: 0, uniqueDocuments: 0, chunksUpserted: 0,
    nextOffset: config.startOffset, totalRows: null,
  };
  await onProgress?.({ ...progress });
  // Chunking settings are part of the namespace so IDs never overwrite different
  // chunks when a caller selects a different chunk size.
  const namespace = JSON.stringify([config.dataset, config.config, config.split, config.textField, config.chunkSize, config.chunkOverlap]);
  while (progress.rowsRead < config.maxRows) {
    fetchOptions.signal?.throwIfAborted();
    const page = await fetchDatasetPage(config, progress.nextOffset, Math.min(100, config.maxRows - progress.rowsRead), fetchOptions);
    progress.totalRows = page.totalRows;
    if (page.rows.length === 0) {
      await onProgress?.({ ...progress });
      break;
    }
    let pending: IngestedChunk[] = [];
    const flush = async () => {
      if (pending.length === 0) return;
      const embeddings = await embed(pending.map((chunk) => chunk.text), fetchOptions.signal);
      await upsert(pending, embeddings, fetchOptions.signal);
      progress.chunksUpserted += pending.length;
      pending = [];
    };
    for (const row of page.rows) {
      const hash = stableHash(row.text);
      if (seenDocuments.has(hash)) continue;
      seenDocuments.add(hash);
      progress.uniqueDocuments++;
      const source = `https://huggingface.co/datasets/${config.dataset}/viewer/${encodeURIComponent(config.config)}/${encodeURIComponent(config.split)}?row=${row.rowIndex}`;
      const chunks = chunkText(row.text, config.chunkSize, config.chunkOverlap);
      for (let index = 0; index < chunks.length; index++) {
        pending.push({
          id: chunkId(namespace, row.text, index),
          text: chunks[index],
          metadata: {
            source, title: row.title, dataset: config.dataset, config: config.config,
            split: config.split, text_field: config.textField, context_hash: hash,
            row_index: row.rowIndex, chunk_index: index,
          },
        });
        if (pending.length >= config.batchSize) await flush();
      }
    }
    await flush();
    // A checkpoint advances only after every chunk of the complete page was
    // persisted. Replaying a partly completed page is safe because upsert IDs are stable.
    progress.rowsRead += page.rows.length;
    progress.nextOffset += page.rows.length;
    await onProgress?.({ ...progress });
    if (progress.nextOffset >= page.totalRows) break;
  }
  return progress;
}
