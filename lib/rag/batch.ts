import { z } from "zod";
import { retrievePassages } from "./chroma";
import { generateAnswer } from "./groq";
import { verifyAnswer } from "./verification";
import { RagError } from "./errors";
import type { Passage, VerificationResult } from "./types";

export const BATCH_LIMITS = { bytes: 1_048_576, items: 50, concurrency: 2 } as const;

const itemSchema = z.object({
  id: z.string().trim().min(1).max(128).optional(),
  question: z.string().trim().min(1).max(4_000),
  answer: z.string().trim().min(1).max(16_000).optional(),
  context: z.array(z.object({
    id: z.string().trim().min(1).max(256),
    text: z.string().trim().min(1).max(6_000),
    source: z.string().trim().min(1).max(2_000).optional(),
  }).strict()).max(10).optional(),
  topK: z.number().int().min(1).max(10).default(5),
}).strict().superRefine((item, ctx) => {
  if (item.context && new Set(item.context.map(p => p.id)).size !== item.context.length) {
    ctx.addIssue({ code: "custom", path: ["context"], message: "Passage IDs must be unique." });
  }
  if ((item.context?.reduce((n, p) => n + p.text.length, 0) ?? 0) > 24_000) {
    ctx.addIssue({ code: "custom", path: ["context"], message: "Context must be at most 24000 characters." });
  }
});

const envelopeSchema = z.object({
  items: z.array(z.unknown()).min(1).max(BATCH_LIMITS.items),
  concurrency: z.number().int().min(1).max(BATCH_LIMITS.concurrency).default(1),
}).strict();

export type BatchInput = z.infer<typeof envelopeSchema>;
export type BatchSuccess = {
  id: string;
  question: string;
  answer: string;
  context: Passage[];
  status: "verified" | "no_context";
  verification: VerificationResult;
};
export type BatchFailure = {
  id: string;
  question: string;
  status: "error" | "cancelled";
  error: { code: string; message: string };
};
export type BatchResult = BatchSuccess | BatchFailure;
export type BatchReport = {
  schemaVersion: 1;
  createdAt: string;
  durationMs: number;
  summary: {
    totalItems: number;
    verifiedItems: number;
    noContextItems: number;
    failedItems: number;
    cancelledItems: number;
    totalClaims: number;
    supportedClaims: number;
    contradictedClaims: number;
    unsupportedClaims: number;
    faithfulnessScore: number | null;
  };
  results: BatchResult[];
};

type Dependencies = {
  retrieve: typeof retrievePassages;
  generate: typeof generateAnswer;
  verify: typeof verifyAnswer;
};

/** Only the envelope is checked here; invalid individual rows become report errors. */
export function parseBatchInput(value: unknown): BatchInput {
  const parsed = envelopeSchema.safeParse(Array.isArray(value) ? { items: value } : value);
  if (!parsed.success) {
    throw new RagError(`Send {items: [...], concurrency?: 1 or 2} with 1 to ${BATCH_LIMITS.items} items.`, 400, "INVALID_BATCH");
  }
  return parsed.data;
}

export function parseBatchText(text: string, filename = "input.json"): BatchInput {
  if (Buffer.byteLength(text, "utf8") > BATCH_LIMITS.bytes) {
    throw new RagError("Batch file exceeds 1 MiB.", 413, "BATCH_TOO_LARGE");
  }
  const clean = text.replace(/^\uFEFF/, "").trim();
  if (!clean) throw new RagError("Batch file is empty.", 400, "INVALID_BATCH_FILE");
  if (/\.(jsonl|ndjson)$/i.test(filename)) {
    const lines = clean.split(/\r?\n/).filter(line => line.trim());
    if (lines.length > BATCH_LIMITS.items) {
      throw new RagError(`Batch files may contain at most ${BATCH_LIMITS.items} items.`, 400, "INVALID_BATCH");
    }
    const items = lines.map((line, index) => {
      try { return JSON.parse(line) as unknown; }
      catch { throw new RagError(`Invalid JSON on nonempty line ${index + 1}.`, 400, "INVALID_BATCH_FILE"); }
    });
    return parseBatchInput({ items });
  }
  let value: unknown;
  try { value = JSON.parse(clean); }
  catch { throw new RagError("Batch file must contain valid JSON or use a .jsonl extension for one object per line.", 400, "INVALID_BATCH_FILE"); }
  return parseBatchInput(value);
}

