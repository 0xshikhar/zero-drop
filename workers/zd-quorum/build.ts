import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { keccak256 } from "viem";
import esbuild from "esbuild";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ENTRY = resolve(__dirname, "worker.ts");
const OUT_DIR = resolve(__dirname, "dist");
const OUT_FILE = resolve(OUT_DIR, "worker.js");
const MANIFEST_FILE = resolve(OUT_DIR, "manifest.json");

async function main() {
  console.log("== Building zd-quorum Anon-RPC Worker ==");

  if (!existsSync(OUT_DIR)) {
    mkdirSync(OUT_DIR, { recursive: true });
  }

  // Build standalone IIFE worker bundle
  await esbuild.build({
    entryPoints: [ENTRY],
    outfile: OUT_FILE,
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    minify: true,
    legalComments: "none",
  });

  const workerBytes = readFileSync(OUT_FILE);
  const sha256 = createHash("sha256").update(workerBytes).digest("hex");
  const bundleKeccak = keccak256(workerBytes);
  const sizeBytes = workerBytes.length;

  const manifest = {
    name: "zd-quorum",
    version: "0.1.0",
    description: "Quorum and in-sandbox Merkle trie proof verifying Anon-RPC worker",
    sizeBytes,
    sha256,
    keccak256: bundleKeccak,
    builtAt: new Date().toISOString(),
    specVersion: "0.4.0",
  };

  writeFileSync(MANIFEST_FILE, JSON.stringify(manifest, null, 2) + "\n", "utf8");

  console.log(`✓ Built ${OUT_FILE}`);
  console.log(`   Bundle Size: ${sizeBytes} bytes`);
  console.log(`   SHA-256:     ${sha256}`);
  console.log(`   keccak256:   ${bundleKeccak}`);
  console.log(`✓ Saved manifest to ${MANIFEST_FILE}`);
}

main().catch((err) => {
  console.error("Worker build failed:", err);
  process.exit(1);
});

