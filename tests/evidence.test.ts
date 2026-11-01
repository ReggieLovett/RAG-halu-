import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cleanQuote, locateQuote } from "../lib/evidence";

const source = "Results:\nThe ﬁnal cohort received 3.5 mg daily.  “Adverse events” were rare — under 2%.";

describe("locateQuote", () => {
  it("finds exact quotes", () => {
    assert.deepEqual(locateQuote(source, "received 3.5 mg daily."), {
      start: source.indexOf("received"),
      end: source.indexOf("received") + "received 3.5 mg daily.".length,
      text: "received 3.5 mg daily.",
    });
  });

  it("tolerates whitespace, ligatures, typographic quotes, dashes, and case, returning exact source text", () => {
    assert.equal(locateQuote(source, "Results: The final cohort")?.text, "Results:\nThe ﬁnal cohort");
    assert.equal(locateQuote(source, '"Adverse events" were rare - under 2%')?.text, "“Adverse events” were rare — under 2%");
    assert.equal(locateQuote(source, "THE FINAL COHORT RECEIVED")?.text, "The ﬁnal cohort received");
  });

  it("never matches different digits or punctuation", () => {
    assert.equal(locateQuote(source, "received 35 mg daily"), null);
    assert.equal(locateQuote(source, "under 2.0%"), null);
  });

  it("strips wrapping quotes and matches the longest ellipsis fragment", () => {
    assert.equal(cleanQuote(' "...were rare..." '), "were rare");
    assert.equal(locateQuote(source, "“were rare”")?.text, "were rare");
    assert.equal(locateQuote(source, "The ﬁnal cohort received 3.5 mg ... Adverse events were rare")?.text, "The ﬁnal cohort received 3.5 mg");
  });

  it("returns null for empty or absent quotes", () => {
    assert.equal(locateQuote(source, "   "), null);
    assert.equal(locateQuote(source, "Placebo was given."), null);
  });
});
