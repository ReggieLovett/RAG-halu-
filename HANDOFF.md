# Local RAG backend handoff

Updated: 2026-10-27 (Asia/Manila). Local RAG, manual checking, verdict highlighting, and batch reports implemented.

## Latest request: complete the four project slides

Follow-up data-import guidance: `IMPORT_DATA.md` contains a verified AI/ML recipe for `m-ric/transformers_documentation_en` (default/train, text/filename). First25 rows validated read-only:359 total documents,2152 candidate chunks with size200/overlap40, maximum168 tokens. No new records were ingested during this guidance turn; current dataset settings were not edited. The guide explains adding to the same collection and continuing at offsets25/50/etc.

The user supplied four photos covering the objectives and functional requirements, and asked to finish all functionality before design work. Functional frontend controls are now included while the existing visual shell is preserved. `PROJECT_REQUIREMENTS.md` maps every slide requirement to its implementation.

- Chat now retains and displays the API's verification/context data, original-answer verdict highlights, faithfulness, confidence, and expandable evidence/passages.
- Manual check accepts pasted question/answer/context (plain text or JSON) and includes a three-verdict example.
- Batch checker uploads JSON/JSONL, shows ordered per-item results/errors and a weighted summary, and downloads the completed report as JSON without another model call.
- `/api/batch` accepts JSON or multipart file uploads, with optional JSON/CSV report downloads. Limits:50 items,1MiB, concurrency1(default) or2. Missing context retrieves locally; explicit [] does not. Missing answers are generated then checked.
- `npm run check:batch -- examples/batch-input.json --output report.json` creates a local report; `--format csv` exports CSV. The parent-folder launcher forwards check:batch too. Relative file paths resolve inside the child project.
- Extraction now returns exact original-answer quotations; `answerSpans` are validated UTF-16 offsets, end exclusive. `lib/rag/answer-spans.ts` safely segments original text and resolves overlaps Contradicted > Unsupported > Supported. No HTML is interpreted.
- UI requests support cancellation and discard stale results after reset/navigation. Minimal added CSS covers verdict colors, forms, focus, and mobile navigation; this is not a visual redesign.
- Current automated validation: TypeScript PASS and70 tests PASS. Live manual API returned all3verdicts with exact spans and33.33% faithfulness; live RAG returned5passages/oneSupported claim/100%; batch API retained a failed row and correctly scored successful claims.
- Real CLI example report saved to `.cache/batch-cli-report.json`:2items verified,0failed,50% faithfulness. Browser batch upload and JSON report download passed; output at `/Users/reggielovett/Downloads/hallucination-check-report.json` contains the completed report.
- Browser checks completed for all3views: Chat displayed the local RAG answer and100% faithfulness; Manual showed all3colored verdicts and33.33%, and expanding Supported/Contradicted exposed exact quotes and sources; Batch uploaded the real example file, showed2verified rows/50%, and downloaded a validated JSON report. Browser error log was empty. Preview saved to `.cache/checker-result.jpg`.

Setup is still two terminals: `npm run chroma:start`, then `npm run dev`. Select Chat, Manual check, or Batch checker in the app. Manual checking supplied passages works without Chroma. Groq still needs internet. Tests below from the original backend implementation are historical; the70-test result above is current.

## Requested scope

Original scope: local ChromaDB, Hugging Face dataset ingestion, Groq `openai/gpt-oss-120b` retrieval augmented answering, and claim-by-claim verification. Latest scope additionally includes the functional controls/highlighting/batch reports in the slides. Preserve the existing design. No deployment configuration.

## Existing project

- Repository: `/Users/reggielovett/Desktop/ai prog/RAG-halu-`.
- Local parent `/Users/reggielovett/Desktop/ai prog/package.json` now forwards npm commands to the child project. This fixes ENOENT when VS Code opens a terminal in `ai prog`. It is outside this repo; preserve/copy separately if moving the whole workspace. Parent README.md explains the two-terminal startup.
- Existing UI posts `{ messages: [{ role, content }] }` to `/api/chat` and reads `{ message }`.
- Preserve that API contract while returning additional RAG and verification data.
- Existing uncommitted changes to package.json, package-lock.json, tsconfig.json, next-env.d.ts, and AGENTS.md predate this work. Preserve them.
- Read AGENTS.md and installed Next.js route-handler/environment docs before implementation; done.

## Implemented