function identity(value: unknown, index: number): { id: string; question: string } {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    id: typeof record.id === "string" && record.id.trim() ? record.id.trim().slice(0, 128) : `row-${index + 1}`,
    question: typeof record.question === "string" ? record.question.trim().slice(0, 4_000) : "",
  };
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new RagError("Batch checking was cancelled.", 499, "REQUEST_ABORTED");
}

function safeFailure(error: unknown, cancelled: boolean): BatchFailure["error"] {
  if (cancelled) return { code: "REQUEST_ABORTED", message: "Batch checking was cancelled." };
  if (error instanceof z.ZodError) {
    const issue = error.issues[0];
    return { code: "INVALID_BATCH_ITEM", message: `Invalid item${issue ? ` at ${issue.path.join(".") || "row"}: ${issue.message}` : "."}` };
  }
  // Do not include arbitrary exception messages, upstream bodies, file paths, or prompts.
  if (error instanceof RagError) {
    const messages: Record<string, string> = {
      GROQ_RATE_LIMITED: "Groq is rate limited. Retry this item shortly.",
      GROQ_CONFIGURATION_ERROR: "Check GROQ_API_KEY and Groq settings in .env.local.",
      GROQ_TIMEOUT: "Groq timed out. Retry this item.",
      GROQ_UNAVAILABLE: "Could not reach Groq. Check the connection and retry.",
      CHROMA_UNAVAILABLE: "Could not reach local Chroma. Start it and retry.",
    };
    const code = /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code) ? error.code : "BATCH_ITEM_FAILED";
    return { code, message: messages[code] ?? "Could not check this item. Check the local database, Groq settings, and connection; then retry." };
  }
  return { code: "BATCH_ITEM_FAILED", message: "Could not check this item. Check the local database, Groq settings, and connection; then retry." };
}

function noContext(question: string, id: string): BatchSuccess {
  return {
    id, question, answer: "I don't have any relevant passages in the local knowledge base to answer this question.",
    context: [], status: "no_context",
    verification: {
      claims: [], faithfulnessScore: null, supportedClaims: 0,
      contradictedClaims: 0, unsupportedClaims: 0, totalClaims: 0,
    },
  };
}

/** A bounded worker pool keeps file order and preserves individual failures. */
export function createBatchChecker(dependencies: Dependencies) {
  return async (input: BatchInput, signal?: AbortSignal): Promise<BatchReport> => {
    const validated = parseBatchInput(input);
    const started = Date.now();
    const results = new Array<BatchResult>(validated.items.length);
    let cursor = 0;
    const worker = async () => {
      while (cursor < validated.items.length) {
        const index = cursor++;
        const raw = validated.items[index];
        const row = identity(raw, index);
        try {
          throwIfCancelled(signal);
          const item = itemSchema.parse(raw);
          const context: Passage[] = item.context !== undefined
            ? item.context.map(p => ({ ...p, source: p.source ?? p.id, metadata: {}, distance: null }))
            : await dependencies.retrieve(item.question, item.topK, signal);
          throwIfCancelled(signal);
          if (item.answer === undefined && !context.length) {
            results[index] = noContext(item.question, row.id);
            continue;
          }
          const answer = item.answer ?? await dependencies.generate(item.question, context, signal);
          throwIfCancelled(signal);
          const verification = await dependencies.verify(item.question, context, answer, signal);
          throwIfCancelled(signal);
          results[index] = { ...row, question: item.question, answer, context, verification, status: "verified" };
        } catch (error) {
          const cancelled = Boolean(signal?.aborted);
          results[index] = { ...row, status: cancelled ? "cancelled" : "error", error: safeFailure(error, cancelled) };
        }
      }
    };
    await Promise.all(Array.from({ length: validated.concurrency }, worker));
    const summary: BatchReport["summary"] = {
      totalItems: results.length, verifiedItems: 0, noContextItems: 0, failedItems: 0, cancelledItems: 0,
      totalClaims: 0, supportedClaims: 0, contradictedClaims: 0, unsupportedClaims: 0, faithfulnessScore: null,
    };
    for (const result of results) {
      if (!("verification" in result)) {
        if (result.status === "error") summary.failedItems++;
        else summary.cancelledItems++;
        continue;
      }
      if (result.status === "no_context") summary.noContextItems++;
      else summary.verifiedItems++;
      summary.totalClaims += result.verification.totalClaims;
      summary.supportedClaims += result.verification.supportedClaims;
      summary.contradictedClaims += result.verification.contradictedClaims;
      summary.unsupportedClaims += result.verification.unsupportedClaims;
    }
    summary.faithfulnessScore = summary.totalClaims ? Math.round(summary.supportedClaims / summary.totalClaims * 10_000) / 100 : null;
    return { schemaVersion: 1, createdAt: new Date().toISOString(), durationMs: Date.now() - started, summary, results };
  };
}

