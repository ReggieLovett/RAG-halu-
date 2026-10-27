import assert from "node:assert/strict";
import test from "node:test";
import { apiErrorMessage, parseManualContext } from "../lib/rag/client-input";

test("manual plain text splits blank lines, preserving line breaks within a passage", () => {
  assert.deepEqual(parseManualContext(" first line\nsecond line\r\n\r\n Third passage ", "text"), [
    { id: "manual-1", text: "first line\nsecond line", source: "Pasted passage 1" },
    { id: "manual-2", text: "Third passage", source: "Pasted passage 2" }
  ]);
});

test("manual JSON preserves IDs and sources and supports an explicit empty context", () => {
  assert.deepEqual(parseManualContext('[{"id":" p1 ","text":" evidence ","source":" book "}]', "json"), [{ id: "p1", text: "evidence", source: "book" }]);
  assert.deepEqual(parseManualContext("[]", "json"), []);
  assert.deepEqual(parseManualContext("  ", "text"), []);
});

test("manual context rejects malformed JSON, duplicate IDs, and unexpected fields", () => {
  assert.throws(() => parseManualContext("{", "json"), /valid JSON/);
  assert.throws(() => parseManualContext("{}", "json"), /array/);
  assert.throws(() => parseManualContext('[{"id":"x","text":"a"},{"id":"x","text":"b"}]', "json"), /Duplicate/);
  assert.throws(() => parseManualContext('[{"id":"x","text":"a","metadata":{}}]', "json"), /only id/);
  assert.throws(() => parseManualContext('[{"id":1,"text":"a"}]', "json"), /string id/);
});

test("manual context applies passage count, per-passage, and aggregate bounds", () => {
  assert.throws(() => parseManualContext(Array.from({ length: 11 }, () => "x").join("\n\n"), "text"), /at most 10/);
  assert.throws(() => parseManualContext("x".repeat(6001), "text"), /6000/);
  assert.throws(() => parseManualContext(Array.from({ length: 5 }, () => "x".repeat(5000)).join("\n\n"), "text"), /24000/);
  assert.throws(() => parseManualContext('[{"id":"x","text":"a","source":""}]', "json"), /source/);
});

test("API errors include useful field-specific validation details", () => {
  assert.equal(apiErrorMessage({ error: "Invalid request.", details: [{ path: "context.0.id", message: "Required" }] }, "Failed"), "Invalid request. context.0.id: Required");
  assert.equal(apiErrorMessage(null, "Failed"), "Failed");
});
