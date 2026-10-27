import { apiError, ragRequestSchema, readJson } from "../../../lib/rag/http";
import { runRag } from "../../../lib/rag/pipeline";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const { question, topK } = ragRequestSchema.parse(await readJson(request));
    return Response.json(await runRag(question, topK, request.signal));
  } catch (error) { return apiError(error); }
}
