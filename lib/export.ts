// CSV audit export for /api/batch-check reports. Client-safe (used by the dashboard).
import type { BatchItemResult, BatchReport } from "./types";

export const AUDIT_CSV_COLUMNS = [
  "ID",
  "Question",
  "Answer",
  "Faithfulness (%)",
  "Answer Relevance",
  "Context Relevance",
  "Failed Claims",
  "Status",
] as const;

/** RFC 4180 quoting, plus a guard against spreadsheet formula injection. */
export function csvCell(value: string | number | null): string {
  if (value === null) return "";
  if (typeof value === "number") return String(value);
  const text = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Contradicted and Unsupported claims, one per line within the cell. */
export function failedClaimsText(item: BatchItemResult): string {
  if (item.status !== "ok") return "";
  return item.result.claims
    .filter((claim) => claim.verdict !== "Supported")
    .map((claim) => `[${claim.verdict}] ${claim.claim}`)
    .join("\n");
}

function auditRow(item: BatchItemResult): (string | number | null)[] {
  if (item.status === "error") {
    return [item.id, item.question, item.answer, null, null, null, "", `ERROR ${item.error.code}: ${item.error.message}`];
  }
  const { metrics } = item.result;
  return [
    item.id,
    item.result.question,
    item.result.answer,
    metrics.faithfulness ?? "N/A",
    metrics.answerRelevance,
    metrics.contextRelevance,
    failedClaimsText(item),
    "OK",
  ];
}

/** Convert a batch report into the CSV Audit Report (one row per item). */
export function batchReportToCsv(report: BatchReport): string {
  const rows = [Array.from(AUDIT_CSV_COLUMNS), ...report.results.map(auditRow)];
  return `${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

export function auditReportFileName(report: Pick<BatchReport, "createdAt">): string {
  return `hallucination-audit-${report.createdAt.replace(/[:.]/g, "-")}.csv`;
}

/** Browser-only: save the CSV. A UTF-8 BOM lets Excel detect the encoding. */
export function downloadCsv(csv: string, fileName: string): void {
  const url = URL.createObjectURL(new Blob(["﻿", csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
