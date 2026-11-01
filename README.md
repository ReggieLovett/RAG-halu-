# AI Chatbot & RAG Hallucination Checker

A local Next.js (App Router) platform with three connected modules:

1. **Document Q&A chatbot (the generator).** Upload a PDF or DOCX; it is chunked and embedded into a local ChromaDB collection, and Groq answers questions strictly from the retrieved excerpts. This is the "RAG system under test."
2. **Verification engine (the checker).** Splits an answer into atomic claims, verifies each against the context (verdict, exact evidence quote, confidence), and scores faithfulness, answer relevance, and context relevance. Healthcare Strictness Mode accepts "Supported" only when the context states the claim literally and confidence is ≥ 0.95.
3. **Hugging Face importer and batch audits.** Pulls Q/A/context rows from a Hugging Face dataset, embeds the contexts into ChromaDB, runs them (or a local JSON file) through the checker in parallel, and exports a CSV audit report.

The frontend is semantic HTML with one light, Claude-inspired stylesheet, [app/globals.css](app/globals.css): a warm cream page, white rounded panels, serif headings and answers, and a clay accent. The stylesheet targets only elements and the `data-verdict`, `data-status`, and `data-role` hooks, with no classes and no inline styles, so whoever owns the UI design can replace it wholesale. Without it, verdicts still read through content markers (🟢 Supported, 🔴 Contradicted, 🟡 Unsupported).

## Run it

Requirements: Node.js 22+ and a Groq API key. The internet is needed for Groq, Hugging Face, and the first download of the embedding model.

```bash
npm install
cp .env.example .env.local   # then set GROQ_API_KEY (keep an existing .env.local)
npm run chroma:install       # one-time: project-local standalone Chroma server
```

Terminal 1 (leave running):

```bash
npm run chroma:start         # ChromaDB on http://localhost:8000, data in .chroma/
```

Terminal 2:

```bash
npm run dev                  # http://127.0.0.1:3000
```

The first upload downloads Chroma's default embedding model (`Xenova/all-MiniLM-L6-v2`, about 90 MB) into `.cache/transformers/`. After that, embeddings are computed locally on the CPU. The same commands also work from the parent `ai prog` folder.

## Using the dashboard

The sidebar switches between four modes, one on screen at a time. Each mode keeps its state when you switch away. On a phone, the modes become a row of tabs.

- **Chat**: ask anything, with no file needed (plain Groq chat). To answer from a research document instead, attach a PDF/DOCX with the **+** button in the message box or drag it onto the chat. Answers then come only from that document, show the retrieved excerpts, and can be sent with **Send to checker**. **Remove** goes back to plain chat.
- **Hallucination checker**: fills in automatically from "Send to checker", or accepts pasted input. The buttons at the top are **Upload file for context** (fills the Context box from a PDF/DOCX), **Load example** (a case that produces all three verdicts), and **Clear**. Tick **Healthcare Strictness Mode** for the literal-match and 0.95 rules. Results show the three scores and a claims table with verdict, confidence, evidence, reasoning, and any verdict adjustment. In Healthcare Mode the table also gets a "Literal match" column.
- **Hugging Face import**: import rows from a dataset ID. Config, split, and columns are auto-detected; you can override them under the expandable options. Then **Check these in Batch check**.
- **Batch check**: load a local JSON file (`examples/batch-input.json`) or the imported rows, then **Run batch check** and **Download CSV Audit Report**.

## Architecture

