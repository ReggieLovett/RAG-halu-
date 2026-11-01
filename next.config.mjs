/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Load these with Node's require at runtime instead of bundling them: pdf.js
  // spawns its worker from its own package path, and the embedding stack loads
  // native ONNX/canvas binaries. (@huggingface/transformers is external by default.)
  serverExternalPackages: ["pdf-parse", "pdfjs-dist", "@napi-rs/canvas", "@chroma-core/default-embed"],
};

export default nextConfig;
