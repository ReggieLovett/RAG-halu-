"use client";

import { useState } from "react";
import BatchProcessing from "./components/BatchProcessing";
import DocumentChatbot, { type CheckerDraft } from "./components/DocumentChatbot";
import HallucinationChecker from "./components/HallucinationChecker";

// Semantic HTML with a light stylesheet (app/globals.css) that targets elements
// and data-* hooks only; the full UI design is handled separately.
export default function Home() {
  // A new object on every "Send to Checker" click, so repeat sends still refill the form.
  const [checkerDraft, setCheckerDraft] = useState<CheckerDraft | null>(null);

  function sendToChecker(draft: CheckerDraft) {
    setCheckerDraft({ ...draft });
    document.getElementById("checker")?.scrollIntoView();
  }

  return (
    <main>
      <header>
        <h1>AI Chatbot &amp; RAG Hallucination Checker</h1>
        <p>
          Chat with a research document (local ChromaDB retrieval + Groq), then audit the answers claim by claim.
        </p>
        <nav aria-label="Sections">
          <a href="#chatbot">A. Document Chatbot</a> <a href="#checker">B. Hallucination Checker</a>{" "}
          <a href="#batch">C. Batch Processing &amp; Hugging Face</a>
        </nav>
      </header>
      <hr />
      <DocumentChatbot onSendToChecker={sendToChecker} />
      <hr />
      <HallucinationChecker draft={checkerDraft} />
      <hr />
      <BatchProcessing />
    </main>
  );
}
