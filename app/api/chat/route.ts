import { apiError, chatRequestSchema, readJson } from "../../../lib/rag/http";
import { runRag } from "../../../lib/rag/pipeline";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const { messages, topK } = chatRequestSchema.parse(await readJson(request));
    const question = messages[messages.length - 1].content;
    return Response.json(await runRag(question, topK, request.signal));
  } catch (error) { return apiError(error); }
}