- `lib/rag/embeddings.ts`: lazy local CPU MiniLM, pinned weights, q8, 384 dimensions, normalized mean pooling, filesystem cache. Rejects over256 tokens rather than silently truncating.
- `lib/rag/chroma.ts`: loopback-only HTTP client, cosine collection, explicit vectors, embedding compatibility checks.
- `lib/rag/huggingface.ts`, `chunking.ts`, `scripts/ingest-hf.ts`: paginated dataset fetch, overlapping chunks, stable upserts, duplicate context removal, safe checkpoints.
- `/api/rag`: `{ question, topK? }`; `/api/chat`: existing `{ messages }` adapter; `/api/verify`: `{ question, answer, context: [{ id, text, source? }] }`.
- Separate atomic claim extraction and structured verification. Every claim receives verdict, exact quote evidence, confidence, source, and reason. Missing verdicts fail; fabricated quotes are Unsupported. Score is supported/all claims times100; no claims yields null.
- Local VS Code setup and API examples are in README.md and .env.example. No deployment configuration or frontend/CSS changes.
- Scoped npm override selects patched sharp>=0.35.5 under Transformers.js3.8.1. Keep the override on reinstall.
- `scripts/install-chroma.mjs`: installs official standalone Chroma cli-1.4.4 into ignored `.local/bin`, verifying size and the release's published SHA-256. `npm run chroma:install` avoids Python dependency installation.
- `scripts/start-chroma.mjs`: `npm run chroma:start` uses the standalone binary, with `.venv` as fallback. It reads the local host/port from .env.local. This fixes the missing `.venv/bin/chroma` error.

## Recovery and remaining local integration

The original Python installation failed due to disk space and left `.venv/bin/chroma` missing. This is resolved: the official standalone Mac ARM64 server is installed locally (58MiB), without requiring Python dependencies. `.venv` remains incomplete but is not needed. The model is cached, the default dataset sample is ingested, and full retrieval/generation/verification passed. Most recent disk check showed about3.6GiB free. No user data or global caches were deleted. Temporary test servers on ports3001 and8000 are stopped after testing so the user can start them in VS Code.

1. Read README.md and inspect `git status --short`. Changes are uncommitted. Preserve existing `.env.local`, which already has a working Groq key; no key was printed or copied.
2. Terminal1: `npm run chroma:start`. Keep running. Check `curl http://127.0.0.1:8000/api/v2/heartbeat`.
3. Terminal2: `npm run dev`. Open http://127.0.0.1:3000. No additional installation or ingestion is needed for the current sample.
4. To add/replay data, use `npm run ingest:hf` while Chroma runs. Current checkpoint: nextOffset1000, rowsRead1000, uniqueDocuments119, chunksUpserted182.
5. On a fresh clone or if `.local/bin/chroma` is missing, run `npm run chroma:install` first. Python installation is an optional alternative, not a prerequisite.
6. Run `npm run typecheck` and `npm test` after code changes.

If disconnected during ingestion, rerun the same range; stable IDs/upserts make replay safe. Preserve `.chroma/` and `.cache/transformers/`. The token-free `.cache/hf-ingestion-progress.json` checkpoint advances only after a complete page persists. To resume farther ahead, match its dataset/config/split/collection/chunk settings and set HF_START_OFFSET to nextOffset and HF_MAX_ROWS to the remaining desired count. A new collection name gives a clean index if source/chunk settings change. Groq still requires internet.

Chat uses only the final user question, so send self-contained questions. `status: verified` means checking completed, not every claim passed. Confidence and semantic judgments are fallible LLM outputs. Missing collections return409; empty existing collections abstain without a perfect score.

## Validation completed

- TypeScript check PASS; all40 automated backend tests PASS.
- Next.js local dev compiled all three API routes. Missing question and empty messages correctly return400.
- Live Groq generation passed using `openai/gpt-oss-120b`.
- Live HTTP `/api/verify`: context `Paris is located in France. Paris is not located in Germany.` and answer `Paris is in France. Paris is in Germany. Paris has 99 million residents.` returned200 with one Supported, one Contradicted, one Unsupported, exact quotes, and33.33% faithfulness.
- An earlier implicit country-conflict fixture yielded conservative Unsupported; semantic verdicts are not deterministic guarantees.
- Live Hugging Face default first-row fetch passed: SQuAD87599 training rows, first title University_of_Notre_Dame, text695 characters.
- Native Transformer import passed without model download. `npm ls sharp` resolves0.35.5; npm install audit reports0 vulnerabilities.
- `git diff --check` passed; frontend/CSS diff is empty. Local dev API compilation was tested; no production build required.
- Follow-up: official standalone Chroma download size/SHA-256 verified; local server heartbeat passed on127.0.0.1:8000.
- Fixed an environment import bug exposed by the first real ingestion: scripts/ingest-hf.ts now uses named `loadEnvConfig` from @next/env instead of a default import that was undefined under tsx.
- Real local CPU model inference and ingestion completed:1000 source rows,119 unique contexts,182 chunks; cached weights23MiB, persistent Chroma data in .chroma.
- Full live HTTP `/api/rag` returned200 for `What sits atop the Main Building at Notre Dame?`, with5 retrieved passages, an answer identifying the statue of the Virgin Mary, one Supported claim with an exact source quote, and100% faithfulness.
- After these fixes, TypeScript and all40 tests passed again. Installer/launcher JavaScript syntax checks and git diff whitespace checks passed.
- Parent-folder launcher verified: `npm run typecheck`, `npm run chroma:start`, and the exact `npm run ingest:hf` all work from `/Users/reggielovett/Desktop/ai prog`. Ingestion reran successfully through1000 rows/119 contexts/182 upserts. Temporary test Chroma process was stopped afterward so the user can start it in their own terminal.
