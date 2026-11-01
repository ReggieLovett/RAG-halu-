import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chunkText, normalizeText } from "../lib/chunking";

describe("normalizeText", () => {
  it("collapses layout whitespace but keeps paragraph breaks", () => {
    assert.equal(normalizeText("  A\t\tline \r\nnext­word\n\n\n\nNew  paragraph "), "A line\nnextword\n\nNew paragraph");
  });
});

describe("chunkText", () => {
  const sentences = Array.from({ length: 30 }, (_, index) => `Sentence number ${index} states a distinct fact.`);
  const text = sentences.join(" ");

  it("packs whole sentences into chunks no longer than the limit", () => {
    const chunks = chunkText(text, 200, 60);
    assert.ok(chunks.length > 1);
    for (const chunk of chunks) {
      assert.ok(chunk.length <= 200, `chunk too long: ${chunk.length}`);
      assert.match(chunk, /^Sentence number \d+ .*fact\.$/);
    }
    // Every sentence survives chunking.
    for (const sentence of sentences) assert.ok(chunks.some((chunk) => chunk.includes(sentence)), sentence);
  });

  it("repeats trailing sentences as overlap", () => {
    const [first, second] = chunkText(text, 200, 60);
    const lastSentence = first.slice(first.lastIndexOf("Sentence number"));
    assert.ok(second.startsWith(lastSentence));
    assert.equal(chunkText(text, 200, 0)[1].startsWith(lastSentence), false);
  });

  it("hard-splits oversized sentences without breaking surrogate pairs", () => {
    const long = `${"word ".repeat(80)}${"😀".repeat(60)}`;
    const chunks = chunkText(long, 100, 10);
    assert.ok(chunks.every((chunk) => chunk.length <= 100));
    assert.ok(chunks.every((chunk) => !/[\ud800-\udbff]$/.test(chunk) && !/^[\udc00-\udfff]/.test(chunk)));
    assert.equal(chunks.join(" ").replace(/\s+/g, ""), long.replace(/\s+/g, ""));
  });

  it("returns nothing for blank text and validates its arguments", () => {
    assert.deepEqual(chunkText(" \n "), []);
    assert.throws(() => chunkText("x", 100, 100));
  });
});
