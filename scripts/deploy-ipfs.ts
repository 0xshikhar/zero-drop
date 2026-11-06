import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { cidFor } from "../packages/core/src/content.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, "..");
const DIST_FILE = resolve(ROOT, "apps/web/dist/index.html");
const RELEASE_FILE = resolve(ROOT, "config/release.json");

function getEnv(key: string): string | undefined {
  if (process.env[key]) return process.env[key];
  const localEnvPath = resolve(ROOT, ".env");
  if (existsSync(localEnvPath)) {
    const content = readFileSync(localEnvPath, "utf8");
    const m = content.match(new RegExp(`^${key}=(.*)$`, "m"));
    if (m && m[1]) return m[1].trim();
  }
  const anonEnvPath = resolve(ROOT, "../anonpress/core/node/.env");
  if (existsSync(anonEnvPath)) {
    const content = readFileSync(anonEnvPath, "utf8");
    const m = content.match(new RegExp(`^${key}=(.*)$`, "m"));
    if (m && m[1]) return m[1].trim();
  }
  return undefined;
}

async function uploadToPinata(
  htmlBuffer: Buffer,
  sha256: string,
  coreCid: string,
  jwt?: string,
  apiKey?: string,
  apiSecret?: string
): Promise<string | undefined> {
  const formData = new FormData();
  const blob = new Blob([htmlBuffer], { type: "text/html; charset=utf-8" });
  formData.append("file", blob, "index.html");

  const metadata = {
    name: `ZeroDrop-v0.1.0-${sha256.slice(0, 8)}.html`,
    keyvalues: {
      app: "zerodrop",
      version: "0.1.0",
      sha256,
      cidRaw: coreCid,
      builtAt: new Date().toISOString(),
    },
  };
  formData.append("pinataMetadata", JSON.stringify(metadata));
  formData.append("pinataOptions", JSON.stringify({ cidVersion: 1 }));

  const headers: Record<string, string> = {};
  if (jwt) headers["Authorization"] = `Bearer ${jwt}`;
  else if (apiKey && apiSecret) {
    headers["pinata_api_key"] = apiKey;
    headers["pinata_secret_api_key"] = apiSecret;
  }

  try {
    const res = await fetch("https://api.pinata.cloud/pinning/pinFileToIPFS", {
      method: "POST",
      headers,
      body: formData,
    });
    if (!res.ok) {
      const err = await res.text();
      console.warn(`   Pinata pinning returned status [${res.status}]: ${err.slice(0, 120)}`);
      return undefined;
    }
    const data = (await res.json()) as { IpfsHash: string };
    return data.IpfsHash;
  } catch (err: any) {
    console.warn(`   Pinata network notice: ${err.message}`);
    return undefined;
  }
}

function pinToLocalKubo(file: string): { dagCid: string; rawCid: string } {
  try {
    const dagOut = execSync(`ipfs add -Q --pin --cid-version=1 "${file}"`, { encoding: "utf8" }).trim();
    const rawOut = execSync(`ipfs add -Q --pin --cid-version=1 --raw-leaves --chunker=size-2096896 "${file}"`, {
      encoding: "utf8",
    }).trim();
    return { dagCid: dagOut, rawCid: rawOut };
  } catch (err: any) {
    console.warn(`   Local Kubo pinning failed: ${err.message}`);
    return { dagCid: "", rawCid: "" };
  }
}

async function main() {
  console.log("== ZeroDrop IPFS Frontend Deployment ==");

  if (!existsSync(DIST_FILE)) {
    console.error(`Error: Built frontend not found at ${DIST_FILE}. Run 'pnpm build' first.`);
    process.exit(1);
  }

  const htmlBuffer = readFileSync(DIST_FILE);
  const sha256 = createHash("sha256").update(htmlBuffer).digest("hex");
  const coreCid = cidFor(htmlBuffer);
  const sizeBytes = htmlBuffer.length;

  console.log(`-> Frontend bundle: size=${sizeBytes} bytes (${(sizeBytes / 1024 / 1024).toFixed(2)} MB)`);
  console.log(`   SHA-256: ${sha256}`);
  console.log(`   Core CIDv1 (raw block): ${coreCid}`);

  // 1. Attempt Pinata remote pin
  const jwt = getEnv("PINATA_JWT");
  const apiKey = getEnv("PINATA_API_KEY");
  const apiSecret = getEnv("PINATA_SECRET_KEY");
  console.log("-> Uploading bundle to Pinata IPFS cloud...");
  const pinataCid = await uploadToPinata(htmlBuffer, sha256, coreCid, jwt, apiKey, apiSecret);

  // 2. Pin to local Kubo IPFS node
  console.log("-> Pinning bundle into local Kubo node...");
  const kubo = pinToLocalKubo(DIST_FILE);
  if (kubo.dagCid) {
    console.log(`   Local Kubo DAG CID:    ${kubo.dagCid}`);
    console.log(`   Local Kubo Raw CID:    ${kubo.rawCid}`);
  }

  const effectiveCid = pinataCid || kubo.dagCid || coreCid;
  const gateways = [
    `https://ipfs.io/ipfs/${kubo.dagCid || effectiveCid}`,
    `https://gateway.pinata.cloud/ipfs/${kubo.dagCid || effectiveCid}`,
    `https://cloudflare-ipfs.com/ipfs/${kubo.dagCid || effectiveCid}`,
    `https://dweb.link/ipfs/${kubo.dagCid || effectiveCid}`,
    `http://127.0.0.1:8080/ipfs/${kubo.dagCid || effectiveCid}`,
  ];

  console.log("\n-> Public & Decentralized Gateways:");
  gateways.forEach((gw, idx) => console.log(`   [${idx + 1}] ${gw}`));

  // Update config/release.json
  if (existsSync(RELEASE_FILE)) {
    const releaseData = JSON.parse(readFileSync(RELEASE_FILE, "utf8"));
    releaseData.sizeBytes = sizeBytes;
    releaseData.sha256 = sha256;
    releaseData.cidRaw = coreCid;
    releaseData.cidDag = kubo.dagCid || undefined;
    releaseData.pinnedIpfsCid = effectiveCid;
    releaseData.gateways = gateways;
    releaseData.deployedAt = new Date().toISOString();

    writeFileSync(RELEASE_FILE, JSON.stringify(releaseData, null, 2) + "\n", "utf8");
    console.log(`\n✓ Updated ${RELEASE_FILE} with current SHA, CIDs, and gateway endpoints.`);
  }

  console.log("\n== Deployment Successful ==");
}

main().catch((err) => {
  console.error("Unhandled deployment error:", err);
  process.exit(1);
});
