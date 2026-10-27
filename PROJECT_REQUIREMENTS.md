# Hallucination Checker for RAG: functional scope

Source: the four project slides supplied on 2026-10-27. The current request is to complete the functions first and preserve the existing design. The earlier backend-only restriction is superseded only for the functional controls and verdict/evidence display required by these slides.

| Slide requirement | Implementation |
| --- | --- |
| Accept a question, retrieved passages, and an answer | Existing `/api/verify`; manual-check controls in the app |
| Pull context and answers from a RAG pipeline | Local Hugging Face -> MiniLM -> Chroma ingestion, `/api/rag`, existing `/api/chat` |
| Split answers into individually testable claims | Separate structured claim-extraction Groq call |
| Judge Supported, Contradicted, Unsupported | Context-only verification; missing information is Unsupported |
| Show a supporting/contradicting sentence and confidence | Exact passage quotations, source IDs, model confidence, brief reasons |
| Compute overall faithfulness | Supported claims / all extracted claims, as a percentage; no claims means null |
| Color answer text by verdict | Validated original-answer spans, rendered as safe text with verdict colors and labels |
| Expand evidence | Keyboard-accessible expandable claim/evidence views |
| Batch-check a file of Q/A pairs | Bounded JSON/JSONL upload API and local CLI |
| Output a batch report | Per-item verdicts/errors, claim totals, weighted faithfulness, downloadable report |

No visual redesign, new deployment configuration, or change of database/model provider is included. Semantic verdicts and model confidence remain fallible; source quotation checks validate the quoted text exists, not that the LLM's reasoning is infallible. Generated answers are retained alongside their verification results.

Use `README.md` for setup, inputs, commands, and limits. Use `HANDOFF.md` for actual verification results and continuation instructions.
