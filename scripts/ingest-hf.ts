import { loadEnvConfig } from "@next/env";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { ingestHuggingFaceDataset, ingestionConfig } from "../lib/rag/huggingface";
import { chromaSettings } from "../lib/rag/chroma";
import { RagError } from "../lib/rag/errors";

loadEnvConfig(process.cwd());

async function main() {
  const config = ingestionConfig();
  const { name } = chromaSettings();
  const cacheDir = path.resolve(process.cwd(), ".cache");
  const checkpointPath = path.join(cacheDir, "hf-ingestion-progress.json");
  await mkdir(cacheDir, { recursive: true });
  const controller = new AbortController();
  const stop = () => controller.abort(new Error("Ingestion interrupted. Rerun the same range or resume from the last saved nextOffset."));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  console.log(`Ingesting ${config.dataset}/${config.config}/${config.split} from row ${config.startOffset}, up to ${config.maxRows} rows into ${name}.`);
  console.log("The first run downloads the embedding model; subsequent runs use .cache/transformers.");
  try {
    const progress = await ingestHuggingFaceDataset(config, {
      signal: controller.signal,
      onProgress: async (progress) => {
        // Do not write the optional Hugging Face bearer token to the handoff file.
        const { token: _token, ...safeConfig } = config;
        const checkpoint = { config: safeConfig, collection: name, ...progress, updatedAt: new Date().toISOString() };
        await writeFile(`${checkpointPath}.tmp`, `${JSON.stringify(checkpoint, null, 2)}\n`, "utf8");
        await rename(`${checkpointPath}.tmp`, checkpointPath);
        console.log(`${progress.rowsRead === 0 ? "Starting checkpoint" : `Saved through row ${progress.nextOffset - 1}`}; ${progress.rowsRead} rows read, ${progress.uniqueDocuments} unique contexts, ${progress.chunksUpserted} chunks upserted. Resume with HF_START_OFFSET=${progress.nextOffset}.`);
      },
    });
    console.log(`Ingestion complete. Next offset: ${progress.nextOffset}. Checkpoint: ${checkpointPath}`);
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof RagError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : "Ingestion failed.");
  console.error("Already persisted chunks are safe. Rerun the same range, or read .cache/hf-ingestion-progress.json and set HF_START_OFFSET to its nextOffset with matching dataset/config/split/collection.");
  process.exitCode = 1;
});
