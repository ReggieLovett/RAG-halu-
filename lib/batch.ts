import { z } from "zod";
import { checkAnswer, type CheckOptions } from "./checker";
import { groqSettings, LIMITS } from "./config";
import { AppError, describeError } from "./errors";
import { zodDetails } from "./http";
import type { BatchItemResult, BatchReport, BatchSummary, CheckResult } from "./types";

const options = {
  strictnessMode: z.boolean().default(false),
  concurrency: z
    .number().int()
    .min(LIMITS.batchConcurrency.min)
    .max(LIMITS.batchConcurrency.max)
    .default(LIMITS.batchConcurrency.default),
};

/** Accepts `{ items, strictnessMode?, concurrency? }` or a bare array of items. */
export const batchRequestSchema = z
  .union([
    z.array(z.unknown()),
    z.object({ items: z.array(z.unknown()), ...options }),
  ])
  .transform((body) => (Array.isArray(body) ? { items: body, strictnessMode: false, concurrency: LIMITS.batchConcurrency.default } : body))
  .refine((body) => body.items.length >= 1 && body.items.length <= LIMITS.batchItems, `Send between 1 and ${LIMITS.batchItems} items.`);

/** Loose read of an item for reporting, even when it fails validation. */
function describeItem(raw: unknown, index: number) {
  const item = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const text = (value: unknown) => (typeof value === "string" ? value : "");
  const id = typeof item.id === "string" || typeof item.id === "number" ? String(item.id) : `item-${index + 1}`;
  return {
    index,
    id,
    question: text(item.question),
    answer: text(item.answer),
    ...(typeof item.source === "string" ? { source: item.source } : {}),
  };
}

/** Run `worker` over `items` with at most `limit` in flight; result order is preserved by index. */
export async function forEachConcurrent<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      await worker(items[index], index);
    }
  });
  await Promise.all(runners);
}

function mean(values: number[]): number | null {
  return values.length ? Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 100) / 100 : null;
}

export function summarizeBatch(results: BatchItemResult[]): BatchSummary {
  const checks: CheckResult[] = results.flatMap((item) => (item.status === "ok" ? [item.result] : []));
  const totalClaims = checks.reduce((sum, check) => sum + check.counts.total, 0);
  const supportedClaims = checks.reduce((sum, check) => sum + check.counts.supported, 0);
  const contradictedClaims = checks.reduce((sum, check) => sum + check.counts.contradicted, 0);
  return {
    totalItems: results.length,
    succeeded: checks.length,
    failed: results.length - checks.length,
    totalClaims,
    supportedClaims,
    contradictedClaims,
    unsupportedClaims: totalClaims - supportedClaims - contradictedClaims,
    overallFaithfulness: totalClaims ? Math.round((supportedClaims / totalClaims) * 10_000) / 100 : null,
    averageFaithfulness: mean(checks.flatMap((check) => (check.metrics.faithfulness === null ? [] : [check.metrics.faithfulness]))),
    averageAnswerRelevance: mean(checks.map((check) => check.metrics.answerRelevance)),
    averageContextRelevance: mean(checks.map((check) => check.metrics.contextRelevance)),
    itemsWithFailedClaims: checks.filter((check) => check.counts.contradicted + check.counts.unsupported > 0).length,
  };
}

export type BatchRunOptions = {
  signal?: AbortSignal;
  /** Injected in tests; defaults to the Groq-backed checker. */
  check?: (request: unknown, options: CheckOptions) => Promise<CheckResult>;
};

/**
 * Check every item through the verification engine with bounded concurrency.
 * Invalid or failed items are reported per item instead of failing the batch.
 */
export async function runBatchCheck(body: unknown, { signal, check = checkAnswer }: BatchRunOptions = {}): Promise<BatchReport> {
  const started = Date.now();
  const { items, strictnessMode, concurrency } = batchRequestSchema.parse(body);
  const results = new Array<BatchItemResult>(items.length);

  await forEachConcurrent(items, concurrency, async (raw, index) => {
    const base = describeItem(raw, index);
    if (signal?.aborted) {
      results[index] = { ...base, status: "error", error: { code: "REQUEST_CANCELLED", message: "The batch was cancelled before this item ran." } };
      return;
    }
    // Item-level options are ignored: the batch decides the strictness mode.
    const request = raw && typeof raw === "object" ? { ...raw, strictnessMode } : raw;
    try {
      const result = await check(request, { signal });
      results[index] = { ...base, status: "ok", result };
    } catch (error) {
      const failure = error instanceof z.ZodError
        ? { code: "INVALID_ITEM", message: zodDetails(error).map((issue) => `${issue.path || "item"}: ${issue.message}`).join("; ") }
        : describeError(error);
      results[index] = { ...base, status: "error", error: failure };
    }
  });

  if (signal?.aborted) throw new AppError(499, "REQUEST_CANCELLED", "The batch was cancelled.");
  return {
    createdAt: new Date(started).toISOString(),
    durationMs: Date.now() - started,
    strictnessMode,
    concurrency,
    model: groqSettings().checkerModel,
    summary: summarizeBatch(results),
    results,
  };
}
