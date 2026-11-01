// Shared request/response shapes for the API routes and the dashboard.
// Client-safe: this file must not import server-only modules.

export type Verdict = "Supported" | "Contradicted" | "Unsupported";
export const VERDICTS: readonly Verdict[] = ["Supported", "Contradicted", "Unsupported"];

export type ApiErrorBody = {
  error: string;
  code: string;
  details?: { path: string; message: string }[];
};

// ---------- Module 1: document chatbot ----------

export type ChatRole = "user" | "assistant";
export type ChatMessage = { role: ChatRole; content: string };

export type UploadedDocument = {
  documentId: string;
  fileName: string;
  fileType: "pdf" | "docx";
  pages: number | null;
  characters: number;
  chunks: number;
  collection: string;
  preview: string;
};

export type RetrievedChunk = {
  id: string;
  chunkIndex: number;
  text: string;
  /** Cosine distance from the question embedding; lower is closer. */
  distance: number | null;
};

/** Text pulled from a PDF/DOCX without storing it (used to fill the checker's context). */
export type ExtractedDocument = {
  fileName: string;
  fileType: "pdf" | "docx";
  pages: number | null;
  characters: number;
  text: string;
};

export type ChatRequest = {
  /** Omit for plain chat without a document. */
  documentId?: string | null;
  messages: ChatMessage[];
  topK?: number;
};

export type ChatResponse = {
  question: string;
  answer: string;
  /** Null for plain chat, where `context` is empty. */
  documentId: string | null;
  fileName: string | null;
  /** The excerpts the answer was generated from, in retrieval order. */
  context: RetrievedChunk[];
  /** `context` joined into the single string the checker expects. */
  contextText: string;
  model: string;
  durationMs: number;
};

// ---------- Module 2: verification engine ----------

export type CheckRequest = {
  question: string;
  /** Plain text, or several passages that are joined with blank lines. */
  context: string | string[];
  answer: string;
  strictnessMode?: boolean;
};

export type ClaimCheck = {
  id: string;
  claim: string;
  /** Final verdict after evidence validation and the strictness threshold. */
  verdict: Verdict;
  /** Verdict exactly as the model returned it. */
  modelVerdict: Verdict;
  /** Exact quote from the context, or "" when there is none. */
  evidence: string;
  /** True when `evidence` was located verbatim in the context. */
  evidenceFound: boolean;
  /**
   * Healthcare Mode only: whether the context states the claim literally (no
   * conversion, approximation, or inference). Null in standard mode.
   */
  literalMatch: boolean | null;
  /** Model-reported confidence in its verdict, 0.0 to 1.0. */
  confidence: number;
  reasoning: string;
  /** Why the final verdict differs from the model's, if it does. */
  adjustments: string[];
};

export type CheckMetrics = {
  /** Supported claims / total claims * 100; null when the answer has no claims. */
  faithfulness: number | null;
  /** 0-100: does the answer address the question? */
  answerRelevance: number;
  /** 0-100: did the context contain information useful for the question? */
  contextRelevance: number;
  answerRelevanceReason: string;
  contextRelevanceReason: string;
};

export type ClaimCounts = {
  total: number;
  supported: number;
  contradicted: number;
  unsupported: number;
};

export type CheckResult = {
  question: string;
  answer: string;
  contextCharacters: number;
  strictnessMode: boolean;
  /** Minimum confidence for "Supported" (0.95 in Healthcare Mode, which also requires a literal match), else null. */
  supportThreshold: number | null;
  claims: ClaimCheck[];
  counts: ClaimCounts;
  metrics: CheckMetrics;
  model: string;
  durationMs: number;
};

// ---------- Module 4: batch processing ----------

export type BatchItem = {
  id?: string;
  question: string;
  answer: string;
  context: string | string[];
  /** Free-form provenance, e.g. a Hugging Face row reference. */
  source?: string;
};

export type BatchCheckRequest = {
  items: BatchItem[];
  strictnessMode?: boolean;
  concurrency?: number;
};

type BatchItemBase = {
  index: number;
  id: string;
  question: string;
  answer: string;
  source?: string;
};

export type BatchItemResult =
  | (BatchItemBase & { status: "ok"; result: CheckResult })
  | (BatchItemBase & { status: "error"; error: { code: string; message: string } });

export type BatchSummary = {
  totalItems: number;
  succeeded: number;
  failed: number;
  totalClaims: number;
  supportedClaims: number;
  contradictedClaims: number;
  unsupportedClaims: number;
  /** All supported claims / all claims across successful items * 100. */
  overallFaithfulness: number | null;
  /** Mean of the per-item faithfulness scores that are not null. */
  averageFaithfulness: number | null;
  averageAnswerRelevance: number | null;
  averageContextRelevance: number | null;
  /** Successful items with at least one Contradicted or Unsupported claim. */
  itemsWithFailedClaims: number;
};

export type BatchReport = {
  createdAt: string;
  durationMs: number;
  strictnessMode: boolean;
  concurrency: number;
  model: string;
  summary: BatchSummary;
  results: BatchItemResult[];
};

// ---------- Module 3: Hugging Face importer ----------

export type HfImportRequest = {
  dataset: string;
  config?: string;
  split?: string;
  offset?: number;
  limit?: number;
  questionField?: string;
  answerField?: string;
  contextField?: string;
  /** Embed the fetched contexts into Chroma (default true). */
  embed?: boolean;
};

export type HfEmbeddingSummary =
  | { status: "ok"; collection: string; uniqueContexts: number; chunksUpserted: number }
  | { status: "skipped"; collection: string }
  | { status: "failed"; collection: string; code: string; message: string };

export type HfImportResponse = {
  dataset: string;
  config: string;
  split: string;
  offset: number;
  rowsFetched: number;
  totalRows: number | null;
  fields: { question: string; answer: string; context: string };
  /** Ready to POST as `items` to /api/batch-check. */
  items: BatchItem[];
  skipped: { rowIndex: number; reason: string }[];
  embedding: HfEmbeddingSummary;
  durationMs: number;
};
