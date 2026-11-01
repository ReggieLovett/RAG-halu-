import { runBatchCheck } from "../../../lib/batch";
import { errorResponse, readJson } from "../../../lib/http";

export const maxDuration = 800;

/**
 * { items: [{ id?, question, answer, context }], strictnessMode?, concurrency? }
 * or a bare array of items → BatchReport. Per-item failures are reported in
 * `results`; only an invalid envelope fails the whole request.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const body = await readJson(request, 10 * 1024 * 1024);
    return Response.json(await runBatchCheck(body, { signal: request.signal }));
  } catch (error) {
    return errorResponse(error);
  }
}
