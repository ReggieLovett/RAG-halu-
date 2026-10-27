import path from "node:path";
import type { FeatureExtractionPipeline } from "@huggingface/transformers";
import { RagError } from "./errors";

export const EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";
// Immutable Hub revision: ingestion and retrieval must use identical weights.
export const EMBEDDING_REVISION = "751bff37182d3f1213fa05d7196b954e230abad9";
export const EMBEDDING_DIMENSIONS = 384;
export const EMBEDDING_DTYPE = "q8";
export const EMBEDDING_VERSION = "minilm-mean-normalized-v1";
export const EMBEDDING_MAX_TOKENS = 256;

let extractorPromise: Promise<FeatureExtractionPipeline> | undefined;

function getExtractor(): Promise<FeatureExtractionPipeline> {
  if (!extractorPromise) {
    extractorPromise = (async () => {
      // No ONNX initialization or model download during route import / next build.
      const { env, pipeline } = await import("@huggingface/transformers");
      env.cacheDir = path.resolve(process.cwd(), ".cache", "transformers");
      env.useFSCache = true;
      env.allowLocalModels = false;
      return pipeline("feature-extraction", EMBEDDING_MODEL, {
        revision: EMBEDDING_REVISION,
        dtype: EMBEDDING_DTYPE,
        device: "cpu",
      });
    })().catch(() => {
      extractorPromise = undefined;
      throw new RagError(
        "Could not load the local embedding model. The first run needs internet access to download Hugging Face weights into .cache/transformers; retry when connected.",
        503,
        "EMBEDDING_UNAVAILABLE",
      );
    });
  }
  return extractorPromise;
}

async function waitFor<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  const timeout = AbortSignal.timeout(180_000);
  const combined = signal ? AbortSignal.any([timeout, signal]) : timeout;
  combined.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal?.aborted ? signal.reason : new RagError(
      "Local embedding timed out. The first model download may still be running; retry after it completes.",
      503,
      "EMBEDDING_TIMEOUT",
    ));
    combined.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => combined.removeEventListener("abort", abort));
  });
}

export async function embedTexts(texts: string[], signal?: AbortSignal): Promise<number[][]> {
  signal?.throwIfAborted();
  if (texts.length === 0) return [];
  if (texts.length > 64 || texts.some((text) => !text.trim())) {
    throw new RagError("Embed between 1 and 64 nonempty texts per batch.", 400, "INVALID_EMBEDDING_INPUT");
  }
  const extractor = await waitFor(getExtractor(), signal);
  // FeatureExtractionPipeline truncates by default. Check every input first so a
  // long query or unusual dataset text cannot silently lose its final facts.
  for (const text of texts) {
    signal?.throwIfAborted();
    const tokens = extractor.tokenizer(text, { truncation: false, padding: false });
    if (tokens.input_ids.dims[1] > EMBEDDING_MAX_TOKENS) {
      throw new RagError(
        `Text exceeds the local embedding limit of ${EMBEDDING_MAX_TOKENS} tokens. Shorten the question or reduce HF_CHUNK_SIZE before ingesting.`,
        400,
        "EMBEDDING_TEXT_TOO_LONG",
      );
    }
  }
  let vectors: number[][];
  try {
    const output = await waitFor(extractor(texts, { pooling: "mean", normalize: true }), signal);
    vectors = output.tolist() as number[][];
  } catch (error) {
    if (error instanceof RagError || signal?.aborted) throw error;
    throw new RagError("Local embedding inference failed; retry the request.", 503, "EMBEDDING_FAILED");
  }
  if (vectors.length !== texts.length || vectors.some((vector) =>
    vector.length !== EMBEDDING_DIMENSIONS || vector.some((number) => !Number.isFinite(number))
  )) {
    throw new RagError("Embedding model returned invalid vectors.", 503, "INVALID_EMBEDDINGS");
  }
  return vectors;
}
