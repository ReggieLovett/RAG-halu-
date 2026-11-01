import { answerChat } from "../../../lib/chatbot";
import { errorResponse, readJson } from "../../../lib/http";

export const maxDuration = 120;

/** { documentId?, messages: [{ role, content }], topK? } → ChatResponse */
export async function POST(request: Request): Promise<Response> {
  try {
    const body = await readJson(request, 1024 * 1024);
    return Response.json(await answerChat(body, request.signal));
  } catch (error) {
    return errorResponse(error);
  }
}