| Module | Files |
| --- | --- |
| Groq client (groq-sdk): structured JSON, retries, error mapping | `lib/groq.ts` |
| PDF (pdf-parse) / DOCX (mammoth) parsing, ingestion, retrieval | `lib/documents.ts`, `lib/chunking.ts` |
| ChromaDB with Chroma's default embedding function | `lib/chroma.ts` |
| Chatbot (plain or document-grounded) | `lib/chatbot.ts`, `app/api/chat/route.ts`, `app/api/upload/route.ts`, `app/api/extract/route.ts` |
| Verification engine | `lib/checker.ts`, `lib/evidence.ts`, `app/api/check/route.ts` |
| Hugging Face importer | `lib/huggingface-importer.ts`, `app/api/import-hf/route.ts` |
| Batch processing | `lib/batch.ts`, `app/api/batch-check/route.ts` |
| CSV audit export (client-safe) | `lib/export.ts` |
| Shared types, config, HTTP helpers | `lib/types.ts`, `lib/config.ts`, `lib/http.ts`, `lib/errors.ts` |
| Dashboard (semantic HTML + one stylesheet) | `app/page.tsx`, `app/components/*`, `app/globals.css` |

**Retrieval.** Uploaded text is split into sentence-aware chunks (about 1,000 characters with about 150 characters of overlap). The chunks are embedded with Chroma's `DefaultEmbeddingFunction` from `@chroma-core/default-embed` (all-MiniLM-L6-v2, cosine space) and stored in the `uploaded_documents` collection, tagged with a `documentId`, which is a hash of the extracted text, so re-uploading the same file replaces its chunks. Chat retrieves the top 5 chunks for the latest question and filters them to the active document.

**Verification (`lib/checker.ts`).**
1. Groq extracts atomic, self-contained claims from the answer (at most 40, deduplicated).
2. Groq judges every claim against the context and must return verdict, verbatim evidence, confidence (0 to 1), and reasoning. Claims it skips get one retry; if any are still missing, the check fails rather than scoring a subset.
3. Groq scores answer relevance and context relevance (0 to 100) in a call that runs in parallel with steps 1 and 2.

Evidence quotes are located in the context with an exact match first, then a whitespace/typography/case-insensitive match. The response always contains the exact source substring. A Supported or Contradicted verdict whose quote is not in the context is downgraded to Unsupported, and the reason is recorded in `adjustments`. The raw verdict is kept as `modelVerdict`.

**Faithfulness** is computed in code from the final verdicts as (Supported ÷ total claims) × 100, rather than by the LLM, because LLMs do arithmetic unreliably. It is `null` when the answer makes no factual claims.

**Healthcare Strictness Mode** adds clinical-rigor instructions and asks the verifier for a `literalMatch` flag: true only if the evidence states the claim's facts literally (same numbers, units, frequency, population, and qualifiers). Rewording and standard abbreviations count as literal; conversion, rounding, approximation, or inference do not. The flag is placed before the confidence in the schema, so the model judges literalness first. A Supported claim stays Supported only if `literalMatch` is true **and** confidence is ≥ 0.95. Otherwise it becomes Unsupported, and each failed criterion is noted in `adjustments`.

The flag exists because a confidence threshold alone barely gated anything: `openai/gpt-oss-120b` reported 0.97–0.99 for "roughly three times daily" against "every 8 hours". With the flag, those claims are marked `literalMatch: false` and downgraded, while literally stated claims ("412 adults at hospitals in Ohio") stay Supported. Standard mode neither asks for nor applies the flag, and `literalMatch` is `null` there.

## API

All routes are `POST`. JSON routes need `Content-Type: application/json`. Errors return `{ "error": string, "code": string, "details"?: [{ path, message }] }` with a matching HTTP status (400 validation, 404 not found, 413 too large, 415 wrong type, 422 unreadable file, 429 Groq rate limit, 502 upstream failure, 503 Chroma down, 504 timeout).

### `POST /api/upload`

Multipart form with field `file` (PDF or DOCX, up to 20 MB).

```bash
curl -F "file=@paper.pdf" http://127.0.0.1:3000/api/upload
```

```json
{ "documentId": "doc_fd2fbc30d1c74d33", "fileName": "paper.pdf", "fileType": "pdf", "pages": 1,
  "characters": 904, "chunks": 1, "collection": "uploaded_documents", "preview": "Effects of Afternoon Napping…" }
```

