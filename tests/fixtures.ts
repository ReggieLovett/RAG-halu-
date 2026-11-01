import JSZip from "jszip";
import type { CheckResult } from "../lib/types";

/** A minimal one-page PDF with correct xref offsets; `lines` are drawn with Helvetica. */
export function buildPdf(lines: string[]): Uint8Array {
  const escape = (text: string) => text.replace(/[\\()]/g, (char) => `\\${char}`);
  const stream = lines.length
    ? `BT /F1 12 Tf 72 720 Td 14 TL ${lines.map((line) => `(${escape(line)}) Tj T*`).join(" ")} ET`
    : "";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(body);
}

/** A minimal DOCX (WordprocessingML in a ZIP) with one paragraph per entry. */
export async function buildDocx(paragraphs: string[]): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file("_rels/.rels", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  const body = paragraphs.map((text) => `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`).join("");
  zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`);
  return zip.generateAsync({ type: "uint8array" });
}

export function checkResult(overrides: Partial<CheckResult> & Pick<CheckResult, "claims">): CheckResult {
  const supported = overrides.claims.filter((claim) => claim.verdict === "Supported").length;
  const contradicted = overrides.claims.filter((claim) => claim.verdict === "Contradicted").length;
  const total = overrides.claims.length;
  return {
    question: "Q?",
    answer: "A.",
    contextCharacters: 10,
    strictnessMode: false,
    supportThreshold: null,
    counts: { total, supported, contradicted, unsupported: total - supported - contradicted },
    metrics: {
      faithfulness: total ? Math.round((supported / total) * 10_000) / 100 : null,
      answerRelevance: 80,
      answerRelevanceReason: "",
      contextRelevance: 60,
      contextRelevanceReason: "",
    },
    model: "test-model",
    durationMs: 1,
    ...overrides,
  };
}
