import { AppError } from "./errors";

// Llama 3.x 70B models have been retired on Groq; gpt-oss-120b is the strongest
// generally available text model. Override with GROQ_CHAT_MODEL / GROQ_CHECKER_MODEL.
export const DEFAULT_GROQ_MODEL = "openai/gpt-oss-120b";

function text(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function integer(name: string, fallback: number, min: number, max: number): number {
  const raw = text(name);
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new AppError(500, "INVALID_CONFIGURATION", `${name} must be an integer from ${min} to ${max}.`);
  }
  return value;
}

export function groqSettings() {
  const shared = text("GROQ_MODEL");
  return {
    apiKey: text("GROQ_API_KEY"),
    chatModel: text("GROQ_CHAT_MODEL") ?? shared ?? DEFAULT_GROQ_MODEL,
    checkerModel: text("GROQ_CHECKER_MODEL") ?? shared ?? DEFAULT_GROQ_MODEL,
    timeoutMs: integer("GROQ_TIMEOUT_MS", 60_000, 1_000, 600_000),
    /** Retries for timeouts, network errors, and 5xx responses. */
    maxRetries: integer("GROQ_MAX_RETRIES", 2, 0, 6),
    /** Total time one request may spend waiting out 429 rate limits. */
    rateLimitWaitMs: integer("GROQ_RATE_LIMIT_WAIT_MS", 90_000, 0, 600_000),
  };
}

const COLLECTION_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{1,61}[a-zA-Z0-9]$/;

function collectionName(name: string, fallback: string): string {
  const value = text(name) ?? fallback;
  if (!COLLECTION_NAME.test(value)) {
    throw new AppError(500, "INVALID_CONFIGURATION", `${name} must be 3-63 letters, digits, dots, underscores, or hyphens.`);
  }
  return value;
}

export function chromaSettings() {
  return {
    host: text("CHROMA_HOST") ?? "localhost",
    port: integer("CHROMA_PORT", 8000, 1, 65_535),
    documentsCollection: collectionName("CHROMA_DOCUMENTS_COLLECTION", "uploaded_documents"),
    hfCollection: collectionName("CHROMA_HF_COLLECTION", "hf_test_contexts"),
  };
}

export const LIMITS = {
  uploadBytes: 20 * 1024 * 1024,
  documentCharacters: 2_000_000,
  questionCharacters: 4_000,
  answerCharacters: 20_000,
  contextCharacters: 60_000,
  chatMessages: 50,
  chatTopK: { min: 1, max: 10, default: 5 },
  batchItems: 50,
  batchConcurrency: { min: 1, max: 5, default: 2 },
  hfRows: { max: 50, default: 10 },
  maxClaims: 40,
} as const;

/** Confidence a claim needs in Healthcare (strict) mode to stay "Supported". */
export const STRICT_SUPPORT_THRESHOLD = 0.95;
