export type Passage = {
  id: string;
  text: string;
  source: string;
  distance: number | null;
  metadata: Record<string, string | number | boolean>;
};

export type Evidence = { passageId: string; quote: string; source: string };
export type Verdict = "Supported" | "Contradicted" | "Unsupported";
/** Exact original answer text, with UTF-16 offsets and an exclusive end. */
export type AnswerSpan = { start: number; end: number; text: string };
export type VerifiedClaim = {
  id: string;
  claim: string;
  verdict: Verdict;
  evidence: Evidence[];
  confidence: number;
  reason: string;
  answerSpans?: AnswerSpan[];
};

export type VerificationResult = {
  claims: VerifiedClaim[];
  faithfulnessScore: number | null;
  supportedClaims: number;
  contradictedClaims: number;
  unsupportedClaims: number;
  totalClaims: number;
};
