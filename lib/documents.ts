import mammoth from "mammoth";
import { chunkText, normalizeText, stableHash } from "./chunking";
import { deleteRecords, queryCollection, upsertRecords } from "./chroma";
import { chromaSettings, LIMITS } from "./config";
import { AppError } from "./errors";
import type { RetrievedChunk, UploadedDocument } from "./types";

export type FileType = UploadedDocument["fileType"];
export type ParsedDocument = { fileType: FileType; text: string; pages: number | null };

function startsWith(bytes: Uint8Array, signature: number[], offset = 0): boolean {
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

const PDF_SIGNATURE = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"
const ZIP_SIGNATURE = [0x50, 0x4b, 0x03, 0x04]; // DOCX files are ZIP archives

function looksLikePdf(bytes: Uint8Array): boolean {
  // The PDF header may follow up to 1 KiB of junk.
  const limit = Math.min(bytes.length - PDF_SIGNATURE.length, 1024);
  for (let offset = 0; offset <= limit; offset++) {
    if (startsWith(bytes, PDF_SIGNATURE, offset)) return true;
  }
  return false;
}

/** Decide the parser from the extension and confirm it with the file's magic bytes. */
export function detectFileType(fileName: string, bytes: Uint8Array): FileType {
  const extension = fileName.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  if (extension === "pdf" || (!extension && looksLikePdf(bytes))) {
    if (!looksLikePdf(bytes)) throw new AppError(422, "INVALID_PDF", `"${fileName}" is not a valid PDF file.`);
    return "pdf";
  }
  if (extension === "docx") {
    if (!startsWith(bytes, ZIP_SIGNATURE)) throw new AppError(422, "INVALID_DOCX", `"${fileName}" is not a valid DOCX file.`);
    return "docx";
  }
  if (extension === "doc") {
    throw new AppError(415, "UNSUPPORTED_FILE_TYPE", "Legacy .doc files are not supported. Save the file as .docx or PDF and upload it again.");
  }
  throw new AppError(415, "UNSUPPORTED_FILE_TYPE", "Upload a PDF (.pdf) or Word (.docx) document.");
}

/** Rejoin words that PDF layout hyphenated across lines ("hallu-\ncination"). */
function dehyphenate(text: string): string {
  return text.replace(/([a-z])-[ \t]*\n[ \t]*([a-z])/g, "$1$2");
}

async function parsePdf(bytes: Uint8Array): Promise<ParsedDocument> {
  const { PDFParse, PasswordException, InvalidPDFException, FormatError } = await import("pdf-parse");
  // pdf.js may detach the buffer it is given, so hand it a copy.
  const parser = new PDFParse({ data: new Uint8Array(bytes), verbosity: 0 });
  try {
    const result = await parser.getText();
    return {
      fileType: "pdf",
      text: dehyphenate(result.pages.map((page) => page.text).join("\n\n")),
      pages: result.total,
    };
  } catch (error) {
    if (error instanceof PasswordException || (error as Error)?.name === "PasswordException") {
      throw new AppError(422, "PDF_PASSWORD_PROTECTED", "This PDF is password-protected. Remove the password and upload it again.");
    }
    if (error instanceof InvalidPDFException || error instanceof FormatError) {
      throw new AppError(422, "PDF_UNREADABLE", "This PDF is damaged or malformed, so its text could not be read.");
    }
    console.error("[upload] pdf-parse failed", error);
    throw new AppError(422, "PDF_PARSE_FAILED", "Could not extract text from this PDF.");
  } finally {
    await parser.destroy().catch(() => undefined);
  }
}

async function parseDocx(bytes: Uint8Array): Promise<ParsedDocument> {
  try {
    const result = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
    return { fileType: "docx", text: result.value, pages: null };
  } catch (error) {
    console.error("[upload] mammoth failed", error);
    throw new AppError(422, "DOCX_UNREADABLE", "Could not read this DOCX file. It may be damaged, password-protected, or not a Word document.");
  }
}

export async function extractDocumentText(fileName: string, bytes: Uint8Array): Promise<ParsedDocument> {
  if (bytes.byteLength === 0) throw new AppError(400, "EMPTY_FILE", "The uploaded file is empty.");
  if (bytes.byteLength > LIMITS.uploadBytes) {
    throw new AppError(413, "FILE_TOO_LARGE", `Files must be ${LIMITS.uploadBytes / 1024 / 1024} MB or smaller.`);
  }
  const fileType = detectFileType(fileName, bytes);
  const parsed = fileType === "pdf" ? await parsePdf(bytes) : await parseDocx(bytes);
  const text = normalizeText(parsed.text);
  if (!text) {
    throw new AppError(422, "NO_EXTRACTABLE_TEXT", fileType === "pdf"
      ? "No text could be extracted. The PDF may be a scanned image; run OCR on it or upload a text-based PDF or DOCX."
      : "This document contains no text.");
  }
  if (text.length > LIMITS.documentCharacters) {
    throw new AppError(413, "DOCUMENT_TOO_LONG", `The extracted text exceeds ${LIMITS.documentCharacters.toLocaleString("en-US")} characters.`);
  }
  return { ...parsed, text };
}

function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop()?.trim() || "document";
  return base.replace(/[\u0000-\u001f]/g, "").slice(0, 200);
}

/** Parse, chunk, embed (Chroma default embeddings), and store a document. */
export async function ingestDocument(fileName: string, bytes: Uint8Array, signal?: AbortSignal): Promise<UploadedDocument> {
  const name = safeFileName(fileName);
  const parsed = await extractDocumentText(name, bytes);
  // Identical text gets the same ID, so re-uploading a file replaces its chunks.
  const documentId = `doc_${stableHash(parsed.text, 16)}`;
  const chunks = chunkText(parsed.text);
  const { documentsCollection } = chromaSettings();
  const uploadedAt = new Date().toISOString();

  await deleteRecords(documentsCollection, { documentId }, signal);
  await upsertRecords(documentsCollection, chunks.map((chunk, chunkIndex) => ({
    id: `${documentId}:${chunkIndex}`,
    document: chunk,
    metadata: { documentId, fileName: name, fileType: parsed.fileType, chunkIndex, chunkCount: chunks.length, uploadedAt },
  })), signal);

  return {
    documentId,
    fileName: name,
    fileType: parsed.fileType,
    pages: parsed.pages,
    characters: parsed.text.length,
    chunks: chunks.length,
    collection: documentsCollection,
    preview: parsed.text.slice(0, 600),
  };
}

/** Top-K chunks of one document for a question, most similar first. */
export async function retrieveChunks(
  documentId: string,
  question: string,
  topK: number,
  signal?: AbortSignal,
): Promise<{ fileName: string; chunks: RetrievedChunk[] }> {
  const { documentsCollection } = chromaSettings();
  const matches = await queryCollection(documentsCollection, question, { nResults: topK, where: { documentId } }, signal);
  if (matches.length === 0) {
    throw new AppError(404, "DOCUMENT_NOT_FOUND", "This document is not in ChromaDB (it may have been deleted). Upload it again.");
  }
  return {
    fileName: String(matches[0].metadata.fileName ?? "document"),
    chunks: matches.map((match) => ({
      id: match.id,
      chunkIndex: Number(match.metadata.chunkIndex ?? -1),
      text: match.document,
      distance: match.distance === null ? null : Math.round(match.distance * 10_000) / 10_000,
    })),
  };
}
