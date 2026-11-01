import { z } from "zod";
import { chunkText, stableHash } from "./chunking";
import { upsertRecords, type ChromaRecord } from "./chroma";
import { chromaSettings, LIMITS } from "./config";
import { AppError, cancelledError, describeError } from "./errors";
import type { BatchItem, HfEmbeddingSummary, HfImportResponse } from "./types";

const DATASETS_SERVER = "https://datasets-server.huggingface.co";

// Empty strings from blank form inputs mean "not set".
const optionalText = z.string().trim().max(200).optional().transform((value) => value || undefined);

export const hfImportSchema = z.object({
  dataset: z.string().trim().max(200).regex(/^[A-Za-z0-9][\w.-]*(?:\/[\w.-]+)?$/, 'Use a dataset ID such as "rajpurkar/squad".'),
  config: optionalText,
  split: optionalText,
  offset: z.number().int().min(0).max(100_000_000).default(0),
  limit: z.number().int().min(1).max(LIMITS.hfRows.max).default(LIMITS.hfRows.default),
  /** Column names or paths such as "answers.text.0"; detected when omitted. */
  questionField: optionalText,
  answerField: optionalText,
  contextField: optionalText,
  embed: z.boolean().default(true),
});

type FieldKind = "question" | "answer" | "context";

/** Column names tried, in order, when a field is not given explicitly. */
export const FIELD_CANDIDATES: Record<FieldKind, string[]> = {
  question: ["question", "query", "questions", "prompt", "input", "instruction", "user_input"],
  answer: ["answer", "response", "generated_answer", "output", "answers", "right_answer", "ground_truth", "reference", "completion", "target"],
  context: ["context", "contexts", "knowledge", "documents", "document", "passage", "passages", "retrieved_contexts", "evidence", "reference_contexts", "search_results", "text"],
};

export function detectField(kind: FieldKind, columns: string[], explicit?: string): string {
  if (explicit) {
    const root = explicit.split(/[.[]/)[0];
    if (!columns.includes(root)) {
      throw new AppError(422, "HF_FIELD_NOT_FOUND", `Column "${root}" is not in this dataset. Available columns: ${columns.join(", ")}.`);
    }
    return explicit;
  }
  const byLowerCase = new Map(columns.map((column) => [column.toLowerCase(), column]));
  for (const candidate of FIELD_CANDIDATES[kind]) {
    const column = byLowerCase.get(candidate);
    if (column) return column;
  }
  throw new AppError(422, "HF_FIELD_NOT_FOUND", `Could not detect the ${kind} column. Available columns: ${columns.join(", ")}. Set the ${kind} field explicitly.`);
}

/** Resolve "answers.text.0" or "answers.text[0]"; a name on an array maps over its elements. */
export function getPath(value: unknown, path: string): unknown {
  return path.replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean).reduce<unknown>((current, key) => {
    if (Array.isArray(current)) {
      return /^\d+$/.test(key) ? current[Number(key)] : current.map((entry) => getPath(entry, key));
    }
    if (current && typeof current === "object") return (current as Record<string, unknown>)[key];
    return undefined;
  }, value);
}

const TEXT_KEYS = ["text", "content", "passage_text", "passage", "context", "sentences", "answer", "value"];

/** Flatten strings, arrays, and {text: ...}-style objects into a list of texts. */
export function collectText(value: unknown, depth = 0): string[] {
  if (depth > 6 || value === null || value === undefined) return [];
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  if (typeof value === "number" || typeof value === "boolean") return [String(value)];
  if (Array.isArray(value)) return value.flatMap((entry) => collectText(entry, depth + 1));
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const key = TEXT_KEYS.find((candidate) => candidate in record);
    if (key) return collectText(record[key], depth + 1);
  }
  return [];
}

