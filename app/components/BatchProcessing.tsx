"use client";

import { useEffect, useState, type ChangeEvent } from "react";
import { errorMessage, postJson } from "../../lib/api-client";
import { parseBatchJson } from "../../lib/batch-file";
import { LIMITS } from "../../lib/config";
import { auditReportFileName, batchReportToCsv, downloadCsv } from "../../lib/export";
import type { BatchCheckRequest, BatchItem, BatchReport } from "../../lib/types";
import { CheckResultView, formatScore, plural, VerdictLabel, VerdictLegend } from "./CheckResultView";
import { useElapsedSeconds, useRequest } from "./hooks";

export type LoadedItems = { items: BatchItem[]; source: string };

function contextPreview(context: string | string[]): string {
  const joined = Array.isArray(context) ? context.join(" ") : context;
  return joined.length > 160 ? `${joined.slice(0, 160)}…` : joined;
}

/** Items arrive from Hugging Face import (via the page) or a local JSON file. */
export default function BatchProcessing({
  hidden,
  loaded,
  onLoad,
}: {
  hidden: boolean;
  loaded: LoadedItems | null;
  onLoad: (loaded: LoadedItems) => void;
}) {
  const [fileError, setFileError] = useState("");
  const [strictnessMode, setStrictnessMode] = useState(false);
  const [concurrency, setConcurrency] = useState<number>(LIMITS.batchConcurrency.default);
  const [report, setReport] = useState<BatchReport | null>(null);
  const [runError, setRunError] = useState("");
  const batchRequest = useRequest();
  const batchSeconds = useElapsedSeconds(batchRequest.busy);

  // A new set of items makes the previous report stale.
  useEffect(() => setReport(null), [loaded]);

  async function handleFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    setFileError("");
    if (!file) return;
    try {
      const items = parseBatchJson(await file.text(), LIMITS.batchItems);
      onLoad({ items, source: `local file ${file.name}` });
    } catch (error) {
      setFileError(errorMessage(error));
    }
  }

  async function handleRun() {
    if (!loaded) return;
    setRunError("");
    setReport(null);
    try {
      const body: BatchCheckRequest = { items: loaded.items, strictnessMode, concurrency };
      setReport(await batchRequest.run((signal) => postJson<BatchReport>("/api/batch-check", body, signal)));
    } catch (error) {
      setRunError(errorMessage(error));
    }
  }

  const summary = report?.summary;

  return (
    <section data-mode="batch" hidden={hidden} aria-labelledby="batch-heading">
      <header>
        <h1 id="batch-heading">Batch check</h1>
        <p>
          Check up to {LIMITS.batchItems} question/answer/context items at once and download the CSV audit report.
          Load items from a JSON file here, or from Hugging Face import.
        </p>
      </header>

      <fieldset disabled={batchRequest.busy}>
        <legend>Local batch file</legend>
        <p>
          <label htmlFor="batch-file">Batch JSON file</label>
          <br />
          <input id="batch-file" type="file" accept=".json,application/json" onChange={handleFile} />
          <br />
          <small>
            Format: <code>[{"{"}&quot;question&quot;: &quot;…&quot;, &quot;answer&quot;: &quot;…&quot;, &quot;context&quot;: &quot;…&quot;{"}"}]</code> or{" "}
            <code>{"{"}&quot;items&quot;: [...]{"}"}</code>. Example: <code>examples/batch-input.json</code>.
          </small>
        </p>
      </fieldset>
      {fileError ? <p role="alert">Could not load the file: {fileError}</p> : null}

      <h3>Batch queue</h3>
      {loaded ? (
        <details>
          <summary>{plural(loaded.items.length, "item")} loaded from {loaded.source}</summary>
          <ol>
            {loaded.items.map((item, index) => (
              <li key={`${item.id ?? ""}-${index}`}>
                <strong>{item.question}</strong>
                <br />
                Answer: {item.answer}
                <br />
                <small>Context: {contextPreview(item.context)}</small>
              </li>
            ))}
          </ol>
        </details>
      ) : (
        <p>No items loaded. Choose a JSON file above, or import rows in Hugging Face import.</p>
      )}

      <fieldset disabled={batchRequest.busy}>
        <legend>Run</legend>
        <p>
          <label>
            <input type="checkbox" checked={strictnessMode} onChange={(event) => setStrictnessMode(event.target.checked)} /> Healthcare
            Strictness Mode
          </label>{" "}
          <label>
            Concurrency{" "}
            <input
              type="number"
              min={LIMITS.batchConcurrency.min}
              max={LIMITS.batchConcurrency.max}
              value={concurrency}
              onChange={(event) => setConcurrency(Number(event.target.value))}
            />
          </label>
        </p>
      </fieldset>
      <p>
        <button type="button" data-role="primary" onClick={handleRun} disabled={!loaded || batchRequest.busy}>
          Run batch check{loaded ? ` (${plural(loaded.items.length, "item")})` : ""}
        </button>{" "}
        <button type="button" onClick={batchRequest.cancel} disabled={!batchRequest.busy}>Cancel</button>{" "}
        <button type="button" disabled={!report} onClick={() => report && downloadCsv(batchReportToCsv(report), auditReportFileName(report))}>
          Download CSV Audit Report
        </button>
      </p>
      {batchRequest.busy ? <p role="status">Checking {plural(loaded?.items.length ?? 0, "item")} with Groq… {batchSeconds} s</p> : null}
      {runError ? <p role="alert">Batch check failed: {runError}</p> : null}

      {report && summary ? (
        <article aria-label="Batch report">
          <h3>Batch summary</h3>
          <dl>
            <dt>Items</dt>
            <dd>{summary.totalItems} total · {summary.succeeded} checked · {summary.failed} failed</dd>
            <dt>Overall faithfulness</dt>
            <dd>{formatScore(summary.overallFaithfulness, "%")} ({summary.supportedClaims} of {summary.totalClaims} claims supported)</dd>
            <dt>Average faithfulness per item</dt>
            <dd>{formatScore(summary.averageFaithfulness, "%")}</dd>
            <dt>Average answer relevance</dt>
            <dd>{formatScore(summary.averageAnswerRelevance, "/100")}</dd>
            <dt>Average context relevance</dt>
            <dd>{formatScore(summary.averageContextRelevance, "/100")}</dd>
            <dt>Claims</dt>
            <dd>
              <VerdictLabel verdict="Supported" />: {summary.supportedClaims} · <VerdictLabel verdict="Contradicted" />: {summary.contradictedClaims} ·{" "}
              <VerdictLabel verdict="Unsupported" />: {summary.unsupportedClaims}
            </dd>
            <dt>Items with failed claims</dt>
            <dd>{summary.itemsWithFailedClaims}</dd>
            <dt>Run</dt>
            <dd>
              {report.strictnessMode ? "Healthcare Strictness" : "Standard"} mode · concurrency {report.concurrency} · {report.model} ·{" "}
              {(report.durationMs / 1000).toFixed(1)} s
            </dd>
          </dl>
          <VerdictLegend />

          <h3>Results</h3>
          <table>
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">ID</th>
                <th scope="col">Question</th>
                <th scope="col">Faithfulness</th>
                <th scope="col">Answer relevance</th>
                <th scope="col">Context relevance</th>
                <th scope="col">Claims</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {report.results.map((item) => (
                <tr key={item.index} data-status={item.status}>
                  <td>{item.index + 1}</td>
                  <td>{item.id}</td>
                  <td>{item.question}</td>
                  {item.status === "ok" ? (
                    <>
                      <td>{formatScore(item.result.metrics.faithfulness, "%")}</td>
                      <td>{item.result.metrics.answerRelevance}</td>
                      <td>{item.result.metrics.contextRelevance}</td>
                      <td>
                        <span aria-hidden="true">🟢</span> {item.result.counts.supported} supported,{" "}
                        <span aria-hidden="true">🔴</span> {item.result.counts.contradicted} contradicted,{" "}
                        <span aria-hidden="true">🟡</span> {item.result.counts.unsupported} unsupported
                      </td>
                      <td>OK</td>
                    </>
                  ) : (
                    <>
                      <td>—</td>
                      <td>—</td>
                      <td>—</td>
                      <td>—</td>
                      <td>
                        Error {item.error.code}: {item.error.message}
                      </td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>

          <h3>Item details</h3>
          {report.results.map((item) =>
            item.status === "ok" ? (
              <details key={item.index}>
                <summary>
                  #{item.index + 1} {item.id}: {item.question}
                </summary>
                {item.source ? (
                  <p>
                    Source: <a href={item.source} target="_blank" rel="noreferrer">{item.source}</a>
                  </p>
                ) : null}
                <CheckResultView result={item.result} />
              </details>
            ) : null,
          )}
        </article>
      ) : null}
    </section>
  );
}
