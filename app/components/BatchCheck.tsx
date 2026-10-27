"use client";

import { useState, type FormEvent } from "react";
import { apiErrorMessage } from "../../lib/rag/client-input";
import type { VerificationResult } from "../../lib/rag/types";
import { HighlightedAnswer, VerificationView, type DisplayPassage } from "./VerificationView";
import { useLocalRequest } from "./useLocalRequest";

type BatchSuccess = { id: string; question: string; status: "verified" | "no_context"; answer: string; context: DisplayPassage[]; verification: VerificationResult };
type BatchFailure = { id: string; question: string; status: "error" | "cancelled"; error: { code: string; message: string } };
type BatchReport = {
  schemaVersion: number; createdAt: string; durationMs: number;
  summary: { totalItems: number; verifiedItems: number; noContextItems: number; failedItems: number; cancelledItems: number; totalClaims: number; supportedClaims: number; contradictedClaims: number; unsupportedClaims: number; faithfulnessScore: number | null };
  results: (BatchSuccess | BatchFailure)[];
};
const maxFileBytes = 1024 * 1024;

function downloadJson(value: unknown, filename: string) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url; anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const sample = [
  { id: "supported-example", question: "Where is Paris?", answer: "Paris is in France.", context: [{ id: "p1", text: "Paris is located in France.", source: "Example passage" }] },
  { id: "mixed-example", question: "Where is Paris?", answer: "Paris is in France. Paris is in Germany. Paris has 100 airports.", context: [{ id: "p1", text: "Paris is located in France. Paris is not located in Germany.", source: "Example passage" }] }
];

export default function BatchCheck() {
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState("");
  const [report, setReport] = useState<BatchReport | null>(null);
  const request = useLocalRequest();

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (request.busy || !file) return;
    setError(""); setReport(null);
    if (!/\.(json|jsonl)$/i.test(file.name)) { setError("Choose a .json or .jsonl file."); return; }
    if (file.size === 0 || file.size > maxFileBytes) { setError("Choose a non-empty file no larger than 1 MiB."); return; }
    const current = request.begin();
    try {
      const form = new FormData(); form.append("file", file);
      const response = await fetch("/api/batch", { method: "POST", body: form, signal: current.signal });
      const data = await response.json();
      if (!response.ok) throw new Error(apiErrorMessage(data, "Batch checking could not finish."));
      if (!data.summary || !Array.isArray(data.results)) throw new Error("The server returned an invalid batch report.");
      if (request.isCurrent(current)) setReport(data);
    } catch (error) {
      if (request.isCurrent(current)) setError(error instanceof Error ? error.message : "Batch checking could not finish.");
    } finally { request.finish(current); }
  }

  return (
    <div className="workspace-view">
      <h1>Batch checker</h1>
      <p className="workspace-help">Upload up to 50 Q/A items in a JSON array, an object with an <code>items</code> array, or JSONL (one object per line). Maximum file size: 1 MiB.</p>
      <details className="claim-evidence"><summary>File format and example</summary><div className="evidence-content"><p>Each item needs <code>question</code>. Provide <code>answer</code> and <code>context</code> to check existing answers. Omit context to retrieve from Chroma; omit answer to generate an answer first. An explicit empty context array checks without evidence.</p><pre>{JSON.stringify(sample[0], null, 2)}</pre><button className="functional-button secondary" type="button" onClick={() => downloadJson(sample, "checker-example.json")}>Download example file</button></div></details>
      <form className="checker-form" onSubmit={submit} aria-busy={request.busy}>
        <label htmlFor="batch-file">Q/A file (.json or .jsonl)</label>
        <input id="batch-file" type="file" accept=".json,.jsonl,application/json,application/x-ndjson" disabled={request.busy} onChange={event => { setFile(event.target.files?.[0] ?? null); setError(""); setReport(null); }} />
        <div className="form-actions"><button className="functional-button" type="submit" disabled={!file || request.busy}>Run batch check</button>{request.busy ? <button className="functional-button secondary" type="button" onClick={() => { request.cancel(); setError("Batch request cancelled. No partial report was downloaded."); }}>Cancel batch</button> : null}</div>
        {request.busy ? <p role="status">Checking the file item by item. Large batches can take several minutes…</p> : null}
        {error ? <div className="error-message" role="alert">{error}</div> : null}
      </form>
      {report ? <section className="batch-report" aria-label="Batch report">
        <h2>Batch report</h2>
        <p role="status">{report.summary.totalItems} items · {report.summary.verifiedItems} verified · {report.summary.noContextItems} without context · {report.summary.failedItems} failed · {report.summary.cancelledItems} cancelled</p>
        <p><strong>Overall claim faithfulness: {report.summary.faithfulnessScore === null ? "N/A — no testable claims" : `${report.summary.faithfulnessScore}%`}</strong></p>
        <p className="workspace-help">{report.summary.supportedClaims} Supported · {report.summary.contradictedClaims} Contradicted · {report.summary.unsupportedClaims} Unsupported. Failed items are excluded from the score; review them below.</p>
        <button className="functional-button" type="button" onClick={() => downloadJson(report, "hallucination-check-report.json")}>Download JSON report</button>
        {report.results.map((item, index) => <details className="claim-evidence batch-item" key={`${item.id}-${index}`}><summary>{item.id}: {item.question} — {item.status}</summary><div className="evidence-content">{"verification" in item ? <><HighlightedAnswer answer={item.answer} verification={item.verification} /><VerificationView verification={item.verification} context={item.context} /></> : <p role="alert">{item.error.code}: {item.error.message}</p>}</div></details>)}
      </section> : null}
    </div>
  );
}