export type ImporterDependencies = {
  fetchImpl?: typeof fetch;
  upsert?: typeof upsertRecords;
  signal?: AbortSignal;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchJson(path: string, params: Record<string, string | number>, { fetchImpl = fetch, signal }: ImporterDependencies): Promise<unknown> {
  const url = new URL(path, DATASETS_SERVER);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  const token = process.env.HF_TOKEN?.trim();

  for (let attempt = 1; attempt <= 3; attempt++) {
    if (signal?.aborted) throw cancelledError();
    const timeout = AbortSignal.timeout(20_000);
    let response: Response;
    try {
      response = await fetchImpl(url, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        cache: "no-store",
      });
    } catch {
      if (signal?.aborted) throw cancelledError();
      if (attempt === 3) {
        throw timeout.aborted
          ? new AppError(504, "HF_TIMEOUT", "The Hugging Face dataset viewer did not respond within 20 s. Try again.")
          : new AppError(502, "HF_UNREACHABLE", "Could not reach the Hugging Face dataset viewer. Check your internet connection.");
      }
      await sleep(500 * attempt);
      continue;
    }
    if (response.ok) return response.json();

    const body = await response.json().catch(() => null) as { error?: unknown } | null;
    const detail = typeof body?.error === "string" ? body.error.slice(0, 300) : `HTTP ${response.status}`;
    if ([429, 500, 502, 503, 504].includes(response.status) && attempt < 3) {
      await sleep(1_000 * attempt);
      continue;
    }
    if (response.status === 401 || response.status === 403) {
      // The viewer answers 401 for missing datasets too, so cover both causes.
      throw new AppError(403, "HF_ACCESS_DENIED", `Hugging Face could not open this dataset: ${detail} Check the dataset ID; if it is gated or private, accept its terms on huggingface.co and set HF_TOKEN in .env.local.`);
    }
    if (response.status === 404) throw new AppError(404, "HF_NOT_FOUND", `Hugging Face: ${detail}`);
    throw new AppError(502, "HF_REQUEST_FAILED", `The Hugging Face dataset viewer failed: ${detail}`);
  }
  throw new AppError(502, "HF_REQUEST_FAILED", "The Hugging Face dataset viewer failed.");
}

/** Use the given config/split, otherwise pick the first config and prefer test > validation > train. */
async function resolveConfigAndSplit(
  dataset: string,
  config: string | undefined,
  split: string | undefined,
  deps: ImporterDependencies,
): Promise<{ config: string; split: string }> {
  if (config && split) return { config, split };
  const body = await fetchJson("/splits", { dataset }, deps) as { splits?: { config?: unknown; split?: unknown }[] };
  const splits = (body.splits ?? []).flatMap((entry) =>
    typeof entry.config === "string" && typeof entry.split === "string" ? [{ config: entry.config, split: entry.split }] : []);
  const configs = Array.from(new Set(splits.map((entry) => entry.config)));
  const chosenConfig = config ?? configs[0];
  if (!chosenConfig || !configs.includes(chosenConfig)) {
    throw new AppError(404, "HF_CONFIG_NOT_FOUND", configs.length
      ? `Config "${config}" was not found. Available configs: ${configs.join(", ")}.`
      : "The dataset viewer lists no configs or splits for this dataset.");
  }
  const available = splits.filter((entry) => entry.config === chosenConfig).map((entry) => entry.split);
  if (split) {
    if (!available.includes(split)) {
      throw new AppError(404, "HF_SPLIT_NOT_FOUND", `Split "${split}" was not found in config "${chosenConfig}". Available splits: ${available.join(", ")}.`);
    }
    return { config: chosenConfig, split };
  }
  return { config: chosenConfig, split: ["test", "validation", "train"].find((name) => available.includes(name)) ?? available[0] };
}

type RowsPage = {
  features?: { name?: unknown }[];
  rows?: { row_idx?: unknown; row?: unknown; truncated_cells?: unknown }[];
  num_rows_total?: unknown;
};

/**
 * Fetch rows from the Hugging Face dataset viewer, map them to Q/A/Context
 * batch items, and embed the unique contexts into Chroma with the default
 * embedding function. Embedding failures are reported without discarding the items.
 */
