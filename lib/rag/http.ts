import { z } from "zod";
import { RagError } from "./errors";

const question = z.string().trim().min(1).max(4000);
const topK = z.number().int().min(1).max(10).default(5);

export const ragRequestSchema = z.object({ question, topK }).strict();
export const chatRequestSchema = z.object({
  messages: z.array(z.object({
    role: z.enum(["user", "assistant"]),
    content: z.string().trim().min(1).max(8000)
  }).strict()).min(1).max(100),
  topK
}).strict().superRefine((body, ctx) => {
  const last = body.messages[body.messages.length - 1];
  if (!last) return;
  if (last.role !== "user") {
    ctx.addIssue({ code: "custom", path: ["messages"], message: "The final message must be from the user." });
  }
  if (last.content.length > 4000) {
    ctx.addIssue({ code: "custom", path: ["messages"], message: "The question must be at most 4000 characters." });
  }
});

export const verifyRequestSchema = z.object({
  question,
  answer: z.string().trim().min(1).max(16000),
  context: z.array(z.object({
    id: z.string().trim().min(1).max(256),
    text: z.string().trim().min(1).max(6000),
    source: z.string().trim().min(1).max(2000).optional()
  }).strict()).max(10)
}).strict().superRefine((body, ctx) => {
  if (new Set(body.context.map(passage => passage.id)).size !== body.context.length) {
    ctx.addIssue({ code: "custom", path: ["context"], message: "Passage IDs must be unique." });
  }
  if (body.context.reduce((sum, passage) => sum + passage.text.length, 0) > 24000) {
    ctx.addIssue({ code: "custom", path: ["context"], message: "Context must be at most 24000 characters in total." });
  }
});

export async function readJson(request: Request): Promise<unknown> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    throw new RagError("Send an application/json request body.", 415, "INVALID_CONTENT_TYPE");
  }
  const limit = 131072;
  if (Number(request.headers.get("content-length")) > limit) {
    throw new RagError("Request body exceeds 128 KiB.", 413, "BODY_TOO_LARGE");
  }
  if (!request.body) throw new RagError("A JSON body is required.", 400, "INVALID_JSON");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new RagError("Request body exceeds 128 KiB.", 413, "BODY_TOO_LARGE");
      }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new RagError("Request body must be valid JSON.", 400, "INVALID_JSON"); }
}

export function apiError(error: unknown): Response {
  if (error instanceof z.ZodError) {
    return Response.json({ error: "Invalid request.", code: "INVALID_REQUEST", details: error.issues.map(issue => ({
      path: issue.path.join("."), message: issue.message
    })) }, { status: 400 });
  }
  if (error instanceof RagError) {
    return Response.json({ error: error.message, code: error.code }, { status: error.status });
  }
  if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
    return Response.json({ error: "The request was cancelled or timed out.", code: "REQUEST_TIMEOUT" }, { status: 504 });
  }
  return Response.json({ error: "The local RAG backend could not complete this request.", code: "INTERNAL_ERROR" }, { status: 500 });
}
