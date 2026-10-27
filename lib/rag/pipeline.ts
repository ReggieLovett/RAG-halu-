import { retrievePassages } from "./chroma";
import { generateAnswer } from "./groq";
import { verifyAnswer } from "./verification";
import type { Passage, VerificationResult } from "./types";

type Dependencies = {
  retrieve: (question: string, topK: number, signal?: AbortSignal) => Promise<Passage[]>;
  generate: (question: string, passages: Passage[], signal?: AbortSignal) => Promise<string>;
  verify: (question: string, passages: Passage[], answer: string, signal?: AbortSignal) => Promise<VerificationResult>;
};

export function createRagPipeline(dependencies: Dependencies) {
  return async (question: string, topK = 5, signal?: AbortSignal) => {
    const context = await dependencies.retrieve(question, topK, signal);
    if (!context.length) {
      const answer = "I don't have any relevant passages in the local knowledge base to answer this question.";
      return {
        question, answer, message: answer, context, status: "no_context" as const,
        verification: {
          claims: [], faithfulnessScore: null, supportedClaims: 0,
          contradictedClaims: 0, unsupportedClaims: 0, totalClaims: 0
        } satisfies VerificationResult
      };
    }

    // The verifier receives exactly the passages used for generation.
    const answer = await dependencies.generate(question, context, signal);
    const verification = await dependencies.verify(question, context, answer, signal);
    return { question, answer, message: answer, context, status: "verified" as const, verification };
  };
}

export const runRag = createRagPipeline({
  retrieve: retrievePassages, generate: generateAnswer, verify: verifyAnswer
});
