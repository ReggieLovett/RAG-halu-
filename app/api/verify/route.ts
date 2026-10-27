import { apiError, readJson, verifyRequestSchema } from "../../../lib/rag/http";
import { verifyAnswer } from "../../../lib/rag/verification";
import type { Passage } from "../../../lib/rag/types";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const { question, context, answer } = verifyRequestSchema.parse(await readJson(request));
    const passages: Passage[] = context.map(passage => ({
      ...passage, source: passage.source ?? passage.id, metadata: {}, distance: null
    }));
    const verification = await verifyAnswer(question, passages, answer, request.signal);
    return Response.json({ question, answer, verification });
  } catch (error) { return apiError(error); }
}
