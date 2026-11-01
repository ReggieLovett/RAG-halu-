import { LIMITS } from "../../../lib/config";
import { extractDocumentText, safeFileName } from "../../../lib/documents";
import { errorResponse, readFormFile } from "../../../lib/http";
import type { ExtractedDocument } from "../../../lib/types";

export const maxDuration = 120;

/**
 * multipart/form-data with a "file" field (PDF or DOCX) → ExtractedDocument.
 * Only extracts text, for the checker's context; nothing is stored in Chroma.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const { name, bytes } = await readFormFile(request, LIMITS.uploadBytes);
    const fileName = safeFileName(name);
    const parsed = await extractDocumentText(fileName, bytes);
    const body: ExtractedDocument = {
      fileName,
      fileType: parsed.fileType,
      pages: parsed.pages,
      characters: parsed.text.length,
      text: parsed.text,
    };
    return Response.json(body);
  } catch (error) {
    return errorResponse(error);
  }
}