Handled failures: wrong extension or magic bytes (415/422), password-protected PDF (`PDF_PASSWORD_PROTECTED`), damaged files (`PDF_UNREADABLE`, `DOCX_UNREADABLE`), scanned PDFs with no text layer (`NO_EXTRACTABLE_TEXT`), and Chroma not running (`CHROMA_UNAVAILABLE`).

### `POST /api/extract`

Multipart form with field `file` (PDF or DOCX, up to 20 MB). Returns `{ fileName, fileType, pages, characters, text }` and stores nothing. The checker's **Upload file for context** button uses it.

### `POST /api/chat`

```json
{ "documentId": "doc_fd2fbc30d1c74d33",
  "messages": [{ "role": "user", "content": "How much better did the nap group do?" }],
  "topK": 5 }
```

`documentId` is optional. Without it (or with `null`), this is plain chat: no retrieval, no Chroma, and `context` is empty with `documentId`/`fileName` null. Returns `{ question, answer, documentId, fileName, context: [{ id, chunkIndex, text, distance }], contextText, model, durationMs }`. `contextText` is what "Send to Checker" passes on as the context. Up to 8 earlier turns are sent for continuity, but only the retrieved excerpts count as evidence. If the excerpts don't contain the answer, the reply is "The uploaded document does not contain information to answer this question."

### `POST /api/check`

```json
{ "question": "What did the study find about hospital readmissions?",
  "context": "…23% fewer hospital readmissions than the control group…",
  "answer": "The intervention reduced hospital readmissions by 32%.",
  "strictnessMode": false }
```

`context` can also be an array of passages. Limits: question 4,000 characters, answer 20,000, context 60,000. Response (abridged):

```json
{ "claims": [{ "id": "c1", "claim": "The intervention reduced hospital readmissions by 32%.",
               "verdict": "Contradicted", "modelVerdict": "Contradicted",
               "evidence": "Participants who received the intervention had 23% fewer hospital readmissions than the control group.",
               "evidenceFound": true, "literalMatch": null, "confidence": 0.99, "reasoning": "…", "adjustments": [] }],
  "counts": { "total": 1, "supported": 0, "contradicted": 1, "unsupported": 0 },
  "metrics": { "faithfulness": 0, "answerRelevance": 80, "contextRelevance": 100,
               "answerRelevanceReason": "…", "contextRelevanceReason": "…" },
  "strictnessMode": false, "supportThreshold": null, "model": "openai/gpt-oss-120b", "durationMs": 2052 }
```

### `POST /api/batch-check`

Send `{ "items": [{ "id"?, "question", "answer", "context" }], "strictnessMode"?, "concurrency"? }` or a bare array of items. Up to 50 items; concurrency is 1 to 5 (default 2). Items run concurrently through the checker. An invalid or failed item is reported in its own result and never fails the batch.

```bash
curl -H 'Content-Type: application/json' --data @examples/batch-input.json http://127.0.0.1:3000/api/batch-check
```

The response is `{ createdAt, durationMs, strictnessMode, concurrency, model, summary, results }`. `summary` includes `overallFaithfulness` (all supported claims ÷ all claims), `averageFaithfulness` (the mean of per-item scores), the average relevance scores, claim counts, and `itemsWithFailedClaims`. Each result has `status: "ok"` with a full `result`, or `status: "error"` with `{ code, message }`.

`lib/export.ts` turns this report into the CSV audit report: `batchReportToCsv(report)` writes the columns ID, Question, Answer, Faithfulness (%), Answer Relevance, Context Relevance, Failed Claims (Contradicted/Unsupported claims, one per line), and Status. Cells are RFC 4180-quoted and guarded against spreadsheet formula injection. The dashboard's download adds a UTF-8 BOM so Excel detects the encoding.

### `POST /api/import-hf`

```json
{ "dataset": "pminervini/HaluEval", "config": "qa_samples", "split": "data", "offset": 0, "limit": 10,
  "questionField": "question", "answerField": "answer", "contextField": "knowledge", "embed": true }
```

