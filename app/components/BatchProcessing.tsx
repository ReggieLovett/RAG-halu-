"use client";

import { useState, type ChangeEvent, type FormEvent } from "react";
import { errorMessage, postJson } from "../../lib/api-client";
import { parseBatchJson } from "../../lib/batch-file";
import { LIMITS } from "../../lib/config";
import { auditReportFileName, batchReportToCsv, downloadCsv } from "../../lib/export";
import type { BatchCheckRequest, BatchItem, BatchReport, HfImportRequest, HfImportResponse } from "../../lib/types";
import { CheckResultView, formatScore, plural, VerdictLabel, VerdictLegend } from "./CheckResultView";
import { useElapsedSeconds, useRequest } from "./hooks";

type LoadedItems = { items: BatchItem[]; source: string };

function text(form: FormData, name: string): string | undefined {
  const value = form.get(name);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function contextPreview(context: string | string[]): string {
  const joined = Array.isArray(context) ? context.join(" ") : context;
  return joined.length > 160 ? `${joined.slice(0, 160)}…` : joined;
}

export default function BatchProcessing() {
  const [loaded, setLoaded] = useState<LoadedItems | null>(null);
  const [importResult, setImportResult] = useState<HfImportResponse | null>(null);
  const [importError, setImportError] = useState("");
  const [fileError, setFileError] = useState("");
  const [strictnessMode, setStrictnessMode] = useState(false);
  const [concurrency, setConcurrency] = useState<number>(LIMITS.batchConcurrency.default);
  const [report, setReport] = useState<BatchReport | null>(null);
  const [runError, setRunError] = useState("");
  const importRequest = useRequest();
  const batchRequest = useRequest();
  const importSeconds = useElapsedSeconds(importRequest.busy);
  const batchSeconds = useElapsedSeconds(batchRequest.busy);

  async function handleImport(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const body: HfImportRequest = {
      dataset: text(form, "dataset") ?? "",
      config: text(form, "config"),
      split: text(form, "split"),
      offset: Number(text(form, "offset") ?? 0),
      limit: Number(text(form, "limit") ?? LIMITS.hfRows.default),
      questionField: text(form, "questionField"),
      answerField: text(form, "answerField"),
      contextField: text(form, "contextField"),
      embed: form.get("embed") === "on",
    };
    setImportError("");
    try {
      const result = await importRequest.run((signal) => postJson<HfImportResponse>("/api/import-hf", body, signal));
      setImportResult(result);
      if (result.items.length > 0) {
        setLoaded({ items: result.items, source: `Hugging Face ${result.dataset} (${result.config}/${result.split}, rows ${result.offset}–${result.offset + result.rowsFetched - 1})` });
        setReport(null);
      }
    } catch (error) {
      setImportError(errorMessage(error));
    }
  }

  async function handleFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    setFileError("");
    if (!file) return;
    try {
      const items = parseBatchJson(await file.text(), LIMITS.batchItems);
      setLoaded({ items, source: `local file ${file.name}` });
      setReport(null);
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
    <section id="batch" aria-labelledby="batch-heading">
      <h2 id="batch-heading">C. Batch Processing &amp; Hugging Face</h2>
      <p>
        Load up to {LIMITS.batchItems} question/answer/context items from Hugging Face or a local JSON file,
        check them all, and download the CSV audit report.
      </p>

      <form onSubmit={handleImport}>
        <fieldset disabled={importRequest.busy}>
          <legend>Import a test dataset from Hugging Face</legend>
          <p>
            <label htmlFor="hf-dataset">Dataset ID</label>
            <br />
            <input id="hf-dataset" name="dataset" type="text" required placeholder="rajpurkar/squad" />
          </p>
          <p>
            <label>
              Rows <input name="limit" type="number" min={1} max={LIMITS.hfRows.max} defaultValue={LIMITS.hfRows.default} />
            </label>{" "}
            <label>
              Starting row <input name="offset" type="number" min={0} defaultValue={0} />
            </label>
          </p>
          <details>
            <summary>Config, split, and column mapping (auto-detected when blank)</summary>
            <p>
              <label>Config <input name="config" type="text" placeholder="plain_text" /></label>{" "}
              <label>Split <input name="split" type="text" placeholder="validation" /></label>
            </p>
            <p>
              <label>Question column <input name="questionField" type="text" placeholder="question" /></label>{" "}
              <label>Answer column <input name="answerField" type="text" placeholder="answers.text.0" /></label>{" "}
              <label>Context column <input name="contextField" type="text" placeholder="context" /></label>
            </p>
            <p>
              <label>
                <input name="embed" type="checkbox" defaultChecked /> Embed contexts into ChromaDB (Chroma default embeddings)
              </label>
            </p>
          </details>
          <p>
            <button type="submit">Import from Hugging Face</button>{" "}
            <button type="button" onClick={importRequest.cancel} disabled={!importRequest.busy}>Cancel</button>
          </p>
        </fieldset>
      </form>
      {importRequest.busy ? <p role="status">Fetching rows and embedding contexts… {importSeconds} s</p> : null}
      {importError ? <p role="alert">Import failed: {importError}</p> : null}
      {importResult ? (
        <div data-role="import-result">
          <p>
            Imported {importResult.items.length} of {importResult.rowsFetched} rows from <code>{importResult.dataset}</code> ({importResult.config}/{importResult.split}
            {importResult.totalRows !== null ? `, ${importResult.totalRows.toLocaleString()} rows in split` : ""}). Columns: question = <code>{importResult.fields.question}</code>,
            answer = <code>{importResult.fields.answer}</code>, context = <code>{importResult.fields.context}</code>.
          </p>
          <p>
            ChromaDB:{" "}
            {importResult.embedding.status === "ok"
              ? `${plural(importResult.embedding.uniqueContexts, "unique context")} → ${plural(importResult.embedding.chunksUpserted, "chunk")} in "${importResult.embedding.collection}".`
              : importResult.embedding.status === "skipped"
                ? "embedding skipped."
                : `embedding failed (${importResult.embedding.code}): ${importResult.embedding.message} The items can still be batch checked.`}
          </p>
          {importResult.skipped.length > 0 ? (
            <details>
              <summary>{plural(importResult.skipped.length, "row")} skipped</summary>
              <ul>
                {importResult.skipped.map((row) => (
                  <li key={row.rowIndex}>Row {row.rowIndex}: {row.reason}</li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      ) : null}

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
        <p>No items loaded.</p>
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
