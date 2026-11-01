import { checkAnswer } from "../../../lib/checker";
import { errorResponse, readJson } from "../../../lib/http";

export const maxDuration = 180;

/** { question, context, answer, strictnessMode? } → CheckResult */
export async function POST(request: Request): Promise<Response> {
  try {
    const body = await readJson(request, 512 * 1024);
    return Response.json(await checkAnswer(body, { signal: request.signal }));
  } catch (error) {
    return errorResponse(error);
  }
}
