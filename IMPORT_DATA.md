# Import more Hugging Face data into local Chroma

## Tested AI / ML example

Dataset: https://huggingface.co/datasets/m-ric/transformers_documentation_en

This is a historical English Transformers documentation snapshot with 359 documents, including training, text generation, and ML terminology. Its schema is `default` config, `train` split, `text` content, and `filename` title. It is an AI/ML learning corpus, not a complete collection of IT knowledge or current software documentation.

The first 25 documents were fetched and validated on 2026-10-27. No cells were truncated. With 200-character chunks / 40-character overlap, the largest measured chunk was 168 tokens, within the local MiniLM 256-token limit. Validation did not insert database records.

1. In a terminal inside this project or the parent `ai prog` folder, keep Chroma running:

   ```bash
   npm run chroma:start
   ```

2. In another terminal, copy the entire command below:

   ```bash
   HF_DATASET=m-ric/transformers_documentation_en \
   HF_CONFIG=default \
   HF_SPLIT=train \
   HF_TEXT_FIELD=text \
   HF_TITLE_FIELD=filename \
   HF_START_OFFSET=0 \
   HF_MAX_ROWS=25 \
   HF_CHUNK_SIZE=200 \
   HF_CHUNK_OVERLAP=40 \
   npm run ingest:hf
   ```

   These settings apply to this command only. The existing `.env.local` key and collection settings are preserved. New dataset IDs are namespaced, so existing SQuAD records remain in the same collection. The process downloads text, chunks it, creates local embeddings, and upserts both text and vectors into Chroma.

3. Wait for `Ingestion complete`. New text is immediately available to the running chat through the same collection. Test a question such as `What is fine-tuning a pretrained model?`.

4. For the next 25 documents, repeat the **entire** command with `HF_START_OFFSET=25`; then 50, 75, and so on. Keep the dataset/config/split/chunk settings unchanged. `HF_MAX_ROWS` means rows for that run, not a final row number. Replaying the same range/settings upserts the same IDs.

## Other AI or IT datasets

Select a dataset containing source passages about the subject you want (for example networking, databases, operating systems, or programming). Open its Hugging Face dataset viewer and identify:

- Dataset ID, such as `author/dataset-name`.
- Config/subset and split, such as `default` / `train`.
- A plain string column containing useful factual text, for `HF_TEXT_FIELD`.
- An optional string title column, for `HF_TITLE_FIELD`. A missing title column is allowed.

Repeat the command with those values. The current importer reads one text column; nested conversation arrays, images, or question/answer fields that need combining require a dataset adapter. Setting a topic name alone does not filter an unrelated dataset into that topic.

If a record exceeds the embedding token limit, use smaller chunks and an overlap below the chunk size. If Hugging Face returns truncated cells, the importer rejects that page; chunk size cannot repair text already truncated upstream. Use complete viewer text or a different loading method/dataset. Preserve `.cache/hf-ingestion-progress.json` for recovery; rerun a failed range safely.

Keep the same Chroma collection to search all imported datasets together. A different `CHROMA_COLLECTION` creates/selects a separate index, and the app must use that same collection to retrieve it. Hugging Face hosts datasets from different authors; inspect their sources, dates, and licenses before using their text as evidence.
