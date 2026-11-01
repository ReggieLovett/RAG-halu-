# Handoff

Updated 2026-11-01. The project was rebuilt into the "AI Chatbot & RAG Hallucination Checker" platform. See `README.md` for setup, architecture, the API, and configuration.

## What changed

- Replaced the old SQuAD-knowledge-base chat (`lib/rag/*`, `/api/rag`, `/api/verify`, `/api/batch`, the styled UI and its components, the CLI scripts, and the 127 old tests) with the new modules: document chatbot, verification engine, Hugging Face importer, batch checking, and CSV export.
- A pre-rebuild snapshot, including the old uncommitted work, is at `../backups/RAG-halu-pre-rebuild-2026-11-01.tar.gz`. It excludes `node_modules`, `.chroma`, and caches. Earlier states are also in git history.
- New dependencies: `groq-sdk` (the official package; `@groq/groq-sdk` does not exist on npm), `pdf-parse` 2.x, `mammoth`, `@chroma-core/default-embed`, and `jszip` (a dev dependency for test fixtures).
- The UI is raw HTML with no CSS by request. `app/globals.css` was removed. Verdict colors are 🟢/🔴/🟡 markers plus `data-*` hooks.
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

## Known limitations

- **Healthcare Mode** enforces confidence ≥ 0.95 exactly as specified, but gpt-oss-120b reported 0.97–0.99 even for approximate support ("roughly three times daily" vs. "every 8 hours"), so in practice the threshold rarely triggers. A possible next step is asking the model for an explicit "literal match" flag and gating on that too.
- **Groq limits on this key:** 8,000 tokens per minute and 1,000 requests per day. One check uses about 3 requests, so big batches are slow. A back-to-back burst during testing hit a 429; after that, the client was changed to wait out 429s (up to `GROQ_RATE_LIMIT_WAIT_MS`). That backoff is covered by mock-server tests but has not yet been exercised against live Groq.
- The old Chroma collection `rag_hf_minilm_v1` (2,334 records) is still in `.chroma/` but unused.

## Continue

1. `npm run chroma:start` (Chroma is not left running), then `npm run dev`.
2. After changes, run `npm run typecheck && npm test && npm run build`.
