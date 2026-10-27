import type { Passage, VerificationResult } from "../../lib/rag/types";
import { segmentAnswer } from "../../lib/rag/answer-spans";

export type DisplayPassage = Pick<Passage, "id" | "text" | "source">;

export function HighlightedAnswer({ answer, verification }: { answer: string; verification?: VerificationResult }) {
  const segments = verification ? segmentAnswer(answer, verification.claims) : [];
  return (
    <p className="verified-answer">
      {segments.length ? segments.map(segment => segment.verdict ? (
        <mark key={segment.start} className={`verdict-${segment.verdict.toLowerCase()}`} title={`${segment.verdict}: ${segment.claimIds.join(", ")}`}>
          <span className="sr-only">[{segment.verdict}] </span>{segment.text}
        </mark>
      ) : <span key={segment.start}>{segment.text}</span>) : answer}
    </p>
  );
}

export function VerificationView({ verification, context }: { verification: VerificationResult; context?: DisplayPassage[] }) {
  return (
    <section className="verification-view" aria-label="Answer verification">
      <p className="verification-score"><strong>Faithfulness: {verification.faithfulnessScore === null ? "N/A — no testable claims" : `${verification.faithfulnessScore}%`}</strong></p>
      <p className="verification-note">{verification.supportedClaims} Supported · {verification.contradictedClaims} Contradicted · {verification.unsupportedClaims} Unsupported ({verification.totalClaims} total)</p>
      <p className="verification-note">Checks support in the supplied passages. Confidence is a model estimate, not a guarantee of truth. Unhighlighted text has no verified claim mapping.</p>
      <div className="verdict-legend" aria-label="Answer highlight legend">
        <span className="verdict-supported">Supported</span><span className="verdict-contradicted">Contradicted</span><span className="verdict-unsupported">Unsupported</span>
      </div>
      {verification.claims.map((claim, index) => (
        <details className="claim-evidence" key={claim.id}>
          <summary><span className={`verdict-label verdict-${claim.verdict.toLowerCase()}`}>{claim.verdict}</span> Claim {index + 1}: {claim.claim} <span className="claim-confidence">({Math.round(claim.confidence * 100)}% confidence)</span></summary>
          <div className="evidence-content">
            <p>{claim.reason}</p>
            {claim.evidence.length ? claim.evidence.map((evidence, evidenceIndex) => (
              <figure key={`${evidence.passageId}-${evidenceIndex}`}>
                <blockquote>{evidence.quote}</blockquote>
                <figcaption>Source: {evidence.source} · Passage: {evidence.passageId}</figcaption>
              </figure>
            )) : <p>No matching evidence was found in the supplied passages.</p>}
          </div>
        </details>
      ))}
      {context ? <details className="claim-evidence"><summary>Retrieved / supplied passages ({context.length})</summary>
        <div className="evidence-content">{context.length ? context.map(passage => (
          <article key={passage.id}><strong>{passage.id}</strong><p className="verification-note">Source: {passage.source}</p><p>{passage.text}</p></article>
        )) : <p>No passages supplied.</p>}</div>
      </details> : null}
    </section>
  );
}
