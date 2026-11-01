"use client";

import { useState, type FormEvent, type KeyboardEvent } from "react";
import { apiRequest, errorMessage, postJson } from "../../lib/api-client";
import type { ChatMessage, ChatResponse, UploadedDocument } from "../../lib/types";
import { MultilineText, plural } from "./CheckResultView";
import { useElapsedSeconds, useRequest } from "./hooks";

export type CheckerDraft = { question: string; context: string; answer: string };

type ChatEntry =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; response: ChatResponse };

const ACCEPTED_TYPES = ".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export default function DocumentChatbot({ onSendToChecker }: { onSendToChecker: (draft: CheckerDraft) => void }) {
  const [document, setDocument] = useState<UploadedDocument | null>(null);
  const [uploadError, setUploadError] = useState("");
  const [messages, setMessages] = useState<ChatEntry[]>([]);
  const [input, setInput] = useState("");
  const [chatError, setChatError] = useState("");
  const upload = useRequest();
  const chat = useRequest();
  const uploadSeconds = useElapsedSeconds(upload.busy);

  async function handleUpload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const file = form.get("file");
    if (!(file instanceof File) || !file.name) {
      setUploadError("Choose a PDF or DOCX file first.");
      return;
    }
    setUploadError("");
    try {
      // The browser sets the multipart boundary header itself.
      const uploaded = await upload.run((signal) =>
        apiRequest<UploadedDocument>("/api/upload", { method: "POST", body: form, signal }));
      chat.cancel();
      setDocument(uploaded);
      setMessages([]);
      setChatError("");
    } catch (error) {
      setUploadError(errorMessage(error));
    }
  }

  async function handleSend(event?: FormEvent) {
    event?.preventDefault();
    const question = input.trim();
    if (!document || !question || chat.busy) return;
    const history: ChatMessage[] = messages.map(({ role, content }) => ({ role, content }));
    setMessages((current) => [...current, { role: "user", content: question }]);
    setInput("");
    setChatError("");
    try {
      const response = await chat.run((signal) => postJson<ChatResponse>("/api/chat", {
        documentId: document.documentId,
        messages: [...history, { role: "user", content: question }],
      }, signal));
      setMessages((current) => [...current, { role: "assistant", content: response.answer, response }]);
    } catch (error) {
      setChatError(errorMessage(error));
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void handleSend();
    }
  }

  return (
    <section id="chatbot" aria-labelledby="chatbot-heading">
      <h2 id="chatbot-heading">A. Document Chatbot</h2>
      <p>
        Upload a research document. The chatbot answers only from that document, using the excerpts
        it retrieves from ChromaDB. Send any answer to the Hallucination Checker to audit it.
      </p>

      <form onSubmit={handleUpload}>
        <fieldset disabled={upload.busy}>
          <legend>Knowledge base</legend>
          <p>
            <label htmlFor="document-file">Research document (PDF or DOCX, up to 20 MB)</label>
            <br />
            <input id="document-file" name="file" type="file" accept={ACCEPTED_TYPES} required />{" "}
            <button type="submit">Upload document</button>
          </p>
        </fieldset>
      </form>
      {upload.busy ? (
        <p role="status">
          Extracting text, chunking, and embedding into ChromaDB… {uploadSeconds} s (the first upload also downloads the embedding model).
        </p>
      ) : null}
      {uploadError ? <p role="alert">Upload failed: {uploadError}</p> : null}
      {document ? (
        <div data-role="active-document">
          <p>
            Active document: <strong>{document.fileName}</strong> — {document.fileType.toUpperCase()}
            {document.pages !== null ? `, ${plural(document.pages, "page")}` : ""}, {plural(document.characters, "character")},{" "}
            {plural(document.chunks, "chunk")} in collection <code>{document.collection}</code>.
          </p>
          <details>
            <summary>Extracted text preview</summary>
            <p>
              <MultilineText text={document.preview} />…
            </p>
          </details>
        </div>
      ) : (
        <p>No document uploaded yet.</p>
      )}

      <h3>Chat history</h3>
      <div role="log" aria-live="polite" aria-label="Chat history">
        {messages.length === 0 ? (
          <p>No messages yet.</p>
        ) : (
          <ol>
            {messages.map((message, index) => (
              <li key={index} data-role={message.role}>
                <p>
                  <strong>{message.role === "user" ? "You" : "Assistant"}:</strong>
                </p>
                <p>
                  <MultilineText text={message.content} />
                </p>
                {message.role === "assistant" ? (
                  <>
                    <p>
                      <button
                        type="button"
                        onClick={() => onSendToChecker({
                          question: message.response.question,
                          answer: message.response.answer,
                          context: message.response.contextText,
                        })}
                      >
                        Send to Checker
                      </button>{" "}
                      <small>
                        {message.response.model} · {(message.response.durationMs / 1000).toFixed(1)} s
                      </small>
                    </p>
                    <details>
                      <summary>Retrieved context ({plural(message.response.context.length, "excerpt")})</summary>
                      <ol>
                        {message.response.context.map((chunk) => (
                          <li key={chunk.id}>
                            <p>
                              <small>
                                Chunk #{chunk.chunkIndex}
                                {chunk.distance !== null ? ` · cosine distance ${chunk.distance}` : ""}
                              </small>
                            </p>
                            <blockquote>{chunk.text}</blockquote>
                          </li>
                        ))}
                      </ol>
                    </details>
                  </>
                ) : null}
              </li>
            ))}
          </ol>
        )}
        {chat.busy ? <p role="status">Retrieving excerpts and generating an answer…</p> : null}
      </div>
      {chatError ? <p role="alert">Chat failed: {chatError}</p> : null}

      <form onSubmit={handleSend}>
        <p>
          <label htmlFor="chat-input">Ask a question about the document</label>
          <br />
          <textarea
            id="chat-input"
            rows={3}
            value={input}
            maxLength={4000}
            placeholder={document ? "Enter to send, Shift+Enter for a new line" : "Upload a document first"}
            disabled={!document}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={handleKeyDown}
          />
        </p>
        <p>
          <button type="submit" disabled={!document || chat.busy || !input.trim()}>Send</button>{" "}
          <button type="button" onClick={chat.cancel} disabled={!chat.busy}>Cancel</button>{" "}
          <button
            type="button"
            disabled={messages.length === 0 || chat.busy}
            onClick={() => {
              setMessages([]);
              setChatError("");
            }}
          >
            Clear chat
          </button>
        </p>
      </form>
    </section>
  );
}
