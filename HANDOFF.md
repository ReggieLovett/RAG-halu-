# Handoff

Updated 2026-11-01. The project was rebuilt into the "AI Chatbot & RAG Hallucination Checker" platform. See `README.md` for setup, architecture, the API, and configuration.

## What changed

- Replaced the old SQuAD-knowledge-base chat (`lib/rag/*`, `/api/rag`, `/api/verify`, `/api/batch`, the styled UI and its components, the CLI scripts, and the 127 old tests) with the new modules: document chatbot, verification engine, Hugging Face importer, batch checking, and CSV export.
- A pre-rebuild snapshot, including the old uncommitted work, is at `../backups/RAG-halu-pre-rebuild-2026-11-01.tar.gz`. It excludes `node_modules`, `.chroma`, and caches. Earlier states are also in git history.
- New dependencies: `groq-sdk` (the official package; `@groq/groq-sdk` does not exist on npm), `pdf-parse` 2.x, `mammoth`, `@chroma-core/default-embed`, and `jszip` (a dev dependency for test fixtures).
- The UI started as raw HTML with no CSS, as the original spec required. At the user's later request, it now has one light, Claude-inspired stylesheet, `app/globals.css`. It targets only elements and `data-*` hooks (no classes or inline styles), so a full UI design can replace it. Without it, verdicts still read through 🟢/🔴/🟡 markers.
- tsconfig target went from `es5` to `ES2022`. The broken `next lint` script was removed, because Next 16 has no lint command.

## Verified on 2026-11-01

- `npm run typecheck`, `npm test` (42 passing), and `npm run build` all pass.
- Live with local Chroma and Groq `openai/gpt-oss-120b`:
  - PDF and DOCX upload returned 201. The first upload took 18 s while it downloaded the embedding model; later uploads take about 0.2 s.
  - `.txt`, a fake `.pdf`, a missing file, and a JSON body were rejected with 415/422/400/415.
  - Chat gave grounded answers in about 1–2 s and refused an out-of-document question. Bad and unknown document IDs returned 400/404.
  - The checker scored the chat answer 100%. The readmissions example (32% claimed vs. 23% in the context) came out Contradicted with the exact evidence quote.
  - Batch runs: `examples/batch-input.json` (3 items, all three verdicts, 50% overall faithfulness) and imported HaluEval rows. The hallucinated "First for Women" answer was flagged.
  - Hugging Face import auto-detected SQuAD (`plain_text`/`validation`) and HaluEval `qa_samples`, and embedded the contexts into `hf_test_contexts`.
  - With Chroma stopped, upload and chat returned a 503 telling the user to start Chroma, and the HF import still returned its items with `embedding.status: "failed"`.
  - In the browser: upload → chat → Send to Checker → Run check, then HF import → batch → CSV download (correct content, UTF-8 BOM). No console errors.

## Follow-up, same day: literal-match gate and design

- Healthcare Mode now asks the verifier for `literalMatch` (placed before `confidence` in the strict schema). Supported needs `literalMatch: true` and confidence ≥ 0.95. Each failed criterion is noted in `adjustments`, and `ClaimCheck.literalMatch` is null in standard mode.
- Live result: "10 mg/kg roughly three times daily" and "about 40 mg/kg" (against "every 8 hours" and "40 mg per kilogram") were flagged non-literal and downgraded, where the threshold alone had let them through. The literal claim "412 adults at hospitals in Ohio" stayed Supported (0.97), so there was no over-blocking in this test.
- Added the Claude-inspired stylesheet, checked at desktop and 375 px phone width (no horizontal overflow, no console errors). `npm run typecheck`, `npm test` (43 passing), and `npm run build` pass.

## Follow-up: app layout

- The single scrolling page is now a sidebar app with four modes: Chat, Hallucination checker, Hugging Face import, and Batch check. Modes stay mounted, so switching keeps their state.
- Chat works without a file; `documentId` is optional on `/api/chat`. Files attach with the + button or by dropping them on the chat, and the composer stays pinned at the bottom.
- The checker has an "Upload file for context" button at the top, backed by the new `POST /api/extract`, which extracts text without storing it.
- Verified in the browser: plain chat, drag-and-drop attach, document chat, Send to checker (switches mode), upload for context, and the HF → Batch hand-off, at desktop and phone width. Typecheck, 43 tests, and the build pass.

## Known limitations

- **Healthcare Mode** still relies on LLM judgments. The literal-match flag made the gate effective in testing, but the flag and verdicts can still be wrong, so treat results as an audit aid, not clinical validation.
- **Groq limits on this key:** 8,000 tokens per minute and 1,000 requests per day. One check uses about 3 requests, so big batches are slow. A back-to-back burst during testing hit a 429; after that, the client was changed to wait out 429s (up to `GROQ_RATE_LIMIT_WAIT_MS`). That backoff is covered by mock-server tests but has not yet been exercised against live Groq.
- The old Chroma collection `rag_hf_minilm_v1` (2,334 records) is still in `.chroma/` but unused.

## Continue

1. `npm run chroma:start`, then `npm run dev`. Check `curl http://localhost:8000/api/v2/heartbeat` first so you don't start a second Chroma.
2. After changes, run `npm run typecheck && npm test && npm run build`.
