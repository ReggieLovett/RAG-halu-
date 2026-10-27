export type ManualPassage = { id: string; text: string; source?: string };

/** Browser-only parsing; the API applies the same limits again. */
export function parseManualContext(value: string, format: "text" | "json"): ManualPassage[] {
  if (!value.trim()) return [];
  let passages: ManualPassage[];
  if (format === "text") {
    passages = value.trim().split(/\r?\n\s*\r?\n/).map((text, index) => ({
      id: `manual-${index + 1}`, text: text.trim(), source: `Pasted passage ${index + 1}`
    }));
  } else {
    let parsed: unknown;
    try { parsed = JSON.parse(value); }
    catch { throw new Error("Passages must be valid JSON. Use an array of objects with id and text."); }
    if (!Array.isArray(parsed)) throw new Error("JSON passages must be an array.");
    passages = parsed.map((entry: unknown, index: number) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error(`Passage ${index + 1} must be an object with id and text.`);
      }
      const item = entry as Record<string, unknown>;
      if (Object.keys(item).some(key => !["id", "text", "source"].includes(key))) {
        throw new Error(`Passage ${index + 1} accepts only id, text, and optional source.`);
      }
      if (typeof item.id !== "string" || typeof item.text !== "string" ||
          (item.source !== undefined && typeof item.source !== "string")) {
        throw new Error(`Passage ${index + 1} needs string id and text, and optional string source.`);
      }
      return { id: item.id.trim(), text: item.text.trim(), ...(typeof item.source === "string" ? { source: item.source.trim() } : {}) };
    });
  }
  if (passages.length > 10) throw new Error("Use at most 10 passages.");
  const ids = new Set<string>();
  passages.forEach((passage, index) => {
    if (!passage.id || passage.id.length > 256) throw new Error(`Passage ${index + 1} needs an ID of 1–256 characters.`);
    if (!passage.text || passage.text.length > 6000) throw new Error(`Passage ${index + 1} needs text of 1–6000 characters.`);
    if (passage.source !== undefined && (!passage.source || passage.source.length > 2000)) {
      throw new Error(`Passage ${index + 1} source must be 1–2000 characters.`);
    }
    if (ids.has(passage.id)) throw new Error(`Duplicate passage ID: ${passage.id}.`);
    ids.add(passage.id);
  });
  if (passages.reduce((total, passage) => total + passage.text.length, 0) > 24000) {
    throw new Error("Use at most 24000 characters across all passages.");
  }
  return passages;
}

export function apiErrorMessage(data: unknown, fallback: string): string {
  if (!data || typeof data !== "object") return fallback;
  const body = data as Record<string, unknown>;
  const message = typeof body.error === "string" ? body.error : fallback;
  if (!Array.isArray(body.details)) return message;
  const details = body.details.flatMap((entry: unknown) => {
    if (!entry || typeof entry !== "object") return [];
    const detail = entry as Record<string, unknown>;
    return typeof detail.message === "string" ? [`${typeof detail.path === "string" && detail.path ? `${detail.path}: ` : ""}${detail.message}`] : [];
  });
  return details.length ? `${message} ${details.join(" ")}` : message;
}
