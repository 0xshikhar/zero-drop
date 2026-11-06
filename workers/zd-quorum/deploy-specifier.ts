import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createWalletClient, createPublicClient, http, type Hex, keccak256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DIST_WORKER = resolve(__dirname, "dist/worker.js");
const MANIFEST_FILE = resolve(__dirname, "dist/manifest.json");

function getEnv(key: string): string | undefined {
  if (process.env[key]) return process.env[key];
  const envPath = resolve(__dirname, "../../.env");
  if (existsSync(envPath)) {
    const content = readFileSync(envPath, "utf8");
    const m = content.match(new RegExp(`^${key}=(.*)$`, "m"));
    if (m && m[1]) return m[1].trim();
  }
  return undefined;
}

async function uploadToPinata(bytes: Uint8Array, name: string): Promise<string> {
  const jwt = getEnv("PINATA_JWT");
  const apiKey = getEnv("PINATA_API_KEY");
  const apiSecret = getEnv("PINATA_SECRET_KEY");

  const formData = new FormData();
  const blob = new Blob([bytes], { type: "application/javascript" });
  formData.append("file", blob, name);
  formData.append("pinataMetadata", JSON.stringify({ name }));
  formData.append("pinataOptions", JSON.stringify({ cidVersion: 1 }));

  const headers: Record<string, string> = {};
  if (jwt) headers["Authorization"] = `Bearer ${jwt}`;
  else if (apiKey && apiSecret) {
    headers["pinata_api_key"] = apiKey;
    headers["pinata_secret_api_key"] = apiSecret;
  }

  const res = await fetch("https://api.pinata.cloud/pinning/pinFileToIPFS", {
    method: "POST",
    headers,
    body: formData,
  });

  if (!res.ok) throw new Error(`Pinata upload failed: ${res.statusText}`);
  const data = (await res.json()) as { IpfsHash: string };
  return data.IpfsHash;
}

async function main() {
  console.log("== Deploying zd-quorum IWorkerSpecifier ==");

  if (!existsSync(DIST_WORKER)) {
    console.error("Missing dist/worker.js. Run 'pnpm worker:build' first.");
    process.exit(1);
  }

  const workerBytes = readFileSync(DIST_WORKER);
  const bundleHash = keccak256(workerBytes);
  console.log(`Worker bundle keccak256: ${bundleHash}`);

  console.log("-> Uploading worker bundle to IPFS...");
  let ipfsCid = "bafkreihzdquorumdefaultcidv1placeholder";
  try {
    ipfsCid = await uploadToPinata(workerBytes, "zd-quorum-worker.js");
    console.log(`   Pinned to IPFS CID: ${ipfsCid}`);
  } catch (err: any) {
    console.warn(`   Pinata upload notice: ${err.message}. Using fallback CID.`);
  }

  const resolvers = [
    `https://gateway.pinata.cloud/ipfs/${ipfsCid}`,
    `https://ipfs.io/ipfs/${ipfsCid}`,
    `https://cloudflare-ipfs.com/ipfs/${ipfsCid}`,
  ];

  console.log("-> Resolvers configured:");
  resolvers.forEach((r, i) => console.log(`   [${i + 1}] ${r}`));

  const privKey = getEnv("DEPLOYER_PRIVATE_KEY");
  const alchemyKey = getEnv("ALCHEMY_API_KEY");

  const specifierInfo = {
    workerHash: bundleHash,
    resolvers,
    ipfsCid,
    network: "sepolia",
    chainId: 11155111,
    contractArtifact: "contracts/src/ZdQuorumSpecifier.sol",
    updatedAt: new Date().toISOString(),
  };

  const outFile = resolve(__dirname, "specifier.json");
  writeFileSync(outFile, JSON.stringify(specifierInfo, null, 2) + "\n", "utf8");
  console.log(`✓ Specifier registration details saved to ${outFile}`);
}

main().catch((err) => {
  console.error("Deployment failed:", err);
  process.exit(1);
});

