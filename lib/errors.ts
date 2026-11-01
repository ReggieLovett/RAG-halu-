/** An error whose message is safe to show to the user, with an HTTP status. */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "APIUserAbortError");
}

export function cancelledError(): AppError {
  return new AppError(499, "REQUEST_CANCELLED", "The request was cancelled.");
}

/** Convert anything thrown into a code/message pair for per-item reporting. */
export function describeError(error: unknown): { code: string; message: string } {
  if (error instanceof AppError) return { code: error.code, message: error.message };
  if (isAbortError(error)) return { code: "REQUEST_CANCELLED", message: "The request was cancelled." };
  return { code: "INTERNAL_ERROR", message: "Unexpected server error." };
}
