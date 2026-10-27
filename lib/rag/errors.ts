export class RagError extends Error {
  constructor(message: string, public readonly status = 500, public readonly code = "RAG_ERROR") {
    super(message);
    this.name = "RagError";
  }
}
