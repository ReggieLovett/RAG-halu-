"use client";

import { useState, type FormEvent } from "react";
import { errorMessage, postJson } from "../../lib/api-client";
import { LIMITS } from "../../lib/config";
import type { HfImportRequest, HfImportResponse } from "../../lib/types";
import type { LoadedItems } from "./BatchProcessing";
import { plural } from "./CheckResultView";
import { useElapsedSeconds, useRequest } from "./hooks";

function text(form: FormData, name: string): string | undefined {
  const value = form.get(name);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export default function HuggingFaceImport({
  hidden,
  onUseInBatch,
}: {
  hidden: boolean;
  onUseInBatch: (loaded: LoadedItems) => void;
}) {
  const [result, setResult] = useState<HfImportResponse | null>(null);
  const [error, setError] = useState("");
  const request = useRequest();
  const seconds = useElapsedSeconds(request.busy);

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
    setError("");
    try {
      setResult(await request.run((signal) => postJson<HfImportResponse>("/api/import-hf", body, signal)));
    } catch (failure) {
      setError(errorMessage(failure));
    }
  }

  return (
    <section data-mode="huggingface" hidden={hidden} aria-labelledby="hf-heading">
      <header>
        <h1 id="hf-heading">Hugging Face import</h1>
        <p>
          Pull question/answer/context rows from a Hugging Face dataset. Their contexts are embedded into ChromaDB,
          and the rows can then be checked in Batch check.
        </p>
      </header>

      <form onSubmit={handleImport}>
        <fieldset disabled={request.busy}>
          <legend>Dataset</legend>
          <p>
            <label htmlFor="hf-dataset">Dataset ID</label>
            <br />
            <input id="hf-dataset" name="dataset" type="text" required placeholder="pminervini/HaluEval" />
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
              <label>Config <input name="config" type="text" placeholder="qa_samples" /></label>{" "}
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
            <button type="button" onClick={request.cancel} disabled={!request.busy}>Cancel</button>
          </p>
        </fieldset>
      </form>
      {request.busy ? <p role="status">Fetching rows and embedding contexts… {seconds} s</p> : null}
      {error ? <p role="alert">Import failed: {error}</p> : null}

      {result ? (
        <article aria-label="Import result">
          <h3>Imported {plural(result.items.length, "item")}</h3>
          <dl>
            <dt>Dataset</dt>
            <dd>
              <code>{result.dataset}</code> ({result.config}/{result.split}
              {result.totalRows !== null ? `, ${result.totalRows.toLocaleString()} rows in split` : ""})
            </dd>
            <dt>Rows</dt>
            <dd>{result.items.length} of {result.rowsFetched} usable, starting at row {result.offset}</dd>
            <dt>Columns</dt>
            <dd>
              question = <code>{result.fields.question}</code>, answer = <code>{result.fields.answer}</code>, context ={" "}
              <code>{result.fields.context}</code>
            </dd>
            <dt>ChromaDB</dt>
            <dd>
              {result.embedding.status === "ok"
                ? `${plural(result.embedding.uniqueContexts, "unique context")} embedded as ${plural(result.embedding.chunksUpserted, "chunk")} in "${result.embedding.collection}".`
                : result.embedding.status === "skipped"
                  ? "Embedding skipped."
                  : `Embedding failed (${result.embedding.code}): ${result.embedding.message} The items can still be batch checked.`}
            </dd>
          </dl>
          {result.skipped.length > 0 ? (
            <details>
              <summary>{plural(result.skipped.length, "row")} skipped</summary>
              <ul>
                {result.skipped.map((row) => (
                  <li key={row.rowIndex}>Row {row.rowIndex}: {row.reason}</li>
                ))}
              </ul>
            </details>
          ) : null}
          <p>
            <button
              type="button"
              data-role="primary"
              disabled={result.items.length === 0}
              onClick={() => onUseInBatch({
                items: result.items,
                source: `Hugging Face ${result.dataset} (${result.config}/${result.split}, rows ${result.offset}–${result.offset + result.rowsFetched - 1})`,
              })}
            >
              Check these in Batch check
            </button>
          </p>
        </article>
      ) : null}
    </section>
  );
}
