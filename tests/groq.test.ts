import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, it } from "node:test";
import { z } from "zod";
import { APIConnectionTimeoutError, BadRequestError, InternalServerError, RateLimitError } from "groq-sdk";
import { AppError } from "../lib/errors";
import { groqJson, groqText, retryDelayMs } from "../lib/groq";

// A local stand-in for api.groq.com, reached through GROQ_BASE_URL.
type Reply = (body: Record<string, unknown>, response: ServerResponse) => void | Promise<void>;
const replies: Reply[] = [];
const requests: Record<string, unknown>[] = [];

function completion(content: string, finishReason = "stop") {
  return { id: "x", object: "chat.completion", created: 0, model: "m", choices: [{ index: 0, finish_reason: finishReason, message: { role: "assistant", content } }] };
}

function send(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  response.writeHead(status, { "content-type": "application/json", ...headers });
  response.end(JSON.stringify(body));
}

const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
  let raw = "";
  for await (const chunk of request) raw += chunk;
  const body = JSON.parse(raw) as Record<string, unknown>;
  requests.push(body);
  const reply = replies.shift();
  if (!reply) return send(response, 500, { error: { message: "no reply queued" } });
  await reply(body, response);
});

const schema = z.object({ answer: z.string(), score: z.number() });
const ask = (model = "openai/gpt-oss-120b") => groqJson({ model, system: "sys", data: { q: 1 }, schema, schemaName: "test_schema", maxTokens: 100 });
const failsWith = (code: string) => (error: unknown) => error instanceof AppError && error.code === code;

