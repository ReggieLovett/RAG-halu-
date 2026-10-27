import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

// The version used by Chroma's official standalone installer. No global install.
const release = "cli-1.4.4";
const assets = {
  "darwin-arm64": "chroma-macos-arm64",
  "darwin-x64": "chroma-macos-intel",
  "linux-x64": "chroma-linux",
  "win32-x64": "chroma-windows.exe"
};
const assetName = assets[`${process.platform}-${process.arch}`];
if (!assetName) {
  throw new Error("No standalone binary is configured for this platform. Use the Python setup in README.md.");
}

const target = path.resolve(".local", "bin", process.platform === "win32" ? "chroma.exe" : "chroma");
const temporary = `${target}.download`;
try {
  const metadataResponse = await fetch(`https://api.github.com/repos/chroma-core/chroma/releases/tags/${release}`, {
    headers: { Accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(30_000)
  });
  if (!metadataResponse.ok) throw new Error(`Cannot read official Chroma release: HTTP ${metadataResponse.status}.`);
  const metadata = await metadataResponse.json();
  const asset = metadata.assets?.find(candidate => candidate.name === assetName);
  if (!asset || !/^sha256:[a-f0-9]{64}$/.test(asset.digest ?? "")) {
    throw new Error("The official release has no SHA-256 digest for this binary; installation stopped.");
  }
  await mkdir(path.dirname(target), { recursive: true });
  console.log(`Downloading ${release}/${assetName} (${Math.round(asset.size / 1024 / 1024)} MiB) into .local/bin.`);
  const response = await fetch(`https://github.com/chroma-core/chroma/releases/download/${release}/${assetName}`, {
    signal: AbortSignal.timeout(180_000)
  });
  if (!response.ok || !response.body) throw new Error(`Chroma download failed: HTTP ${response.status}.`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary, { mode: 0o600 }));
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(temporary)) { hash.update(chunk); bytes += chunk.length; }
  if (bytes !== asset.size || `sha256:${hash.digest("hex")}` !== asset.digest) {
    throw new Error("Chroma size or SHA-256 verification failed; the binary will not be installed.");
  }
  await chmod(temporary, 0o755);
  await rename(temporary, target);
  console.log("Verified and installed the local Chroma server. Start it with npm run chroma:start.");
} catch (error) {
  await rm(temporary, { force: true });
  console.error(error.message);
  process.exitCode = 1;
}
