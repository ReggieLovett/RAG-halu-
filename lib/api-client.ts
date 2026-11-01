// Browser-side helpers for calling the API routes. Client-safe.
import type { ApiErrorBody } from "./types";

export class ApiRequestError extends Error {
  constructor(message: string, public readonly status: number, public readonly code: string) {
    super(message);
    this.name = "ApiRequestError";
  }
}

export async function apiRequest<T>(url: string, init: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw new ApiRequestError("Could not reach the local server. Is `npm run dev` still running?", 0, "NETWORK_ERROR");
  }
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const failure = body as Partial<ApiErrorBody> | null;
    const details = failure?.details?.map((detail) => `${detail.path || "body"}: ${detail.message}`).join("; ");
    throw new ApiRequestError(
      `${failure?.error ?? `Request failed with HTTP ${response.status}.`}${details ? ` (${details})` : ""}`,
      response.status,
      failure?.code ?? "HTTP_ERROR",
    );
  }
  return body as T;
}

export function postJson<T>(url: string, body: unknown, signal?: AbortSignal): Promise<T> {
  return apiRequest<T>(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.name === "AbortError") return "Request cancelled.";
  return error instanceof Error ? error.message : "Something went wrong.";
}
