import path from "node:path";
import type { FeatureExtractionPipeline } from "@huggingface/transformers";
import type { Collection, EmbeddingFunction, Metadata, Where } from "chromadb";
import { chromaSettings } from "./config";
import { AppError, cancelledError } from "./errors";

const EMBED_BATCH_SIZE = 32;
const CHROMA_TIMEOUT_MS = 30_000;

export type ChromaRecord = { id: string; document: string; metadata: Metadata };
export type ChromaMatch = { id: string; document: string; metadata: Metadata; distance: number | null };

type ChromaModule = typeof import("chromadb");
let chromaModule: Promise<ChromaModule> | undefined;

/**
 * Load chromadb at runtime instead of bundling it: it imports
 * `@chroma-core/${name}` packages dynamically, which Turbopack can neither
 * bundle nor trace (it tries to compile every file in those packages).
 */
function loadChroma(): Promise<ChromaModule> {
  chromaModule ??= import(/* webpackIgnore: true */ "chromadb");
  return chromaModule;
}

let embeddingFunction: Promise<EmbeddingFunction> | undefined;

/**
 * Chroma's DefaultEmbeddingFunction (Xenova/all-MiniLM-L6-v2, fp32, mean
 * pooling, normalized), run locally through Transformers.js. The subclass only
 * keeps one ONNX session alive instead of reloading the model on every
 * generate() call; its name and config are unchanged, so collections record
 * Chroma's "default" embedding function.
 */
export function defaultEmbeddingFunction(): Promise<EmbeddingFunction> {
  embeddingFunction ??= (async () => {
    // Imported lazily so routes that never embed don't load onnxruntime.
    const [{ DefaultEmbeddingFunction }, transformers] = await Promise.all([
      import("@chroma-core/default-embed"),
      import("@huggingface/transformers"),
    ]);
    transformers.env.cacheDir = path.join(process.cwd(), ".cache", "transformers");
    // pipeline()'s overloads are too large for TypeScript to infer here.
    const createExtractor = transformers.pipeline as unknown as (
      task: "feature-extraction",
      model: string | undefined,
      options: { revision?: string; dtype?: unknown },
    ) => Promise<FeatureExtractionPipeline>;

    class ReusableDefaultEmbeddingFunction extends DefaultEmbeddingFunction {
      private extractor?: Promise<FeatureExtractionPipeline>;

      async generate(texts: string[]): Promise<number[][]> {
        const { model_name, revision, dtype } = this.getConfig();
        this.extractor ??= createExtractor("feature-extraction", model_name, { revision, dtype });
        let extractor: FeatureExtractionPipeline;
        try {
          extractor = await this.extractor;
        } catch {
          this.extractor = undefined;
          throw new AppError(503, "EMBEDDING_MODEL_UNAVAILABLE", "Could not load Chroma's default embedding model (all-MiniLM-L6-v2). The first run downloads about 90 MB into .cache/transformers; check your internet connection and retry.");
        }
        const output = await extractor(texts, { pooling: "mean", normalize: true });
        return output.tolist() as number[][];
      }
    }
    return new ReusableDefaultEmbeddingFunction();
  })();
  return embeddingFunction;
}

export async function embedTexts(texts: string[], signal?: AbortSignal): Promise<number[][]> {
  const ef = await defaultEmbeddingFunction();
  const vectors: number[][] = [];
  for (let start = 0; start < texts.length; start += EMBED_BATCH_SIZE) {
    if (signal?.aborted) throw cancelledError();
    vectors.push(...await ef.generate(texts.slice(start, start + EMBED_BATCH_SIZE)));
  }
  return vectors;
}