export const runBatch = createBatchChecker({ retrieve: retrievePassages, generate: generateAnswer, verify: verifyAnswer });

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  // Prevent spreadsheet formula evaluation, even after leading control/space characters.
  const safe = /^[\s\u0000-\u001f]*[=+@-]/.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
}

/** One CSV row per claim, with a row retained for errors and claim-free answers. */
export function batchReportCsv(report: BatchReport): string {
  const rows: unknown[][] = [["itemId", "question", "answer", "status", "itemFaithfulnessScore", "claimId", "claim", "verdict", "confidence", "evidence", "reason", "errorCode", "errorMessage"]];
  for (const result of report.results) {
    if (!("verification" in result)) {
      rows.push([result.id, result.question, "", result.status, "", "", "", "", "", "", "", result.error.code, result.error.message]);
      continue;
    }
    if (!result.verification.claims.length) {
      rows.push([result.id, result.question, result.answer, result.status, result.verification.faithfulnessScore, "", "", "", "", "", "", "", ""]);
    }
    for (const claim of result.verification.claims) {
      rows.push([result.id, result.question, result.answer, result.status, result.verification.faithfulnessScore,
        claim.id, claim.claim, claim.verdict, claim.confidence, JSON.stringify(claim.evidence), claim.reason, "", ""]);
    }
  }
  return `${rows.map(row => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

/** Read actual bytes before formData parsing so chunked uploads cannot bypass limits. */
export async function readBatchRequest(request: Request): Promise<BatchInput> {
  const type = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!type.startsWith("application/json") && !type.startsWith("multipart/form-data")) {
    throw new RagError("Send application/json or multipart/form-data with a file field.", 415, "INVALID_CONTENT_TYPE");
  }
  // Multipart framing gets a small fixed allowance; the uploaded file retains a 1 MiB limit.
  const maxBody = BATCH_LIMITS.bytes + (type.startsWith("multipart/") ? 16_384 : 0);
  if (Number(request.headers.get("content-length") || 0) > maxBody) throw new RagError("Batch upload exceeds 1 MiB.", 413, "BATCH_TOO_LARGE");
  if (!request.body) throw new RagError("A batch body is required.", 400, "INVALID_BATCH");
  const reader = request.body.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      throwIfCancelled(request.signal);
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxBody) {
        await reader.cancel();
        throw new RagError("Batch upload exceeds 1 MiB.", 413, "BATCH_TOO_LARGE");
      }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = Buffer.concat(chunks);
  if (type.startsWith("application/json")) return parseBatchText(bytes.toString("utf8"));
  let form: FormData;
  try {
    form = await new Request("http://127.0.0.1/batch-upload", { method: "POST", headers: { "content-type": request.headers.get("content-type")! }, body: bytes }).formData();
  } catch { throw new RagError("Invalid multipart batch upload.", 400, "INVALID_BATCH_FILE"); }
  const file = form.get("file");
  if (!file || typeof file === "string") throw new RagError("Choose a JSON or JSONL file in the file field.", 400, "INVALID_BATCH_FILE");
  if (file.size > BATCH_LIMITS.bytes) throw new RagError("Batch file exceeds 1 MiB.", 413, "BATCH_TOO_LARGE");
  if (!/\.(json|jsonl|ndjson)$/i.test(file.name)) throw new RagError("Choose a .json or .jsonl file.", 400, "INVALID_BATCH_FILE");
  const parsed = parseBatchText(await file.text(), file.name);
  const concurrency = form.get("concurrency");
  if (concurrency !== null) {
    if (typeof concurrency !== "string" || !/^[12]$/.test(concurrency)) throw new RagError("Concurrency must be 1 or 2.", 400, "INVALID_BATCH");
    parsed.concurrency = Number(concurrency);
  }
  return parsed;
}
