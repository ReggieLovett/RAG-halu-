"use client";

import { useState } from "react";
import BatchProcessing, { type LoadedItems } from "./components/BatchProcessing";
import DocumentChatbot, { type CheckerDraft } from "./components/DocumentChatbot";
import HallucinationChecker from "./components/HallucinationChecker";
import HuggingFaceImport from "./components/HuggingFaceImport";

type Mode = "chat" | "checker" | "huggingface" | "batch";

const MODES: { id: Mode; label: string }[] = [
  { id: "chat", label: "Chat" },
  { id: "checker", label: "Hallucination checker" },
  { id: "huggingface", label: "Hugging Face import" },
  { id: "batch", label: "Batch check" },
];

// Semantic HTML with a light stylesheet (app/globals.css) that targets elements
// and data-* hooks only; the full UI design is handled separately.
export default function Home() {
  const [mode, setMode] = useState<Mode>("chat");
  // A new object on every "Send to Checker" click, so repeat sends still refill the form.
  const [checkerDraft, setCheckerDraft] = useState<CheckerDraft | null>(null);
  const [batchItems, setBatchItems] = useState<LoadedItems | null>(null);

  // Every mode stays mounted (just hidden), so switching keeps its state.
  return (
    <div data-role="app">
      <nav aria-label="Modes" data-role="sidebar">
        <p data-role="brand">RAG Hallucination Checker</p>
        <ul>
          {MODES.map((item) => (
            <li key={item.id}>
              <button type="button" aria-current={mode === item.id ? "page" : undefined} onClick={() => setMode(item.id)}>
                {item.label}
              </button>
            </li>
          ))}
        </ul>
      </nav>
      <main>
        <DocumentChatbot
          hidden={mode !== "chat"}
          onSendToChecker={(draft) => {
            setCheckerDraft({ ...draft });
            setMode("checker");
          }}
        />
        <HallucinationChecker hidden={mode !== "checker"} draft={checkerDraft} />
        <HuggingFaceImport
          hidden={mode !== "huggingface"}
          onUseInBatch={(loaded) => {
            setBatchItems(loaded);
            setMode("batch");
          }}
        />
        <BatchProcessing hidden={mode !== "batch"} loaded={batchItems} onLoad={setBatchItems} />
      </main>
    </div>
  );
}