function chromaError(chroma: ChromaModule, error: unknown, url: string, timedOut: boolean): AppError {
  if (error instanceof AppError) return error;
  // The SDK reports aborted fetches as connection errors, so check our timer first.
  if (timedOut) {
    return new AppError(504, "CHROMA_TIMEOUT", `ChromaDB at ${url} did not respond within ${CHROMA_TIMEOUT_MS / 1000} s. Check the Chroma terminal and retry.`);
  }
  if (error instanceof chroma.ChromaConnectionError) {
    return new AppError(503, "CHROMA_UNAVAILABLE", `Cannot reach ChromaDB at ${url}. Start it with "npm run chroma:start" and keep that terminal open.`);
  }
  if (error instanceof chroma.ChromaUnauthorizedError || error instanceof chroma.ChromaForbiddenError) {
    return new AppError(503, "CHROMA_ACCESS_DENIED", `ChromaDB at ${url} denied access. Check the server's authentication settings.`);
  }
  if (error instanceof chroma.ChromaNotFoundError || error instanceof chroma.InvalidCollectionError) {
    return new AppError(409, "CHROMA_COLLECTION_ERROR", "The Chroma collection is missing or invalid. Check the CHROMA_*_COLLECTION settings.");
  }
  if (error instanceof chroma.ChromaClientError || error instanceof chroma.ChromaValueError || error instanceof chroma.InvalidArgumentError) {
    // SDK messages can echo document text, so they are not passed through.
    return new AppError(502, "CHROMA_REQUEST_REJECTED", "ChromaDB rejected the request (invalid IDs, metadata, or embedding dimensions).");
  }
  if (error instanceof chroma.ChromaServerError) {
    return new AppError(502, "CHROMA_SERVER_ERROR", "ChromaDB reported a server error. Check the Chroma terminal and free disk space.");
  }
  if (error instanceof chroma.ChromaRateLimitError) {
    return new AppError(503, "CHROMA_BUSY", "ChromaDB is busy. Retry in a moment.");
  }
  return new AppError(500, "CHROMA_ERROR", "The ChromaDB operation failed. Check the Chroma terminal output.");
}

/** Run one operation against a collection created with the default embedding function. */
export async function withCollection<T>(
  name: string,
  operation: (collection: Collection) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) throw cancelledError();
  const { host, port } = chromaSettings();
  const [chroma, ef] = await Promise.all([loadChroma(), defaultEmbeddingFunction()]);
  const timeout = AbortSignal.timeout(CHROMA_TIMEOUT_MS);
  const client = new chroma.ChromaClient({
    host,
    port,
    ssl: false,
    fetchOptions: { signal: signal ? AbortSignal.any([signal, timeout]) : timeout },
  });
  try {
    const collection = await client.getOrCreateCollection({
      name,
      embeddingFunction: ef,
      configuration: { hnsw: { space: "cosine" } },
    });
    return await operation(collection);
  } catch (error) {
    if (signal?.aborted) throw cancelledError();
    throw chromaError(chroma, error, `http://${host}:${port}`, timeout.aborted);
  }
}

/** Embed locally (batched), then upsert; stable IDs make re-imports idempotent. */
export async function upsertRecords(collection: string, records: ChromaRecord[], signal?: AbortSignal): Promise<number> {
  for (let start = 0; start < records.length; start += EMBED_BATCH_SIZE) {
    const batch = records.slice(start, start + EMBED_BATCH_SIZE);
    const embeddings = await embedTexts(batch.map((record) => record.document), signal);
    await withCollection(collection, (handle) => handle.upsert({
      ids: batch.map((record) => record.id),
      documents: batch.map((record) => record.document),
      metadatas: batch.map((record) => record.metadata),
      embeddings,
    }), signal);
  }
  return records.length;
}

export async function queryCollection(
  collection: string,
  text: string,
  options: { nResults: number; where?: Where },
  signal?: AbortSignal,
): Promise<ChromaMatch[]> {
  const [embedding] = await embedTexts([text], signal);
  return withCollection(collection, async (handle) => {
    const result = await handle.query({
      queryEmbeddings: [embedding],
      nResults: options.nResults,
      where: options.where,
      include: ["documents", "metadatas", "distances"],
    });
    return (result.ids[0] ?? []).map((id, index) => ({
      id,
      document: result.documents[0]?.[index] ?? "",
      metadata: result.metadatas[0]?.[index] ?? {},
      distance: result.distances[0]?.[index] ?? null,
    }));
  }, signal);
}

export async function deleteRecords(collection: string, where: Where, signal?: AbortSignal): Promise<void> {
  await withCollection(collection, (handle) => handle.delete({ where }), signal);
}
