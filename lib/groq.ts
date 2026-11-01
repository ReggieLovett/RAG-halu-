import Groq, {
  APIConnectionError, APIConnectionTimeoutError, APIError, APIUserAbortError,
  AuthenticationError, BadRequestError, NotFoundError, PermissionDeniedError, RateLimitError,
} from "groq-sdk";
import type {
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionMessageParam,
} from "groq-sdk/resources/chat/completions";
import { z } from "zod";
import { groqSettings } from "./config";
import { AppError, cancelledError, isAbortError } from "./errors";

type Settings = ReturnType<typeof groqSettings>;

let cached: { signature: string; client: Groq } | undefined;

function client(settings: Settings & { apiKey: string }): Groq {
  // Rebuild when .env.local changes under `next dev`.
  const signature = `${settings.apiKey}:${settings.timeoutMs}`;
  if (cached?.signature !== signature) {
    cached = {
      signature,
      // Retries are handled in complete(), which treats 429s differently.
      client: new Groq({ apiKey: settings.apiKey, timeout: settings.timeoutMs, maxRetries: 0 }),
    };
  }
  return cached.client;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(cancelledError());
    const onAbort = () => {
      clearTimeout(timer);
      reject(cancelledError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export type RetryHistory = { rateLimits: number; failures: number; waitedMs: number };

/**
 * Milliseconds to wait before retrying, or null when the error is final.
 * Free-tier keys allow only a few thousand tokens per minute, so a 429 means
 * "wait": it backs off (honouring retry-after) until the wait budget is spent.
 * Timeouts, network errors, and 5xx responses get GROQ_MAX_RETRIES retries.
 */
export function retryDelayMs(
  error: unknown,
  { rateLimits, failures, waitedMs }: RetryHistory,
  { maxRetries, rateLimitWaitMs }: Pick<Settings, "maxRetries" | "rateLimitWaitMs">,
): number | null {
  if (error instanceof RateLimitError) {
    const retryAfter = Number(error.headers?.get("retry-after"));
    const base = Math.max(Number.isFinite(retryAfter) ? retryAfter * 1_000 : 0, 1_000 * 2 ** rateLimits);
    const delay = Math.min(base, 30_000) + Math.random() * 500;
    return waitedMs + delay <= rateLimitWaitMs ? delay : null;
  }
  if (failures >= maxRetries || error instanceof APIUserAbortError) return null;
  const transient = error instanceof APIConnectionError || (error instanceof APIError && (error.status ?? 0) >= 500);
  return transient ? 1_000 * 2 ** failures : null;
}

function isGptOss(model: string): boolean {
  return model.startsWith("openai/gpt-oss");
}

/** Keep reasoning traces out of `content` for reasoning models. */
function reasoningOptions(model: string): Partial<ChatCompletionCreateParamsNonStreaming> {
  if (isGptOss(model)) {
    const effort = process.env.GROQ_REASONING_EFFORT?.trim() || "low";
    if (!["low", "medium", "high"].includes(effort)) {
      throw new AppError(500, "INVALID_CONFIGURATION", "GROQ_REASONING_EFFORT must be low, medium, or high.");
    }
    return { reasoning_effort: effort as "low" | "medium" | "high", include_reasoning: false };
  }
  if (model.startsWith("qwen/")) return { reasoning_format: "hidden" };
  return {};
}

function upstreamMessage(error: APIError): string {
  const body = error.error as { message?: unknown } | undefined;
  const message = typeof body?.message === "string" ? body.message : error.message;
  // Groq messages can name the organization; nothing else in them is sensitive.
  return message.replace(/org_[A-Za-z0-9]+/g, "org_…").slice(0, 300);
}

/** Map groq-sdk failures to user-facing errors with actionable messages. */
export function toAppError(
  error: unknown,
  model: string,
  { timeoutMs, maxRetries, rateLimitWaitMs }: Pick<Settings, "timeoutMs" | "maxRetries" | "rateLimitWaitMs">,
): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof APIUserAbortError || isAbortError(error)) return cancelledError();
  if (error instanceof APIConnectionTimeoutError) {
    return new AppError(504, "GROQ_TIMEOUT", `Groq did not respond within ${Math.round(timeoutMs / 1000)} s (${maxRetries} retries attempted). Try again or shorten the context; GROQ_TIMEOUT_MS raises the limit.`);
  }
  if (error instanceof APIConnectionError) {
    return new AppError(502, "GROQ_UNREACHABLE", "Could not reach the Groq API. Check your internet connection and try again.");
  }
  if (error instanceof AuthenticationError) {
    return new AppError(502, "GROQ_AUTH_FAILED", "Groq rejected GROQ_API_KEY. Check the key in .env.local, then restart the dev server.");
  }
  if (error instanceof PermissionDeniedError) {
    return new AppError(502, "GROQ_PERMISSION_DENIED", `This Groq API key may not use ${model}: ${upstreamMessage(error)}`);
  }
  if (error instanceof NotFoundError) {
    return new AppError(502, "GROQ_MODEL_UNAVAILABLE", `Groq model "${model}" is not available to this API key. Set GROQ_CHAT_MODEL / GROQ_CHECKER_MODEL in .env.local.`);
  }
  if (error instanceof RateLimitError) {
    const waited = rateLimitWaitMs > 0 ? ` and stayed limited after waiting up to ${Math.round(rateLimitWaitMs / 1000)} s` : "";
    return new AppError(429, "GROQ_RATE_LIMITED", `Groq rate limit reached for ${model}${waited}. Your plan's tokens-per-minute or requests-per-day limit is the usual cause: wait a minute, then retry with fewer items or lower batch concurrency.`);
  }
  if (error instanceof APIError && error.status === 413) {
    return new AppError(413, "GROQ_REQUEST_TOO_LARGE", `The prompt is too large for this Groq plan: ${upstreamMessage(error)} Shorten the context or answer.`);
  }
  if (error instanceof BadRequestError) {
    const code = (error.error as { code?: unknown } | undefined)?.code;
    if (code === "json_validate_failed") {
      return new AppError(502, "GROQ_INVALID_JSON", "Groq could not produce valid JSON for this request.");
    }
    return new AppError(502, "GROQ_BAD_REQUEST", `Groq rejected the request: ${upstreamMessage(error)}`);
  }
  if (error instanceof APIError) {
    return new AppError(502, "GROQ_UPSTREAM_ERROR", `Groq returned HTTP ${error.status ?? "error"}. Try again shortly.`);
  }
  return new AppError(502, "GROQ_REQUEST_FAILED", "The Groq request failed unexpectedly. Try again.");
}

async function complete(
  params: ChatCompletionCreateParamsNonStreaming,
  signal?: AbortSignal,
): Promise<{ content: string; finishReason: string }> {
  const settings = groqSettings();
  const { apiKey } = settings;
  if (!apiKey) {
    throw new AppError(500, "GROQ_NOT_CONFIGURED", "GROQ_API_KEY is not set. Add it to .env.local and restart the dev server.");
  }
  if (signal?.aborted) throw cancelledError();
  const groq = client({ ...settings, apiKey });
  const history: RetryHistory = { rateLimits: 0, failures: 0, waitedMs: 0 };
  while (true) {
    try {
      const completion = await groq.chat.completions.create(params, { signal });
      const choice = completion.choices[0];
      return { content: choice?.message?.content ?? "", finishReason: choice?.finish_reason ?? "unknown" };
    } catch (error) {
      const delay = signal?.aborted ? null : retryDelayMs(error, history, settings);
      if (delay === null) throw toAppError(error, params.model, settings);
      if (error instanceof RateLimitError) history.rateLimits++;
      else history.failures++;
      history.waitedMs += delay;
      await sleep(delay, signal);
    }
  }
}

export type TextCompletionRequest = {
  model: string;
  messages: ChatCompletionMessageParam[];
  maxTokens: number;
  temperature?: number;
  signal?: AbortSignal;
};

export async function groqText(request: TextCompletionRequest): Promise<{ text: string; truncated: boolean }> {
  const { content, finishReason } = await complete({
    model: request.model,
    messages: request.messages,
    temperature: request.temperature ?? 0.2,
    max_completion_tokens: request.maxTokens,
    ...reasoningOptions(request.model),
  }, request.signal);
  if (!content.trim()) {
    throw new AppError(502, "GROQ_EMPTY_RESPONSE", "Groq returned an empty response. Try again.");
  }
  return { text: content.trim(), truncated: finishReason === "length" };
}

export type JsonCompletionRequest<T> = {
  model: string;
  system: string;
  /** Sent as the JSON user message; prompts must treat it as data. */
  data: unknown;
  schema: z.ZodType<T>;
  schemaName: string;
  maxTokens: number;
  signal?: AbortSignal;
};

export type JsonCompleter = <T>(request: JsonCompletionRequest<T>) => Promise<T>;

const jsonSchemas = new WeakMap<z.ZodType, Record<string, unknown>>();

function jsonSchemaFor(schema: z.ZodType): Record<string, unknown> {
  let value = jsonSchemas.get(schema);
  if (!value) {
    const { $schema: _ignored, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>;
    value = rest;
    jsonSchemas.set(schema, value);
  }
  return value;
}

export function parseJsonContent(content: string): unknown {
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new SyntaxError("No JSON object found.");
  }
}

/**
 * Structured completion validated against a zod schema. gpt-oss models get
 * Groq's strict JSON-schema decoding; other models get JSON mode plus the
 * schema in the prompt. One corrective retry, then a 502.
 */
export const groqJson: JsonCompleter = async <T>(request: JsonCompletionRequest<T>): Promise<T> => {
  const schema = jsonSchemaFor(request.schema);
  const strict = isGptOss(request.model);
  const system = strict
    ? request.system
    : `${request.system}\n\nRespond with one JSON object that matches this JSON Schema:\n${JSON.stringify(schema)}`;
  const responseFormat: ChatCompletionCreateParamsNonStreaming["response_format"] = strict
    ? { type: "json_schema", json_schema: { name: request.schemaName, schema, strict: true } }
    : { type: "json_object" };

  let feedback: string | undefined;
  let maxTokens = request.maxTokens;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const messages: ChatCompletionMessageParam[] = [
      { role: "system", content: system },
      { role: "user", content: JSON.stringify(request.data) },
    ];
    if (feedback) messages.push({ role: "user", content: feedback });

    let result: { content: string; finishReason: string };
    try {
      result = await complete({
        model: request.model,
        messages,
        temperature: 0,
        max_completion_tokens: maxTokens,
        response_format: responseFormat,
        ...reasoningOptions(request.model),
      }, request.signal);
    } catch (error) {
      if (attempt === 1 && error instanceof AppError && error.code === "GROQ_INVALID_JSON") {
        feedback = "Your previous reply was not valid JSON. Reply with only the JSON object.";
        continue;
      }
      throw error;
    }

    if (result.finishReason === "length") {
      feedback = "Your previous reply was cut off at the token limit. Reply with the complete JSON object and keep every string brief.";
      maxTokens *= 2;
      continue;
    }
    let value: unknown;
    try {
      value = parseJsonContent(result.content);
    } catch {
      feedback = "Your previous reply was not valid JSON. Reply with only the JSON object.";
      continue;
    }
    const parsed = request.schema.safeParse(value);
    if (parsed.success) return parsed.data;
    const issues = parsed.error.issues.slice(0, 5).map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ");
    feedback = `Your previous reply did not match the required schema (${issues}). Reply with only the corrected JSON object.`;
  }
  throw new AppError(502, "GROQ_INVALID_JSON", `Groq returned invalid ${request.schemaName} JSON twice, so no result was produced. Try again.`);
};
