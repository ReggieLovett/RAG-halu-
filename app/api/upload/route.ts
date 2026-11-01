import { LIMITS } from "../../../lib/config";
import { ingestDocument } from "../../../lib/documents";
import { AppError } from "../../../lib/errors";
import { errorResponse } from "../../../lib/http";

// First use downloads the embedding model; large PDFs take a while to embed.
export const maxDuration = 300;

/** multipart/form-data with a "file" field (PDF or DOCX) → UploadedDocument */
export async function POST(request: Request): Promise<Response> {
  try {
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("multipart/form-data")) {
      throw new AppError(415, "UNSUPPORTED_MEDIA_TYPE", 'Send the document as multipart/form-data in a field named "file".');
    }
    // Reject oversized uploads before buffering them.
    if (Number(request.headers.get("content-length") ?? 0) > LIMITS.uploadBytes + 64 * 1024) {
      throw new AppError(413, "FILE_TOO_LARGE", `Files must be ${LIMITS.uploadBytes / 1024 / 1024} MB or smaller.`);
    }
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      throw new AppError(400, "INVALID_FORM_DATA", "The upload could not be read as multipart form data.");
    }
    const file = form.get("file");
    if (!(file instanceof File)) {
      throw new AppError(400, "FILE_REQUIRED", 'Attach a PDF or DOCX file in the "file" field.');
    }
    const document = await ingestDocument(file.name, new Uint8Array(await file.arrayBuffer()), request.signal);
    return Response.json(document, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
