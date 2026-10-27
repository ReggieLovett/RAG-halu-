# Halu Chat: local RAG backend

Next.js API routes retrieve passages from a **local ChromaDB server**, generate an answer with Groq `openai/gpt-oss-120b`, and verify individual factual claims against those same passages. The existing design is retained, with functional Chat, Manual check, and Batch checker views. Local CPU embeddings use `Xenova/all-MiniLM-L6-v2` through Transformers.js; Groq remains a remote API. Internet is needed for installation, dataset/model download, and Groq calls. Cached embeddings and Chroma storage are local.

## Run in VS Code

If your terminal opens in the parent `ai prog` folder, the local parent `package.json` forwards `dev`, `chroma:start`, `chroma:install`, `ingest:hf`, `check:batch`, `typecheck`, and `test` to this project. These commands work from either folder; no Python environment activation is required for npm commands. Relative CLI file paths resolve inside `RAG-halu-`. The parent launcher is outside this application's Git repository, so a fresh clone should be opened directly in the project folder.

Open this project directory in VS Code. Use Node.js 22 LTS or newer. Python 3.10–3.12 is needed only for the optional Python server installation. No Docker, cloud database, or deployment configuration is required.

1. Install JavaScript dependencies:

   ```bash
   npm install
   ```

   Keep sufficient free disk space for native runtimes, the model cache, and the persisted database. The optional Python installation needs substantially more space than the standalone server.

2. Create `.env.local` from `.env.example` and set `GROQ_API_KEY` to your Groq key. If `.env.local` already exists, keep it and add any missing settings from the example. Never commit your key. All environment variables are server-only.

3. Install the official standalone Chroma server into this project:

   ```bash
   npm run chroma:install
   ```

   This installs Chroma's pinned standalone release in `.local/bin`, verifies its published SHA-256 digest, and requires no global installation or Python dependencies. Supported platforms are macOS Apple Silicon/Intel, Linux x64, and Windows x64. Existing Python installations in `.venv` are also supported by the launcher.

4. In terminal 1, start Chroma:

   ```bash
   npm run chroma:start
   ```

   The launcher finds `.local/bin/chroma` (or `.venv/bin/chroma`) and runs it on `127.0.0.1:8000` with disk storage in `.chroma/`. It reads CHROMA_HOST/CHROMA_PORT from `.env.local`. Keep this terminal running. Data survives restarts. You can check connectivity with:

   ```bash
   curl http://127.0.0.1:8000/api/v2/heartbeat
   ```

5. In terminal 2, download and ingest the dataset:

   ```bash
   npm run ingest:hf
   ```

   The first run downloads and caches the embedding model in `.cache/transformers/`. This may take a few minutes. The default imports the first 1,000 SQuAD training **rows**, deduplicates repeated context, chunks passages with overlap, embeds them locally, and upserts them in batches. A thousand rows do not mean a thousand unique passages. No Groq key is needed for ingestion.