describe("Groq client", () => {
  before(async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    process.env.GROQ_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    process.env.GROQ_API_KEY = "test-key";
    process.env.GROQ_TIMEOUT_MS = "1000";
    process.env.GROQ_MAX_RETRIES = "0";
    process.env.GROQ_RATE_LIMIT_WAIT_MS = "0";
  });
  beforeEach(() => {
    replies.length = 0;
    requests.length = 0;
  });
  after(() => server.close());

  it("uses strict JSON-schema decoding for gpt-oss and validates the reply", async () => {
    requests.length = 0;
    replies.push((_, response) => send(response, 200, completion('{"answer":"yes","score":1}')));
    assert.deepEqual(await ask(), { answer: "yes", score: 1 });
    const format = requests[0].response_format as { type: string; json_schema: { name: string; strict: boolean; schema: Record<string, unknown> } };
    assert.equal(format.type, "json_schema");
    assert.equal(format.json_schema.strict, true);
    assert.equal(format.json_schema.name, "test_schema");
    assert.equal(format.json_schema.schema.additionalProperties, false);
    assert.equal(format.json_schema.schema.$schema, undefined);
    assert.equal(requests[0].include_reasoning, false);
    assert.equal(requests[0].temperature, 0);
  });

  it("falls back to JSON mode with the schema in the prompt for other models", async () => {
    requests.length = 0;
    replies.push((_, response) => send(response, 200, completion('```json\n{"answer":"ok","score":2}\n```')));
    assert.deepEqual(await ask("qwen/qwen3.8-27b"), { answer: "ok", score: 2 });
    assert.deepEqual(requests[0].response_format, { type: "json_object" });
    assert.match((requests[0].messages as { content: string }[])[0].content, /JSON Schema/);
    assert.equal(requests[0].reasoning_format, "hidden");
  });

  it("retries once with feedback after invalid or truncated JSON, then gives up", async () => {
    requests.length = 0;
    replies.push((_, response) => send(response, 200, completion('{"answer":"missing score"}')));
    replies.push((_, response) => send(response, 200, completion('{"answer":"fixed","score":3}')));
    assert.deepEqual(await ask(), { answer: "fixed", score: 3 });
    const feedback = (requests[1].messages as { content: string }[]).at(-1)!.content;
    assert.match(feedback, /did not match the required schema \(score:/);

    replies.push((_, response) => send(response, 200, completion('{"answer":', "length")));
    replies.push((_, response) => send(response, 200, completion("not json")));
    await assert.rejects(ask(), failsWith("GROQ_INVALID_JSON"));
    assert.equal(requests.at(-2)!.max_completion_tokens, 100);
    assert.equal(requests.at(-1)!.max_completion_tokens, 200);
  });

  it("turns a slow response into GROQ_TIMEOUT", async () => {
    replies.push(async (_, response) => {
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      send(response, 200, completion("late"));
    });
    const started = Date.now();
    await assert.rejects(groqText({ model: "openai/gpt-oss-120b", messages: [{ role: "user", content: "hi" }], maxTokens: 10 }), (error: unknown) =>
      error instanceof AppError && error.code === "GROQ_TIMEOUT" && error.status === 504 && /within 1 s/.test(error.message));
    assert.ok(Date.now() - started < 1_450);
  });

  it("maps rate limits, oversize prompts, retired models, and bad keys", async () => {
    const text = () => groqText({ model: "openai/gpt-oss-120b", messages: [{ role: "user", content: "hi" }], maxTokens: 10 });
    replies.push((_, response) => send(response, 429, { error: { message: "Rate limit reached for org_abc123" } }, { "retry-after": "7" }));
    await assert.rejects(text(), (error: unknown) => failsWith("GROQ_RATE_LIMITED")(error) && /tokens-per-minute/.test((error as Error).message));
    replies.push((_, response) => send(response, 413, { error: { message: "Request too large: Limit 8000, Requested 9000 for org_abc123" } }));
    await assert.rejects(text(), (error: unknown) => failsWith("GROQ_REQUEST_TOO_LARGE")(error) && /org_…/.test((error as Error).message));
    replies.push((_, response) => send(response, 404, { error: { message: "model not found" } }));
    await assert.rejects(text(), failsWith("GROQ_MODEL_UNAVAILABLE"));
    replies.push((_, response) => send(response, 401, { error: { message: "Invalid API Key" } }));
    await assert.rejects(text(), failsWith("GROQ_AUTH_FAILED"));
    replies.push((_, response) => send(response, 200, completion("   ")));
    await assert.rejects(text(), failsWith("GROQ_EMPTY_RESPONSE"));
  });

  it("waits out a 429 and retries a 5xx before succeeding", async () => {
    process.env.GROQ_RATE_LIMIT_WAIT_MS = "5000";
    process.env.GROQ_MAX_RETRIES = "1";
    try {
      requests.length = 0;
      replies.push((_, response) => send(response, 429, { error: { message: "slow down" } }, { "retry-after": "0" }));
      replies.push((_, response) => send(response, 503, { error: { message: "busy" } }));
      replies.push((_, response) => send(response, 200, completion("finally")));
      const started = Date.now();
      const result = await groqText({ model: "openai/gpt-oss-120b", messages: [{ role: "user", content: "hi" }], maxTokens: 10 });
      assert.equal(result.text, "finally");
      assert.equal(requests.length, 3);
      assert.ok(Date.now() - started >= 2_000, "backs off 1 s after the 429 and 1 s after the 503");
    } finally {
      process.env.GROQ_RATE_LIMIT_WAIT_MS = "0";
      process.env.GROQ_MAX_RETRIES = "0";
    }
  });

  it("reports a missing API key and honours cancellation", async () => {
    const key = process.env.GROQ_API_KEY;
    delete process.env.GROQ_API_KEY;
    await assert.rejects(ask(), failsWith("GROQ_NOT_CONFIGURED"));
    process.env.GROQ_API_KEY = key;

    const controller = new AbortController();
    replies.push(async (_, response) => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      send(response, 200, completion("{}"));
    });
    const pending = groqText({ model: "openai/gpt-oss-120b", messages: [{ role: "user", content: "hi" }], maxTokens: 10, signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    await assert.rejects(pending, failsWith("REQUEST_CANCELLED"));
  });
});

describe("retryDelayMs", () => {
  const limits = { maxRetries: 2, rateLimitWaitMs: 90_000 };
  const history = (rateLimits: number, failures: number, waitedMs = 0) => ({ rateLimits, failures, waitedMs });
  const rateLimited = (retryAfter?: string) =>
    new RateLimitError(429, { message: "x" }, "x", new Headers(retryAfter ? { "retry-after": retryAfter } : {}));

  it("backs off on 429 using retry-after, within the wait budget", () => {
    const first = retryDelayMs(rateLimited("7"), history(0, 0), limits)!;
    assert.ok(first >= 7_000 && first < 7_500);
    const growing = retryDelayMs(rateLimited(), history(3, 2), limits)!;
    assert.ok(growing >= 8_000 && growing < 8_500, "independent of the failure count");
    assert.ok(retryDelayMs(rateLimited(), history(10, 0), limits)! < 30_500, "capped at 30 s");
    assert.equal(retryDelayMs(rateLimited("7"), history(0, 0, 85_000), limits), null);
    assert.equal(retryDelayMs(rateLimited(), history(0, 0), { ...limits, rateLimitWaitMs: 0 }), null);
  });

  it("retries timeouts and 5xx up to GROQ_MAX_RETRIES, never 4xx", () => {
    assert.equal(retryDelayMs(new APIConnectionTimeoutError(), history(4, 0), limits), 1_000);
    assert.equal(retryDelayMs(new InternalServerError(500, {}, "x", new Headers()), history(0, 1), limits), 2_000);
    assert.equal(retryDelayMs(new APIConnectionTimeoutError(), history(0, 2), limits), null);
    assert.equal(retryDelayMs(new BadRequestError(400, {}, "x", new Headers()), history(0, 0), limits), null);
  });
});
