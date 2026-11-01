import { LIMITS } from "../../../lib/config";
import { ingestDocument } from "../../../lib/documents";
import { errorResponse, readFormFile } from "../../../lib/http";

// First use downloads the embedding model; large PDFs take a while to embed.
export const maxDuration = 300;

/** multipart/form-data with a "file" field (PDF or DOCX) → UploadedDocument */
export async function POST(request: Request): Promise<Response> {
  try {
    const { name, bytes } = await readFormFile(request, LIMITS.uploadBytes);
    return Response.json(await ingestDocument(name, bytes, request.signal), { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
