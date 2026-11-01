import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AUDIT_CSV_COLUMNS, auditReportFileName, batchReportToCsv, csvCell } from "../lib/export";
import type { BatchReport, ClaimCheck } from "../lib/types";
import { checkResult } from "./fixtures";

function claim(verdict: ClaimCheck["verdict"], text: string): ClaimCheck {
  return { id: text, claim: text, verdict, modelVerdict: verdict, evidence: "", evidenceFound: false, literalMatch: null, confidence: 1, reasoning: "", adjustments: [] };
}

/** Minimal RFC 4180 parser for asserting round trips. */
function parseCsv(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < csv.length; i++) {
    const char = csv[i];
    if (quoted) {
      if (char === '"' && csv[i + 1] === '"') { cell += '"'; i++; } else if (char === '"') quoted = false; else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") { row.push(cell); cell = ""; } else if (char === "\r" && csv[i + 1] === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; i++; } else cell += char;
  }
  return rows;
}

const report: BatchReport = {
  createdAt: "2026-11-01T10:20:30.400Z",
  durationMs: 10,
  strictnessMode: false,
  concurrency: 2,
  model: "test-model",
  summary: {
    totalItems: 3, succeeded: 2, failed: 1, totalClaims: 3, supportedClaims: 1, contradictedClaims: 1, unsupportedClaims: 1,
    overallFaithfulness: 33.33, averageFaithfulness: 50, averageAnswerRelevance: 80, averageContextRelevance: 60, itemsWithFailedClaims: 1,
  },
  results: [
    {
      index: 0, id: "q1", status: "ok", question: "Where, exactly?", answer: 'Paris, "the capital".\nAlso Berlin.',
      result: checkResult({
        question: "Where, exactly?",
        answer: 'Paris, "the capital".\nAlso Berlin.',
        claims: [claim("Supported", "Paris is the capital."), claim("Contradicted", "Berlin is in France."), claim("Unsupported", "=SUM(A1)")],
      }),
    },
    { index: 1, id: "q2", status: "ok", question: "Hi?", answer: "Hello.", result: checkResult({ question: "Hi?", answer: "Hello.", claims: [] }) },
    { index: 2, id: "q3", status: "error", question: "Slow?", answer: "x", error: { code: "GROQ_TIMEOUT", message: "Groq did not respond." } },
  ],
};

describe("batchReportToCsv", () => {
  it("writes the audit columns and one row per item", () => {
    const rows = parseCsv(batchReportToCsv(report));
    assert.deepEqual(rows[0], [...AUDIT_CSV_COLUMNS]);
    assert.equal(rows.length, 4);
    assert.deepEqual(rows[1].slice(0, 6), ["q1", "Where, exactly?", 'Paris, "the capital".\nAlso Berlin.', "33.33", "80", "60"]);
    assert.equal(rows[1][6], "[Contradicted] Berlin is in France.\n[Unsupported] =SUM(A1)");
    assert.equal(rows[1][7], "OK");
    assert.deepEqual(rows[2].slice(3, 8), ["N/A", "80", "60", "", "OK"]);
    assert.deepEqual(rows[3].slice(3, 8), ["", "", "", "", "ERROR GROQ_TIMEOUT: Groq did not respond."]);
  });

  it("quotes special characters and neutralizes spreadsheet formulas", () => {
    assert.equal(csvCell('a "b", c'), '"a ""b"", c"');
    assert.equal(csvCell("=HYPERLINK(1)"), "'=HYPERLINK(1)");
    assert.equal(csvCell("@cmd"), "'@cmd");
    assert.equal(csvCell(-1), "-1");
    assert.equal(csvCell(null), "");
  });

  it("names the file after the report timestamp", () => {
    assert.equal(auditReportFileName(report), "hallucination-audit-2026-11-01T10-20-30-400Z.csv");
  });
});
