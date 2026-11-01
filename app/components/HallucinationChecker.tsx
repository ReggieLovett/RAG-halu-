"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { apiRequest, errorMessage, postJson } from "../../lib/api-client";
import { LIMITS } from "../../lib/config";
import type { CheckRequest, CheckResult, ExtractedDocument } from "../../lib/types";
import { CheckResultView, plural, VerdictLegend } from "./CheckResultView";
import type { CheckerDraft } from "./DocumentChatbot";
import { useElapsedSeconds, useRequest } from "./hooks";

const EMPTY: CheckerDraft = { question: "", context: "", answer: "" };
const ACCEPTED_TYPES = ".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document";

// Designed to produce all three verdicts.
const EXAMPLE: CheckerDraft = {
  question: "What did the study find about hospital readmissions?",
  context:
    "The study enrolled 412 adults aged 18 to 65 across three hospitals in Ohio between 2019 and 2021. " +
    "Participants who received the intervention had 23% fewer hospital readmissions than the control group. " +
    "The trial did not measure long-term mortality.",
  answer:
    "The study enrolled 412 adults at hospitals in Ohio. The intervention reduced hospital readmissions by 32%. " +
    "The trial was funded by the National Institutes of Health.",
};

/** `draft` changes when "Send to checker" is clicked in the chat. */
export default function HallucinationChecker({ hidden, draft }: { hidden: boolean; draft: CheckerDraft | null }) {
  const [form, setForm] = useState<CheckerDraft>(EMPTY);
  const [strictnessMode, setStrictnessMode] = useState(false);
  const [result, setResult] = useState<CheckResult | null>(null);
  const [error, setError] = useState("");
  const [fileNote, setFileNote] = useState("");
  const [fileError, setFileError] = useState("");
  const request = useRequest();
  const extract = useRequest();
  const seconds = useElapsedSeconds(request.busy);
  const fileInput = useRef<HTMLInputElement>(null);

  const { cancel } = request;
  useEffect(() => {
    if (!draft) return;
    cancel();
    setForm(draft);
    setResult(null);
    setError("");
    setFileNote("");
  }, [draft, cancel]);

  function update(field: keyof CheckerDraft, value: string) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  function reset(next: CheckerDraft) {
    setForm(next);
    setResult(null);
    setError("");
    setFileNote("");
    setFileError("");
  }

  async function loadContextFile(file: File | undefined) {
    if (!file) return;
    setFileError("");
    const body = new FormData();
    body.append("file", file);
    try {
      const extracted = await extract.run((signal) =>
        apiRequest<ExtractedDocument>("/api/extract", { method: "POST", body, signal }));
      update("context", extracted.text);
      setFileNote(
        `Context loaded from ${extracted.fileName} (${plural(extracted.characters, "character")}).` +
        (extracted.characters > LIMITS.contextCharacters
          ? ` That's over the ${LIMITS.contextCharacters.toLocaleString()}-character limit, so trim it to the relevant part.`
          : ""),
      );
    } catch (failure) {
      setFileError(errorMessage(failure));
    } finally {
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  async function handleCheck(event: FormEvent) {
    event.preventDefault();
    setError("");
    setResult(null);
    try {
      const body: CheckRequest = { ...form, strictnessMode };
      setResult(await request.run((signal) => postJson<CheckResult>("/api/check", body, signal)));
    } catch (failure) {
      setError(errorMessage(failure));
    }
  }

  const busy = request.busy || extract.busy;

  return (
    <section data-mode="checker" hidden={hidden} aria-labelledby="checker-heading">
      <header>
        <h1 id="checker-heading">Hallucination checker</h1>
        <p>
          Check an answer against its source. Groq splits the answer into claims, verifies each against the context,
          and scores relevance. Answers sent from the chat land here.
        </p>
      </header>

      <div data-role="toolbar">
        <input ref={fileInput} type="file" accept={ACCEPTED_TYPES} hidden onChange={(event) => void loadContextFile(event.target.files?.[0])} />
        <button type="button" disabled={busy} onClick={() => fileInput.current?.click()}>
          {extract.busy ? "Reading file…" : "Upload file for context"}
        </button>
        <button type="button" disabled={busy} onClick={() => reset(EXAMPLE)}>Load example</button>
        <button type="button" disabled={busy} onClick={() => reset(EMPTY)}>Clear</button>
      </div>
      {fileNote ? <p data-role="note">{fileNote}</p> : null}
      {fileError ? <p role="alert">Couldn&apos;t read the file: {fileError}</p> : null}

      <form onSubmit={handleCheck}>
        <fieldset disabled={busy}>
          <legend>Inputs</legend>
          <p>
            <label htmlFor="check-question">Question</label>
            <br />
            <textarea id="check-question" rows={2} required value={form.question} onChange={(event) => update("question", event.target.value)} />
          </p>
          <p>
            <label htmlFor="check-context">Context (source text the answer must be faithful to)</label>
            <br />
            <textarea id="check-context" rows={10} required value={form.context} onChange={(event) => update("context", event.target.value)} />
            <br />
            <small>{form.context.length.toLocaleString()} / {LIMITS.contextCharacters.toLocaleString()} characters</small>
          </p>
          <p>
            <label htmlFor="check-answer">Answer to check</label>
            <br />
            <textarea id="check-answer" rows={5} required value={form.answer} onChange={(event) => update("answer", event.target.value)} />
          </p>
          <p>
            <label>
              <input type="checkbox" checked={strictnessMode} onChange={(event) => setStrictnessMode(event.target.checked)} />{" "}
              Healthcare Strictness Mode (a claim counts as Supported only if the context states it literally, with confidence ≥ 0.95)
            </label>
          </p>
        </fieldset>
        <p>
          <button type="submit" disabled={busy}>Run check</button>{" "}
          <button type="button" onClick={request.cancel} disabled={!request.busy}>Cancel</button>
        </p>
      </form>

      {request.busy ? (
        <p role="status">Extracting claims, verifying each against the context, and scoring relevance… {seconds} s</p>
      ) : null}
      {error ? <p role="alert">Check failed: {error}</p> : null}
      <VerdictLegend />
      {result ? <CheckResultView result={result} /> : null}
    </section>
  );
}
