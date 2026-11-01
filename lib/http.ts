import { z } from "zod";
import { AppError, isAbortError } from "./errors";
import type { ApiErrorBody } from "./types";

/** Read a JSON body without buffering more than `maxBytes`. */
export async function readJson(request: Request, maxBytes: number): Promise<unknown> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    throw new AppError(415, "UNSUPPORTED_MEDIA_TYPE", "Send the request body as application/json.");
  }
  const tooLarge = () =>
    new AppError(413, "BODY_TOO_LARGE", `Request body exceeds ${Math.round(maxBytes / 1024)} KiB.`);
  if (Number(request.headers.get("content-length") ?? 0) > maxBytes) throw tooLarge();
  if (!request.body) throw new AppError(400, "INVALID_JSON", "A JSON request body is required.");

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw tooLarge();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new AppError(400, "INVALID_JSON", "Request body is not valid JSON.");
  }
}

export function zodDetails(error: z.ZodError): NonNullable<ApiErrorBody["details"]> {
  return error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }));
}

export function errorResponse(error: unknown): Response {
  if (error instanceof z.ZodError) {
    const body: ApiErrorBody = { error: "Invalid request.", code: "INVALID_REQUEST", details: zodDetails(error) };
    return Response.json(body, { status: 400 });
  }
  if (error instanceof AppError) {
    const body: ApiErrorBody = { error: error.message, code: error.code };
    return Response.json(body, { status: error.status });
  }
  if (isAbortError(error)) {
    const body: ApiErrorBody = { error: "The request was cancelled.", code: "REQUEST_CANCELLED" };
    return Response.json(body, { status: 499 });
  }
  console.error("[api] unexpected error", error);
  const body: ApiErrorBody = { error: "Unexpected server error. Check the Next.js terminal for details.", code: "INTERNAL_ERROR" };
  return Response.json(body, { status: 500 });
}
