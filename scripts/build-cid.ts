/**
 * Prints the identity of the built single file: size, sha256 and the CIDv1 (raw codec, sha2-256) computed by
 * packages/core `cidFor`, the same function the app and the contract use for documents.
 *
 *   pnpm tsx scripts/build-cid.ts [path]            (default: apps/web/dist/index.html)
 *   pnpm tsx scripts/build-cid.ts --json [path]
 *
 * `cidFor` hashes the whole file as ONE raw block. Kubo only produces the same CID when the file fits one chunk
 * (see scripts/build-ipfs.sh). For files over that limit the CID of an `ipfs add` is a UnixFS DAG and differs.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cidFor, digestOf } from "../packages/core/src/content.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const json = args.includes("--json");
const file = resolve(args.find((a) => !a.startsWith("--")) ?? resolve(root, "apps/web/dist/index.html"));

const bytes = readFileSync(file);
const out = {
  file,
  bytes: bytes.length,
  sha256: digestOf(bytes).slice(2),
  cidRawLeaf: cidFor(bytes),
};

if (json) console.log(JSON.stringify(out));
else {
  console.log(`file          ${out.file}`);
  console.log(`bytes         ${out.bytes}`);
  console.log(`sha256        ${out.sha256}`);
  console.log(`cidFor (v1 raw sha2-256, one block)  ${out.cidRawLeaf}`);
}
