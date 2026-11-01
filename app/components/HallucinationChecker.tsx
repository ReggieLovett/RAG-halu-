"use client";

import { useEffect, useState, type FormEvent } from "react";
import { errorMessage, postJson } from "../../lib/api-client";
import type { CheckRequest, CheckResult } from "../../lib/types";
import { CheckResultView, VerdictLegend } from "./CheckResultView";
import type { CheckerDraft } from "./DocumentChatbot";
import { useElapsedSeconds, useRequest } from "./hooks";

const EMPTY: CheckerDraft = { question: "", context: "", answer: "" };

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

/** `draft` changes when "Send to Checker" is clicked in the chatbot. */
export default function HallucinationChecker({ draft }: { draft: CheckerDraft | null }) {
  const [form, setForm] = useState<CheckerDraft>(EMPTY);
  const [strictnessMode, setStrictnessMode] = useState(false);
  const [result, setResult] = useState<CheckResult | null>(null);
  const [error, setError] = useState("");
  const request = useRequest();
  const seconds = useElapsedSeconds(request.busy);

  const { cancel } = request;
  useEffect(() => {
    if (!draft) return;
    cancel();
    setForm(draft);
    setResult(null);
    setError("");
  }, [draft, cancel]);

  function update(field: keyof CheckerDraft, value: string) {
    setForm((current) => ({ ...current, [field]: value }));
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

  return (
    <section id="checker" aria-labelledby="checker-heading">
      <h2 id="checker-heading">B. Hallucination Checker</h2>
      <p>
        Paste a question, the source context, and an AI answer, or click &quot;Send to Checker&quot; in section A.
        Groq extracts atomic claims, verifies each against the context, and scores relevance.
      </p>

      <form onSubmit={handleCheck}>
        <fieldset disabled={request.busy}>
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
            <small>{form.context.length.toLocaleString()} / 60,000 characters</small>
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
          <button type="submit" disabled={request.busy}>Run check</button>{" "}
          <button type="button" onClick={request.cancel} disabled={!request.busy}>Cancel</button>{" "}
          <button type="button" disabled={request.busy} onClick={() => { setForm(EXAMPLE); setResult(null); setError(""); }}>
            Load example
          </button>{" "}
          <button type="button" disabled={request.busy} onClick={() => { setForm(EMPTY); setResult(null); setError(""); }}>
            Clear
          </button>
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
