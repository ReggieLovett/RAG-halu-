import { ChromaClient, ChromaNotFoundError, type Collection } from "chromadb";
import {
  EMBEDDING_DIMENSIONS, EMBEDDING_DTYPE, EMBEDDING_MODEL, EMBEDDING_REVISION,
  EMBEDDING_VERSION, embedTexts,
} from "./embeddings";
import { RagError } from "./errors";
import type { Passage } from "./types";

export type IngestedChunk = {
  id: string;
  text: string;
  metadata: Record<string, string | number | boolean>;
};

const COLLECTION_METADATA = {
  embedding_model: EMBEDDING_MODEL,
  embedding_revision: EMBEDDING_REVISION,
  embedding_dimensions: EMBEDDING_DIMENSIONS,
  embedding_dtype: EMBEDDING_DTYPE,
  embedding_version: EMBEDDING_VERSION,
  distance_metric: "cosine",
};

export function chromaSettings() {
  const host = (process.env.CHROMA_HOST || "127.0.0.1").trim();
  if (!["localhost", "127.0.0.1", "::1"].includes(host)) {
    throw new RagError("CHROMA_HOST must be a loopback address for this local project.", 500, "INVALID_CHROMA_CONFIG");
  }
  const port = Number(process.env.CHROMA_PORT || "8000");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new RagError("CHROMA_PORT must be an integer between 1 and 65535.", 500, "INVALID_CHROMA_CONFIG");
  }
  const name = (process.env.CHROMA_COLLECTION || "rag_hf_minilm_v1").trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{1,61}[a-zA-Z0-9]$/.test(name)) {
    throw new RagError("CHROMA_COLLECTION must be 3–63 letters, digits, underscores or hyphens.", 500, "INVALID_CHROMA_CONFIG");
  }
  // The SDK builds an HTTP URL from host:port; IPv6 literals need brackets.
  return { host: host === "::1" ? "[::1]" : host, port, name };
}

export function validateCollection(collection: Pick<Collection, "metadata" | "configuration">): void {
  for (const [key, expected] of Object.entries(COLLECTION_METADATA)) {
    if (collection.metadata?.[key] !== expected) {
      throw new RagError(
        `Chroma collection embedding metadata does not match (${key}). Choose a new CHROMA_COLLECTION and rerun ingestion.`,
        409,
        "EMBEDDING_COLLECTION_MISMATCH",
      );
    }
  }
  if (collection.configuration.hnsw?.space !== "cosine") {
    throw new RagError("Chroma collection must use cosine distance. Choose a new collection and ingest again.", 409, "EMBEDDING_COLLECTION_MISMATCH");
  }
}

async function withCollection<T>(
  create: boolean,
  operation: (collection: Collection) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const { host, port, name } = chromaSettings();
  for (let attempt = 0; attempt < 3; attempt++) {
    signal?.throwIfAborted();
    const timeout = AbortSignal.timeout(15_000);
    const client = new ChromaClient({
      host, port, ssl: false,
      fetchOptions: { signal: signal ? AbortSignal.any([signal, timeout]) : timeout },
    });
    try {
      const collection = create
        ? await client.getOrCreateCollection({
          name,
          embeddingFunction: null,
          metadata: COLLECTION_METADATA,
          configuration: { hnsw: { space: "cosine" } },
        })
        : await client.getCollection({ name });
      validateCollection(collection);
      return await operation(collection);
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (error instanceof RagError) throw error;
      if (error instanceof ChromaNotFoundError) {
        throw new RagError("The local Chroma collection does not exist. Run npm run ingest:hf first.", 409, "COLLECTION_NOT_FOUND");
      }
      if (attempt === 2) {
        throw new RagError(
          `Cannot use local ChromaDB at ${host}:${port}. Start the local Chroma server and retry.`,
          503,
          "CHROMA_UNAVAILABLE",
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }
  }
  throw new RagError("Local ChromaDB is unavailable.", 503, "CHROMA_UNAVAILABLE");
}

export async function upsertChunks(chunks: IngestedChunk[], embeddings: number[][], signal?: AbortSignal): Promise<void> {
  if (chunks.length === 0) return;
  if (chunks.length !== embeddings.length || embeddings.some((vector) =>
    vector.length !== EMBEDDING_DIMENSIONS || vector.some((number) => !Number.isFinite(number))
  )) {
    throw new RagError("Chunk embeddings have invalid count or dimensions.", 400, "INVALID_EMBEDDINGS");
  }
  await withCollection(true, (collection) => collection.upsert({
    ids: chunks.map((chunk) => chunk.id),
    documents: chunks.map((chunk) => chunk.text),
    metadatas: chunks.map((chunk) => chunk.metadata),
    embeddings,
  }), signal);
}

export async function retrievePassages(question: string, topK: number, signal?: AbortSignal): Promise<Passage[]> {
  if (!question.trim() || !Number.isInteger(topK) || topK < 1 || topK > 10) {
    throw new RagError("Retrieval needs a nonempty question and topK between 1 and 10.", 400, "INVALID_RETRIEVAL_INPUT");
  }
  // Check database before downloading weights on an unconfigured installation.
  const count = await withCollection(false, (collection) => collection.count(), signal);
  if (count === 0) return [];
  const embeddings = await embedTexts([question], signal);
  return withCollection(false, async (collection) => {
    const result = await collection.query({
      queryEmbeddings: embeddings,
      nResults: Math.min(topK, count),
      include: ["documents", "metadatas", "distances"],
    });
    return result.ids[0].map((id, index) => {
      const text = result.documents[0]?.[index];
      if (typeof text !== "string" || !text.trim()) {
        throw new RagError("Retrieved Chroma record has no document text. Reingest into a new collection.", 409, "INVALID_CHROMA_RECORD");
      }
      const metadata: Passage["metadata"] = {};
      for (const [key, value] of Object.entries(result.metadatas[0]?.[index] || {})) {
        if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") metadata[key] = value;
      }
      return { id, text, source: String(metadata.source || "Local ChromaDB"), distance: result.distances[0]?.[index] ?? null, metadata };
    });
  }, signal);
}
