import { constants } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import nextEnv from "@next/env";

nextEnv.loadEnvConfig(process.cwd());
const host = process.env.CHROMA_HOST?.trim() || "127.0.0.1";
const port = Number(process.env.CHROMA_PORT || 8000);
if (!["127.0.0.1", "localhost"].includes(host) || !Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("For this local CLI, use CHROMA_HOST=127.0.0.1 (or localhost) and a CHROMA_PORT from 1 to 65535.");
}
const candidates = process.platform === "win32"
  ? [".local/bin/chroma.exe", ".venv/Scripts/chroma.exe"]
  : [".local/bin/chroma", ".venv/bin/chroma"];
let executable;
for (const candidate of candidates) {
  try { await access(candidate, constants.X_OK); executable = path.resolve(candidate); break; }
  catch { /* Try the next project-local installation. */ }
}
if (!executable) {
  console.error("Chroma is not installed. Run npm run chroma:install, then npm run chroma:start. See README.md for the Python alternative.");
  process.exitCode = 1;
} else {
  const child = spawn(executable, ["run", "--host", host, "--port", String(port), "--path", path.resolve(".chroma")], { stdio: "inherit" });
  process.on("SIGINT", () => child.kill("SIGINT"));
  process.on("SIGTERM", () => child.kill("SIGTERM"));
  child.on("error", error => { console.error(`Could not start local Chroma: ${error.message}`); process.exitCode = 1; });
  child.on("exit", (code, signal) => { process.exitCode = code ?? (signal === "SIGINT" ? 130 : 1); });
}
