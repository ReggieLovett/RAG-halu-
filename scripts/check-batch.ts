import { loadEnvConfig } from "@next/env";
import { readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { BATCH_LIMITS, batchReportCsv, parseBatchText, runBatch } from "../lib/rag/batch";
import { RagError } from "../lib/rag/errors";

export async function main(args = process.argv.slice(2)): Promise<void> {
  loadEnvConfig(process.cwd());
  const inputPath = args[0];
  if (!inputPath || inputPath.startsWith("--")) {
    throw new RagError("Usage: npm run check:batch -- input.json --output report.json [--format json|csv] [--concurrency 1|2]", 400, "INVALID_ARGUMENTS");
  }
  let outputPath = "batch-report.json";
  let format = "json";
  let concurrency: number | undefined;
  for (let i = 1; i < args.length; i += 2) {
    const value = args[i + 1];
    if (!value) throw new RagError("Each CLI option needs a value.", 400, "INVALID_ARGUMENTS");
    switch (args[i]) {
      case "--output": outputPath = value; break;
      case "--format": format = value; break;
      case "--concurrency": concurrency = Number(value); break;
      default: throw new RagError(`Unknown option: ${args[i]}.`, 400, "INVALID_ARGUMENTS");
    }
  }
  if (!["json", "csv"].includes(format) || (concurrency !== undefined && ![1, 2].includes(concurrency))) {
    throw new RagError("Format must be json or csv; concurrency must be 1 or 2.", 400, "INVALID_ARGUMENTS");
  }
  if (path.resolve(inputPath) === path.resolve(outputPath)) throw new RagError("Output must differ from the input file.", 400, "INVALID_ARGUMENTS");
  if ((await stat(inputPath)).size > BATCH_LIMITS.bytes) throw new RagError("Batch file exceeds 1 MiB.", 413, "BATCH_TOO_LARGE");
  const input = parseBatchText(await readFile(inputPath, "utf8"), inputPath);
  if (concurrency !== undefined) input.concurrency = concurrency;
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    console.log(`Checking ${input.items.length} items, concurrency ${input.concurrency}. Existing answers are verified; missing answers are generated from their context.`);
    const report = await runBatch(input, controller.signal);
    const output = format === "csv" ? batchReportCsv(report) : `${JSON.stringify(report, null, 2)}\n`;
    const temporary = `${outputPath}.${process.pid}.tmp`;
    await writeFile(temporary, output, "utf8");
    await rename(temporary, outputPath);
    console.log(`Saved ${path.resolve(outputPath)}. Verified: ${report.summary.verifiedItems}; failed: ${report.summary.failedItems}; cancelled: ${report.summary.cancelledItems}; faithfulness: ${report.summary.faithfulnessScore ?? "N/A"}${report.summary.faithfulnessScore === null ? "" : "%"}.`);
    if (report.summary.failedItems || report.summary.cancelledItems) process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    // Avoid printing arbitrary upstream errors or credentials to terminal logs.
    console.error(error instanceof RagError ? `${error.code}: ${error.message}` : "Batch command failed. Check file paths, local Chroma, and Groq settings.");
    process.exitCode = 1;
  });
}
