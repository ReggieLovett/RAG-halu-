"use client";

import { useState, type FormEvent } from "react";
import { apiErrorMessage } from "../lib/rag/client-input";
import type { Passage, VerificationResult } from "../lib/rag/types";
import ManualCheck from "./components/ManualCheck";
import BatchCheck from "./components/BatchCheck";
import { HighlightedAnswer, VerificationView } from "./components/VerificationView";
import { useLocalRequest } from "./components/useLocalRequest";

type Mode = "chat" | "manual" | "batch";
type Message = {
  role: "user" | "assistant";
  content: string;
  verification?: VerificationResult;
  context?: Passage[];
};

const starterPrompts = [
  { icon: "✦", title: "Notre Dame", text: "What sits atop the Main Building at Notre Dame?" },
  { icon: "⌘", title: "Campus history", text: "When was the University of Notre Dame founded?" },
  { icon: "◒", title: "Music", text: "What group was Beyoncé part of before her solo career?" }
];
const modes: { mode: Mode; icon: string; label: string }[] = [
  { mode: "chat", icon: "▣", label: "Chat" },
  { mode: "manual", icon: "◎", label: "Manual check" },
  { mode: "batch", icon: "▤", label: "Batch checker" }
];

function Logo() { return <div className="logo-mark" aria-hidden="true">✦</div>; }

export default function Home() {
  const [mode, setMode] = useState<Mode>("chat");
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [error, setError] = useState("");
  const request = useLocalRequest();

  async function sendMessage(event?: FormEvent, prompt?: string) {
    event?.preventDefault();
    const content = (prompt ?? input).trim();
    if (!content || request.busy) return;
    const nextMessages: Message[] = [...messages, { role: "user", content }];
    setMessages(nextMessages); setInput(""); setError("");
    const current = request.begin();
    try {
      const response = await fetch("/api/chat", {
        method: "POST", headers: { "Content-Type": "application/json" }, signal: current.signal,
        body: JSON.stringify({ messages: nextMessages.slice(-99).map(({ role, content }) => ({ role, content })) })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(apiErrorMessage(data, "Something went wrong."));
      const answer = typeof data.answer === "string" ? data.answer : data.message;
      if (typeof answer !== "string") throw new Error("The server returned no answer.");
      if (request.isCurrent(current)) setMessages([...nextMessages, {
        role: "assistant", content: answer, context: data.context, verification: data.verification
      }]);
    } catch (requestError) {
      if (request.isCurrent(current)) setError(requestError instanceof Error ? requestError.message : "Something went wrong.");
    } finally { request.finish(current); }
  }

  function changeMode(next: Mode) {
    request.cancel(); setError(""); setMode(next);
  }
  function resetChat() {
    request.cancel(); setMessages([]); setError(""); setInput(""); setMode("chat");
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand"><Logo /><span>halu</span></div>
        <button className="new-chat-button" onClick={resetChat}><span aria-hidden="true">＋</span> New chat</button>
        <div className="sidebar-label">Workspace</div>
        <nav className="nav-list" aria-label="Workspace">
          {modes.map(item => <button key={item.mode} className={`nav-item ${mode === item.mode ? "active" : ""}`} aria-current={mode === item.mode ? "page" : undefined} onClick={() => changeMode(item.mode)}><span aria-hidden="true">{item.icon}</span>{item.label}</button>)}
        </nav>
        <div className="sidebar-label recent-label">Current session</div>
        <div className="recent-list"><button className="recent-item" onClick={() => changeMode("chat")}>{messages.length ? `${messages.filter(message => message.role === "user").length} questions in this chat` : "No questions yet"}</button></div>
        <div className="sidebar-footer">
          <div className="user-avatar">C</div>
          <div><strong>Christian</strong><small>Local workspace</small></div>
        </div>
      </aside>

      <section className="chat-panel" aria-label="Hallucination checker workspace">
        <header className="topbar">
          <div className="mobile-brand"><Logo /><span>halu</span></div>
          <div className="model-picker"><span className="status-dot" aria-hidden="true" /> Halu AI</div>
        </header>
        <nav className="mobile-workspace-nav" aria-label="Workspace modes">
          {modes.map(item => <button key={item.mode} className={`nav-item ${mode === item.mode ? "active" : ""}`} aria-current={mode === item.mode ? "page" : undefined} onClick={() => changeMode(item.mode)}>{item.label}</button>)}
          <button className="nav-item" onClick={resetChat}>New chat</button>
        </nav>

        {mode === "manual" ? <ManualCheck /> : mode === "batch" ? <BatchCheck /> : <>
          <div className={`conversation ${messages.length ? "has-messages" : ""}`}>
            {messages.length === 0 ? (
              <div className="welcome">
                <div className="welcome-icon"><Logo /></div>
                <p className="eyebrow">Good afternoon, Christian</p>
                <h1>What will we<br /><em>create today?</em></h1>
                <p className="intro">Ask the local knowledge base. Each answer includes a claim-by-claim evidence check.</p>
                <div className="prompt-grid">
                  {starterPrompts.map(item => (
                    <button className="prompt-card" key={item.title} onClick={() => sendMessage(undefined, item.text)} disabled={request.busy}>
                      <span className="prompt-icon" aria-hidden="true">{item.icon}</span>
                      <span><strong>{item.title}</strong><small>{item.text}</small></span>
                      <span className="arrow" aria-hidden="true">↗</span>
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="messages" aria-label="Chat messages">
                {messages.map((message, index) => (
                  <div className={`message-row ${message.role}`} key={`${message.role}-${index}`}>
                    <div className={`message-avatar ${message.role}`} aria-hidden="true">{message.role === "assistant" ? <Logo /> : "C"}</div>
                    <div className="message-content"><span className="message-name">{message.role === "assistant" ? "Halu" : "You"}</span>
                      {message.role === "assistant" ? <HighlightedAnswer answer={message.content} verification={message.verification} /> : <p>{message.content}</p>}
                      {message.verification ? <VerificationView verification={message.verification} context={message.context} /> : null}
                    </div>
                  </div>
                ))}
                {request.busy ? <div className="message-row assistant" role="status"><div className="message-avatar assistant"><Logo /></div><div className="message-content"><span className="message-name">Halu</span><p>Retrieving passages, answering, and verifying claims…</p><div className="typing" aria-hidden="true"><i /><i /><i /></div></div></div> : null}
              </div>
            )}
          </div>

          <div className="composer-wrap">
            {error ? <div className="error-message" role="alert">{error}</div> : null}
            <form className="composer" onSubmit={sendMessage}>
              <label className="sr-only" htmlFor="chat-message">Question for the local knowledge base</label>
              <textarea id="chat-message" value={input} onChange={event => setInput(event.target.value)} placeholder="Ask about your documents..." rows={1} maxLength={4000} disabled={request.busy} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void sendMessage(); } }} />
              <div className="composer-actions"><span className="composer-hint">Shift + Enter for new line</span>{request.busy ? <button type="button" className="functional-button secondary" onClick={() => { request.cancel(); setError("Request cancelled. Ask again when ready."); }}>Cancel</button> : <button className="send-button" aria-label="Send message" disabled={!input.trim()}>↑</button>}</div>
            </form>
            <p className="disclaimer">Faithfulness measures support in retrieved passages. Halu can still make mistakes.</p>
          </div>
        </>}
      </section>
    </main>
  );
}
