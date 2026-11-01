import { errorResponse, readJson } from "../../../lib/http";
import { importHuggingFaceDataset } from "../../../lib/huggingface-importer";

export const maxDuration = 300;

/**
 * { dataset, config?, split?, offset?, limit?, questionField?, answerField?,
 *   contextField?, embed? } → HfImportResponse. `items` can be posted as-is
 * to /api/batch-check.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const body = await readJson(request, 16 * 1024);
    return Response.json(await importHuggingFaceDataset(body, { signal: request.signal }));
  } catch (error) {
    return errorResponse(error);
  }
}