export async function importHuggingFaceDataset(body: unknown, deps: ImporterDependencies = {}): Promise<HfImportResponse> {
  const started = Date.now();
  const request = hfImportSchema.parse(body);
  const { config, split } = await resolveConfigAndSplit(request.dataset, request.config, request.split, deps);
  const page = await fetchJson("/rows", {
    dataset: request.dataset, config, split, offset: request.offset, length: request.limit,
  }, deps) as RowsPage;

  const rows = Array.isArray(page.rows) ? page.rows : [];
  const columns = (page.features ?? []).flatMap((feature) => (typeof feature.name === "string" ? [feature.name] : []));
  if (columns.length === 0 && rows[0]?.row && typeof rows[0].row === "object") columns.push(...Object.keys(rows[0].row));
  if (rows.length === 0) {
    throw new AppError(404, "HF_NO_ROWS", `No rows found at offset ${request.offset} of ${request.dataset} (${config}/${split}).`);
  }

  const fields = {
    question: detectField("question", columns, request.questionField),
    answer: detectField("answer", columns, request.answerField),
    context: detectField("context", columns, request.contextField),
  };
  if (new Set(Object.values(fields)).size < 3) {
    throw new AppError(422, "HF_FIELD_CONFLICT", `Question, answer, and context must use different columns (detected ${JSON.stringify(fields)}). Set the fields explicitly.`);
  }
  const fieldRoots = Object.values(fields).map((field) => field.split(/[.[]/)[0]);

  const items: BatchItem[] = [];
  const skipped: HfImportResponse["skipped"] = [];
  const shortName = request.dataset.split("/").pop();
  for (const [position, entry] of rows.entries()) {
    const rowIndex = typeof entry.row_idx === "number" ? entry.row_idx : request.offset + position;
    const truncated = Array.isArray(entry.truncated_cells) ? entry.truncated_cells.map(String) : [];
    if (truncated.some((cell) => fieldRoots.includes(cell))) {
      skipped.push({ rowIndex, reason: "The dataset viewer truncated this row's text, so it cannot be checked faithfully." });
      continue;
    }
    const question = collectText(getPath(entry.row, fields.question)).join(" ");
    const answer = collectText(getPath(entry.row, fields.answer))[0] ?? "";
    const context = collectText(getPath(entry.row, fields.context)).join("\n\n");
    const problem = !question ? `empty ${fields.question}`
      : !answer ? `empty ${fields.answer}`
        : !context ? `empty ${fields.context}`
          : question.length > LIMITS.questionCharacters ? "question is too long"
            : answer.length > LIMITS.answerCharacters ? "answer is too long"
              : context.length > LIMITS.contextCharacters ? "context is too long"
                : null;
    if (problem) {
      skipped.push({ rowIndex, reason: problem });
      continue;
    }
    items.push({
      id: `${shortName}-${split}-${rowIndex}`,
      question,
      answer,
      context,
      source: `https://huggingface.co/datasets/${request.dataset}/viewer/${encodeURIComponent(config)}/${encodeURIComponent(split)}?row=${rowIndex}`,
    });
  }

  const { hfCollection } = chromaSettings();
  let embedding: HfEmbeddingSummary = { status: "skipped", collection: hfCollection };
  if (request.embed && items.length > 0) {
    const records: ChromaRecord[] = [];
    const seen = new Set<string>();
    for (const item of items) {
      const context = item.context as string;
      const contextHash = stableHash(context, 32);
      if (seen.has(contextHash)) continue; // SQuAD-style datasets repeat contexts
      seen.add(contextHash);
      chunkText(context).forEach((chunk, chunkIndex) => records.push({
        id: `hf_${stableHash(`${request.dataset}|${config}|${split}|${contextHash}|${chunkIndex}`, 32)}`,
        document: chunk,
        metadata: { dataset: request.dataset, config, split, itemId: item.id ?? "", contextHash, chunkIndex, source: item.source ?? "" },
      }));
    }
    try {
      const upserted = await (deps.upsert ?? upsertRecords)(hfCollection, records, deps.signal);
      embedding = { status: "ok", collection: hfCollection, uniqueContexts: seen.size, chunksUpserted: upserted };
    } catch (error) {
      if (deps.signal?.aborted) throw cancelledError();
      embedding = { status: "failed", collection: hfCollection, ...describeError(error) };
    }
  }

  return {
    dataset: request.dataset,
    config,
    split,
    offset: request.offset,
    rowsFetched: rows.length,
    totalRows: typeof page.num_rows_total === "number" ? page.num_rows_total : null,
    fields,
    items,
    skipped,
    embedding,
    durationMs: Date.now() - started,
  };
}