6. In terminal 3, start Next.js:

   ```bash
   npm run dev
   ```

   Open [http://127.0.0.1:3000](http://127.0.0.1:3000). Chat calls the RAG pipeline through `/api/chat`. Restart Next.js after changing `.env.local`.

Optional Python alternative on macOS/Linux: `python3 -m venv .venv` then `.venv/bin/python -m pip install -r requirements-chroma.txt`. On Windows PowerShell: `py -3.12 -m venv .venv` then `.venv\Scripts\python.exe -m pip install -r requirements-chroma.txt`. In either case, `npm run chroma:start` finds that installation if no standalone binary exists.

If `chroma:start` reports that Chroma is not installed, an earlier Python installation may have failed. Run `npm run chroma:install`, then retry `npm run chroma:start`. Activating `.venv` alone does not install Chroma.

## Use the checker

- **Chat**: ask a self-contained question about the indexed data. The answer shows verdict highlights, faithfulness, and a claim list. Expand a claim to see its exact quote, source, confidence, and reason. Expand the passages section to see all retrieved text.
- **Manual check**: paste a question, source passages, and an existing generated answer. Plain text passages are separated by blank lines; JSON arrays preserve your own IDs and sources. Click **Load three-verdict example**, then **Check answer** for a quick demonstration. Chroma is not needed when passages are supplied manually.
- **Batch checker**: upload a JSON/JSONL file, run the check, expand each result, and click **Download JSON report**. The built-in example file and `examples/batch-input.json` demonstrate the format.

Green means Supported, red means Contradicted, and amber means Unsupported. The legend and claim labels also spell out every verdict. Highlights refer to exact original-answer text, using locally validated UTF-16 spans; unhighlighted wording has no mapped factual claim. Overlapping verdicts conservatively prioritize Contradicted, then Unsupported, then Supported. The answer is never inserted as HTML. Cancelling or changing views discards stale client results.

See `PROJECT_REQUIREMENTS.md` for the mapping from the supplied project slides to these functions. Functional controls and minimal verdict styling were added; no visual redesign was performed.

## API routes

All routes use the Node.js runtime and require `Content-Type: application/json`. Validation errors return HTTP 400; oversized bodies return 413. Bodies are limited to 128 KiB, questions to 4,000 characters, and `topK` to 1–10 (default 5). Embedding token limits are checked separately.

### POST `/api/rag`

```bash
curl http://127.0.0.1:3000/api/rag \
  -H 'Content-Type: application/json' \
  -d '{"question":"What sits atop the Main Building at Notre Dame?","topK":5}'
```

The response shape below is illustrative, not a recorded model result:

```json
{
  "question": "What sits atop the Main Building at Notre Dame?",
  "answer": "A golden statue of the Virgin Mary sits atop the dome. [passage-id]",
  "message": "A golden statue of the Virgin Mary sits atop the dome. [passage-id]",
  "status": "verified",
  "context": [
    {
      "id": "passage-id",
      "text": "Atop the Main Building's gold dome is a golden statue of the Virgin Mary.",
      "source": "https://huggingface.co/datasets/rajpurkar/squad",
      "distance": 0.12,
      "metadata": {}
    }
  ],
  "verification": {
    "claims": [
      {
        "id": "claim-1",
        "claim": "A golden statue of the Virgin Mary sits atop the Main Building's dome.",
        "verdict": "Supported",
        "evidence": [
          {
            "passageId": "passage-id",
            "quote": "Atop the Main Building's gold dome is a golden statue of the Virgin Mary.",
            "source": "https://huggingface.co/datasets/rajpurkar/squad"
          }
        ],
        "confidence": 0.96,
        "reason": "The passage explicitly states the statue's location."
      }
    ],
    "faithfulnessScore": 100,
    "supportedClaims": 1,
    "contradictedClaims": 0,
    "unsupportedClaims": 0,
    "totalClaims": 1
  }
}
```

`message` aliases `answer` for the unchanged UI. `status: "verified"` means the verification pipeline completed; inspect the score/verdicts to determine support. It does not mean every claim passed. `distance` is cosine distance, not a probability or confidence. An empty context produces a local abstention with `status: "no_context"`, zero claims, and a null score.

### POST `/api/chat`

```bash
curl http://127.0.0.1:3000/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"What sits atop the Main Building at Notre Dame?"}]}'
```

This accepts the existing `{ messages }` contract and returns the same enriched result as `/api/rag`. The final message must be a user message. Only the final user question is used for retrieval and answering; send self-contained questions. Prior assistant messages are never treated as evidence, and client-supplied system messages are rejected. The UI now displays the returned answer, highlights, faithfulness, and expandable verification details.

### POST `/api/verify`

Check an independently supplied answer without another retrieval/generation step:

```bash
curl http://127.0.0.1:3000/api/verify \
  -H 'Content-Type: application/json' \
  -d '{"question":"Where is Paris?","answer":"Paris is in France. Paris is in Germany. Paris has 99 million residents.","context":[{"id":"p1","text":"Paris is the capital of France and is located in France.","source":"local-example"}]}'
```

Returns `{ question, answer, verification }`. Input context is an array of `{ id, text, source? }`, with unique IDs, at most 10 passages, 6,000 characters per passage, and 24,000 context characters total. Answers are limited to 16,000 characters.

Each returned factual claim also has `answerSpans: [{ start, end, text }]`. Positions are zero-based UTF-16 offsets with an exclusive end; `answer.slice(start, end)` equals `text`. Extraction returns original-answer quotes, which the server locates and validates locally instead of trusting model-generated offsets. Clients with older saved results lacking spans still show their claim/evidence list.

### POST `/api/batch`

Upload up to **50 items / 1 MiB** as a JSON file (an array or `{ "items": [...] }`) or JSONL (one item per line). The API also accepts `application/json` with `{ items, concurrency? }`. Use multipart field `file` for a file upload:

```bash
curl http://127.0.0.1:3000/api/batch \
  -F 'file=@examples/batch-input.json'
```

An item has this shape:

```json
{
  "id": "example-1",
  "question": "Where is Paris?",
  "answer": "Paris is in France. Paris is in Germany. Paris has 100 airports.",
  "context": [
    { "id": "p1", "text": "Paris is located in France. Paris is not located in Germany.", "source": "Demo passage" }
  ],
  "topK": 5
}
```

`question` is required. With an answer and context, the answer is checked directly. Omit context to retrieve from local Chroma. Omit answer to generate from the selected context and then verify. An explicit `context: []` is respected and never triggers retrieval. A missing answer with no passages yields an abstention. Each question/answer/context uses the manual API limits above.

The response contains `schemaVersion`, `createdAt`, `durationMs`, `summary`, and ordered `results`. Every input row appears, including individual validation/model errors. Summary faithfulness is **total supported claims / total evaluated claims**, not an average of item percentages. Failed or cancelled rows have no score and are excluded from that denominator; their counts remain visible. Default concurrency is 1, with an allowed maximum of 2. File parsing/envelope errors reject the upload before model calls.

Use `/api/batch?download=1` for an attached JSON response, or `/api/batch?format=csv` for an attached CSV report with one row per claim. JSON preserves the complete summary and context. CSV includes evidence and protects cells from spreadsheet formula execution. Each POST runs a new check; the UI's report-download button reuses the completed report without another Groq request.

### Local batch-file command

Keep Chroma running if your input needs retrieval, then run:

```bash
npm run check:batch -- examples/batch-input.json --output batch-report.json
```

For CSV:

```bash
npm run check:batch -- examples/batch-input.json --output batch-report.csv --format csv
```

Optional `--concurrency 2` enables two workers. The CLI uses `.env.local`, writes the report atomically, and exits nonzero if any rows fail or are cancelled while retaining their results in the report. The output parent folder must already exist. On interruption, started calls are cancelled and unstarted items are recorded as cancelled; network-disconnected browser clients may not receive that partial server report, so use the CLI when you need a saved partial report.

## How verification works

1. Groq extracts atomic, individually testable factual claims from the answer. Instructions treat the question, answer, and retrieved documents as untrusted data.
2. A separate structured-output Groq call judges every extracted claim against only the supplied passages. A claim is `Supported` when the context entails it, `Contradicted` when the context directly refutes it, and `Unsupported` when the context is insufficient. Conflicting context is handled conservatively.
3. Returned claim IDs and verdicts are validated. For Supported/Contradicted verdicts, evidence must cite a real passage ID and an exact substring of that passage. Invented quotes or references are downgraded to Unsupported. Unsupported claims can have an empty evidence array because absence of support has no supporting quote.
4. `faithfulnessScore = 100 × supportedClaims / totalClaims`, rounded for display. All Unsupported and Contradicted claims remain in the denominator. No testable claims yields `null`. The pipeline fails if extraction/evaluation is incomplete; it does not return a successful unchecked answer.

Confidence is a model-reported value between 0 and 1, not a calibrated probability. Quote validation proves that a quote exists; semantic entailment and claim extraction still rely on an LLM and can be wrong. This measures faithfulness to retrieved context, not real-world factual correctness. The original answer is returned with its verdicts; unsupported claims are not silently rewritten. A separate verifier model can reduce some shared-model bias but does not eliminate it.

## Configuration and ingestion recovery

For a tested AI documentation example and steps to add other IT datasets, see [IMPORT_DATA.md](IMPORT_DATA.md). It uses command-scoped dataset settings to keep the existing API key and collection unchanged.

See `.env.example` for defaults:

| Setting | Purpose |
| --- | --- |
| `GROQ_API_KEY` | Required for answering and verification |
| `GROQ_VERIFIER_MODEL` | Default `openai/gpt-oss-120b`; optionally `openai/gpt-oss-20b` |
| `GROQ_TIMEOUT_MS` | Per-request Groq timeout, default 60000 ms |
| `CHROMA_HOST`, `CHROMA_PORT` | Local loopback server, default `127.0.0.1:8000` |
| `CHROMA_COLLECTION` | Collection name, default `rag_hf_minilm_v1` |
| `HF_DATASET`, `HF_CONFIG`, `HF_SPLIT` | Default `rajpurkar/squad`, `plain_text`, `train` |
| `HF_TEXT_FIELD`, `HF_TITLE_FIELD` | Default `context`, `title`; configure for your dataset schema |
| `HF_MAX_ROWS`, `HF_START_OFFSET` | Bounded source row range, default 1000 rows from offset 0 |
| `HF_BATCH_SIZE` | Embedding/upsert batch size, default 32 |
| `HF_CHUNK_SIZE`, `HF_CHUNK_OVERLAP` | Character chunks and overlap, default 800 and 120; reduce size for text exceeding the 256-token embedding limit |
| `HF_TOKEN` | Optional Hugging Face token for restricted datasets |

Dataset fetching uses the Hugging Face dataset-viewer `/rows` API with pagination, so your dataset/config/split must be supported by that service. Truncated or missing text fails explicitly. Ingestion uses stable content IDs and upserts, making reruns safe for the same dataset contents and chunk settings. After a network interruption, rerun `npm run ingest:hf`; completed batches remain persisted. For a later row range, set `HF_START_OFFSET` and `HF_MAX_ROWS` in `.env.local`. Changing a source dataset does not delete previously stored documents: use a new collection name to isolate datasets or rebuild an index. Model/dimension settings are checked to prevent embedding mismatches.

The installed MiniLM model and local cache must be retained for offline embedding. Groq generation/verification and uncached dataset/model downloads still require internet. `HANDOFF.md` records work status and validation so a later chat can resume after disconnection.

Transformers.js stays on the compatible 3.x embedding API. A scoped npm override selects patched `sharp` 0.35.5 or newer for its unused image dependency; the RAG pipeline handles text only. Keep this override when reinstalling dependencies.

## Source files and checks

- `app/api/rag/route.ts`: RAG request route.
- `app/api/chat/route.ts`: adapter for the existing UI.
- `app/api/verify/route.ts`: answer-verification route.
- `app/api/batch/route.ts`, `lib/rag/batch.ts`, `scripts/check-batch.ts`: batch uploads, bounded checking, JSON/CSV reporting, and CLI.
- `app/components/`: manual/batch controls and shared verdict/evidence rendering, with cancellation.
- `lib/rag/answer-spans.ts`: exact original-answer mapping and safe highlight segmentation.
- `lib/rag/chroma.ts`, `embeddings.ts`: local vector database and shared embeddings.
- `lib/rag/huggingface.ts`, `chunking.ts`, `scripts/ingest-hf.ts`: paginated fetching, chunking, CLI ingestion.
- `lib/rag/groq.ts`, `verification.ts`, `pipeline.ts`: generation, claim checking, orchestration.
- `requirements-chroma.txt`: local Python database dependency.

```bash
npm run typecheck
npm test
```

All 70 unit tests use deterministic fixtures and mocked network calls. They do not consume Groq credits. See `HANDOFF.md` for live API, CLI, and browser smoke test results.

Official API references: [Chroma local client/server](https://docs.trychroma.com/docs/run-chroma/client-server), [Groq structured outputs](https://console.groq.com/docs/structured-outputs), [Hugging Face dataset rows](https://huggingface.co/docs/dataset-viewer/en/rows), and [SQuAD dataset card and license](https://huggingface.co/datasets/rajpurkar/squad).
