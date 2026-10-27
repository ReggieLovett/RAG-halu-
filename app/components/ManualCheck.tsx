"use client";

import { useState, type FormEvent } from "react";
import { apiErrorMessage, parseManualContext } from "../../lib/rag/client-input";
import type { VerificationResult } from "../../lib/rag/types";
import { HighlightedAnswer, VerificationView, type DisplayPassage } from "./VerificationView";
import { useLocalRequest } from "./useLocalRequest";

type Result = { answer: string; verification: VerificationResult; context: DisplayPassage[] };

export default function ManualCheck() {
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [passages, setPassages] = useState("");
  const [format, setFormat] = useState<"text" | "json">("text");
  const [error, setError] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const request = useLocalRequest();

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (request.busy) return;
    setError("");
    setResult(null);
    let context;
    try { context = parseManualContext(passages, format); }
    catch (error) { setError(error instanceof Error ? error.message : "Check your passages."); return; }
    const current = request.begin();
    try {
      const response = await fetch("/api/verify", {
        method: "POST", headers: { "Content-Type": "application/json" }, signal: current.signal,
        body: JSON.stringify({ question: question.trim(), answer: answer.trim(), context })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(apiErrorMessage(data, "Verification could not finish."));
      if (typeof data.answer !== "string" || !data.verification || !Array.isArray(data.verification.claims)) {
        throw new Error("The server returned an invalid verification result.");
      }
      if (request.isCurrent(current)) setResult({
        answer: data.answer, verification: data.verification,
        context: context.map(passage => ({ ...passage, source: passage.source ?? passage.id }))
      });
    } catch (error) {
      if (request.isCurrent(current)) setError(error instanceof Error ? error.message : "Verification could not finish.");
    } finally { request.finish(current); }
  }

  function cancel() { request.cancel(); setError("Verification cancelled. You can edit and try again."); }

  function loadExample() {
    setQuestion("Where is Paris?");
    setPassages("Paris is located in France. Paris is not located in Germany.");
    setFormat("text");
    setAnswer("Paris is in France. Paris is in Germany. Paris has 100 airports.");
    setResult(null); setError("");
  }

  return (
    <div className="workspace-view">
      <h1>Manual hallucination check</h1>
      <p className="workspace-help">Paste a question, its source passages, and an existing answer. The checker uses only these passages as evidence.</p>
      <form className="checker-form" onSubmit={submit} aria-busy={request.busy}>
        <fieldset disabled={request.busy}>
          <label htmlFor="manual-question">Question</label>
          <textarea id="manual-question" value={question} onChange={event => setQuestion(event.target.value)} required maxLength={4000} rows={2} />
          <label htmlFor="passage-format">Passage format</label>
          <select id="passage-format" value={format} onChange={event => setFormat(event.target.value as "text" | "json")}>
            <option value="text">Plain text — separate passages with a blank line</option>
            <option value="json">JSON array — preserve passage IDs and sources</option>
          </select>
          <label htmlFor="manual-passages">Retrieved / source passages</label>
          <p id="passage-help" className="workspace-help">{format === "text" ? "Up to 10 passages. Maximum 6000 characters per passage and 24000 total. Blank means no supporting context." : 'Example: [{"id":"p1","text":"Source text here","source":"Book or URL"}]. Up to 10 passages, 6000 characters each and 24000 total.'}</p>
          <textarea id="manual-passages" aria-describedby="passage-help" value={passages} onChange={event => setPassages(event.target.value)} maxLength={50000} rows={7} />
          <label htmlFor="manual-answer">Generated answer to check</label>
          <textarea id="manual-answer" value={answer} onChange={event => setAnswer(event.target.value)} required maxLength={16000} rows={5} />
          <div className="form-actions"><button className="functional-button" type="submit" disabled={!question.trim() || !answer.trim()}>Check answer</button><button className="functional-button secondary" type="button" onClick={loadExample}>Load three-verdict example</button></div>
        </fieldset>
        {request.busy ? <p role="status">Splitting claims and checking evidence… <button type="button" className="functional-button secondary" onClick={cancel}>Cancel</button></p> : null}
        {error ? <div className="error-message" role="alert">{error}</div> : null}
      </form>
      {result ? <section className="manual-result" aria-label="Manual verification result"><p role="status">Verification complete.</p><h2>Checked answer</h2><HighlightedAnswer answer={result.answer} verification={result.verification} /><VerificationView verification={result.verification} context={result.context} /></section> : null}
    </div>
  );
}
