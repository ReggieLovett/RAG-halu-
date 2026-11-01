// Parse a local batch JSON file in the browser. Client-safe.
import type { BatchItem } from "./types";

function isContext(value: unknown): value is string | string[] {
  return typeof value === "string" || (Array.isArray(value) && value.every((entry) => typeof entry === "string"));
}

/** Accepts `[{ question, answer, context, id? }]` or `{ "items": [...] }`. */
export function parseBatchJson(text: string, maxItems: number): BatchItem[] {
  let data: unknown;
  try {
    data = JSON.parse(text.replace(/^﻿/, ""));
  } catch {
    throw new Error("The file is not valid JSON.");
  }
  const items = Array.isArray(data)
    ? data
    : data && typeof data === "object" && Array.isArray((data as { items?: unknown }).items)
      ? (data as { items: unknown[] }).items
      : null;
  if (!items) throw new Error('Expected a JSON array of items, or an object with an "items" array.');
  if (items.length === 0) throw new Error("The file contains no items.");
  if (items.length > maxItems) {
    throw new Error(`The file has ${items.length} items; the batch checker accepts at most ${maxItems} per run. Split the file.`);
  }
  return items.map((raw, index) => {
    const item = (raw ?? {}) as Record<string, unknown>;
    if (typeof item.question !== "string" || typeof item.answer !== "string" || !isContext(item.context)) {
      throw new Error(`Item ${index + 1} needs string "question" and "answer" fields and a "context" string or array of strings.`);
    }
    return {
      ...(typeof item.id === "string" || typeof item.id === "number" ? { id: String(item.id) } : {}),
      question: item.question,
      answer: item.answer,
      context: item.context,
      ...(typeof item.source === "string" ? { source: item.source } : {}),
    };
  });
}
