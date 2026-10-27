"use client";

import { FormEvent, useState } from "react";

type Message = {
  role: "user" | "assistant";
  content: string;
};

const starterPrompts = [
  { icon: "✦", title: "Brainstorm ideas", text: "Help me brainstorm ideas for a new project" },
  { icon: "⌘", title: "Write something", text: "Write a concise launch announcement for my product" },
  { icon: "◒", title: "Learn something", text: "Explain how APIs work in simple terms" }
];

function Logo() {
  return <div className="logo-mark">✦</div>;
}

function NewChatIcon() {
  return <span aria-hidden="true">＋</span>;
}

export default function Home() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");

  async function sendMessage(event?: FormEvent, prompt?: string) {
    event?.preventDefault();
    const content = (prompt ?? input).trim();
    if (!content || isLoading) return;

    const nextMessages = [...messages, { role: "user" as const, content }];
    setMessages(nextMessages);
    setInput("");
    setError("");
    setIsLoading(true);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: nextMessages })
      });
      const data = (await response.json()) as { message?: string; error?: string };
      if (!response.ok) throw new Error(data.error ?? "Something went wrong.");
      setMessages([...nextMessages, { role: "assistant", content: data.message ?? "" }]);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Something went wrong.");
    } finally {
      setIsLoading(false);
    }
  }

  function resetChat() {
    setMessages([]);
    setError("");
    setInput("");
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand"><Logo /><span>halu</span></div>
        <button className="new-chat-button" onClick={resetChat}><NewChatIcon /> New chat <span className="shortcut">⌘ K</span></button>
        <div className="sidebar-label">Workspace</div>
        <nav className="nav-list" aria-label="Workspace">
          <button className="nav-item active"><span>▣</span> Chat</button>
          <button className="nav-item"><span>◎</span> Explore</button>
          <button className="nav-item"><span>▤</span> Library</button>
        </nav>
        <div className="sidebar-label recent-label">Recent</div>
        <div className="recent-list">
          <button className="recent-item">Getting started with Halu</button>
          <button className="recent-item muted">No conversations yet</button>
        </div>
        <div className="sidebar-footer">
          <div className="user-avatar">C</div>
          <div><strong>Christian</strong><small>Personal workspace</small></div>
          <span className="more">•••</span>
        </div>
      </aside>

      <section className="chat-panel">
        <header className="topbar">
          <div className="mobile-brand"><Logo /><span>halu</span></div>
          <div className="model-picker"><span className="status-dot" /> Halu AI <span className="chevron">⌄</span></div>
          <button className="icon-button" aria-label="More options">•••</button>
        </header>

        <div className={`conversation ${messages.length ? "has-messages" : ""}`}>
          {messages.length === 0 ? (
            <div className="welcome">
              <div className="welcome-icon"><Logo /></div>
              <p className="eyebrow">Good afternoon, Christian</p>
              <h1>What will we<br /><em>create today?</em></h1>
              <p className="intro">Your thoughtful AI partner for ideas, answers, and getting things done.</p>
              <div className="prompt-grid">
                {starterPrompts.map((item) => (
                  <button className="prompt-card" key={item.title} onClick={() => sendMessage(undefined, item.text)}>
                    <span className="prompt-icon">{item.icon}</span>
                    <span><strong>{item.title}</strong><small>{item.text}</small></span>
                    <span className="arrow">↗</span>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="messages">
              {messages.map((message, index) => (
                <div className={`message-row ${message.role}`} key={`${message.role}-${index}`}>
                  <div className={`message-avatar ${message.role}`}>{message.role === "assistant" ? <Logo /> : "C"}</div>
                  <div className="message-content"><span className="message-name">{message.role === "assistant" ? "Halu" : "You"}</span><p>{message.content}</p></div>
                </div>
              ))}
              {isLoading && <div className="message-row assistant"><div className="message-avatar assistant"><Logo /></div><div className="message-content"><span className="message-name">Halu</span><div className="typing"><i /><i /><i /></div></div></div>}
            </div>
          )}
        </div>

        <div className="composer-wrap">
          {error && <div className="error-message">{error}</div>}
          <form className="composer" onSubmit={sendMessage}>
            <textarea value={input} onChange={(event) => setInput(event.target.value)} placeholder="Message Halu..." rows={1} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); sendMessage(); } }} />
            <div className="composer-actions"><button type="button" className="attach-button" aria-label="Attach file">＋</button><span className="composer-hint">Shift + Enter for new line</span><button className="send-button" aria-label="Send message" disabled={!input.trim() || isLoading}>↑</button></div>
          </form>
          <p className="disclaimer">Halu can make mistakes. Check important information.</p>
        </div>
      </section>
    </main>
  );
}