Only `dataset` is required. If you omit the config, the first one is used. If you omit the split, test is preferred, then validation, then train. Columns are detected from common names (question/query/prompt, answer/response/answers/right_answer, context/knowledge/documents/passages). Field paths such as `answers.text.0` are supported, and list or object values are flattened to text. `limit` is 1 to 50 rows per request. Rows truncated by the Hugging Face viewer, or missing any field, are listed in `skipped`. Unique contexts are chunked and embedded into the `hf_test_contexts` collection with the default embedding function. If Chroma is down, the items are still returned with `embedding.status: "failed"`. The returned `items` can be posted to `/api/batch-check` unchanged.

Tested datasets: `rajpurkar/squad` (gold answers, so all claims should be Supported) and `pminervini/HaluEval` with config `qa_samples` (a mix of correct and hallucinated answers). Gated datasets need `HF_TOKEN`.

## Configuration (`.env.local`)

| Setting | Default | Purpose |
| --- | --- | --- |
| `GROQ_API_KEY` | (required) | Groq key, server-only |
| `GROQ_CHAT_MODEL`, `GROQ_CHECKER_MODEL` | `openai/gpt-oss-120b` | Models for answering and checking (`GROQ_MODEL` sets both) |
| `GROQ_REASONING_EFFORT` | `low` | gpt-oss reasoning effort: low, medium, or high |
| `GROQ_TIMEOUT_MS` | `60000` | Per-attempt request timeout |
| `GROQ_MAX_RETRIES` | `2` | Retries for timeouts, network errors, and 5xx |
| `GROQ_RATE_LIMIT_WAIT_MS` | `90000` | How long one request may wait out 429 rate limits |
| `CHROMA_HOST`, `CHROMA_PORT` | `localhost`, `8000` | Local Chroma server |
| `CHROMA_DOCUMENTS_COLLECTION` | `uploaded_documents` | Uploaded document chunks |
| `CHROMA_HF_COLLECTION` | `hf_test_contexts` | Imported Hugging Face contexts |
| `HF_TOKEN` | (empty) | Token for gated or private datasets |

**Models.** Groq retired `llama-3.1-70b-versatile` (and Llama 3.3 70B is also no longer offered to this key), so the default is `openai/gpt-oss-120b`, which gets Groq's strict JSON-schema decoding. Other models fall back to JSON mode, with the schema in the prompt plus zod validation.

**Rate limits.** Free-tier Groq keys allow roughly 8,000 tokens per minute and 1,000 requests per day for gpt-oss-120b, and one check uses about 3 requests. On a 429, requests back off and retry (honouring `retry-after`) for up to `GROQ_RATE_LIMIT_WAIT_MS`. Large batches on a free key therefore take minutes. Lower the concurrency if items fail with `GROQ_RATE_LIMITED`. A single prompt larger than the per-minute budget fails with `GROQ_REQUEST_TOO_LARGE`, so shorten the context.

## Tests

```bash
npm run typecheck
npm test
npm run build
```

There are 43 unit tests: checker logic and Healthcare Mode (including the literal-match gate), evidence matching, CSV export, batch concurrency and summaries, the Hugging Face importer, real PDF/DOCX parsing, chunking, and the Groq client against a local mock server (timeouts, 429/5xx retries, error mapping). They use injected fakes or local servers and never call Groq or Hugging Face.

## Notes

- `chromadb` is loaded at runtime with `import(/* webpackIgnore: true */ "chromadb")`, because it dynamically imports `@chroma-core/*` packages, which Turbopack cannot bundle. pdf-parse, pdfjs-dist, and the embedding packages are listed in `serverExternalPackages`.
- The previous Chroma collection `rag_hf_minilm_v1` (SQuAD plus Transformers docs from the old app) is still in `.chroma/` but is no longer used.
- Faithfulness measures support in the provided context, not real-world truth. Verdicts and confidence come from an LLM and can be wrong; quote validation only proves that the cited text exists.
