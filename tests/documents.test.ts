import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { detectFileType, extractDocumentText } from "../lib/documents";
import { AppError } from "../lib/errors";
import { buildDocx, buildPdf } from "./fixtures";

const failsWith = (code: string) => (error: unknown) => error instanceof AppError && error.code === code;

describe("detectFileType", () => {
  const pdf = new TextEncoder().encode("%PDF-1.7\n...");
  const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0]);

  it("requires the extension and magic bytes to agree", () => {
    assert.equal(detectFileType("paper.PDF", pdf), "pdf");
    assert.equal(detectFileType("paper.docx", zip), "docx");
    assert.equal(detectFileType("no-extension", pdf), "pdf");
    assert.throws(() => detectFileType("fake.pdf", zip), failsWith("INVALID_PDF"));
    assert.throws(() => detectFileType("fake.docx", pdf), failsWith("INVALID_DOCX"));
    assert.throws(() => detectFileType("old.doc", zip), failsWith("UNSUPPORTED_FILE_TYPE"));
    assert.throws(() => detectFileType("notes.txt", pdf), failsWith("UNSUPPORTED_FILE_TYPE"));
  });
});

describe("extractDocumentText", () => {
  it("extracts text from a PDF with pdf-parse", async () => {
    const parsed = await extractDocumentText("study.pdf", buildPdf(["Hallucination checkers verify claims.", "Groq answers quickly."]));
    assert.equal(parsed.fileType, "pdf");
    assert.equal(parsed.pages, 1);
    assert.match(parsed.text, /Hallucination checkers verify claims\./);
    assert.match(parsed.text, /Groq answers quickly\./);
  });

  it("extracts text from a DOCX with mammoth", async () => {
    const parsed = await extractDocumentText("study.docx", await buildDocx(["Paris is the capital of France.", "It has many museums."]));
    assert.deepEqual(parsed, { fileType: "docx", text: "Paris is the capital of France.\n\nIt has many museums.", pages: null });
  });

  it("rejects empty, image-only, and corrupt files with clear errors", async () => {
    await assert.rejects(extractDocumentText("empty.pdf", new Uint8Array()), failsWith("EMPTY_FILE"));
    await assert.rejects(extractDocumentText("scan.pdf", buildPdf([])), failsWith("NO_EXTRACTABLE_TEXT"));
    await assert.rejects(
      extractDocumentText("broken.pdf", new TextEncoder().encode("%PDF-1.4\nthis is not really a pdf")),
      (error: unknown) => error instanceof AppError && error.status === 422 && error.code.startsWith("PDF_"),
    );
    await assert.rejects(
      extractDocumentText("broken.docx", new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3])),
      failsWith("DOCX_UNREADABLE"),
    );
  });
});
