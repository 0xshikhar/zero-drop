/**
 * Headless disclosure on the local chain, end to end: strip and fingerprint a document, generate a
 * real Semaphore proof for a demo member, record it with ZeroDrop.record, then verify it the way a
 * reader does (L0 content hash, L1 inclusion, L2 proof check).
 *
 * Prerequisites: anvil running, `pnpm contracts:deploy`, `pnpm tsx scripts/seed-group.ts`, and the
 * depth-specific Semaphore circuit files in SEMAPHORE_ARTIFACTS_DIR (see README, "Circuit artifacts").
 * Env: RPC_URL, SEMAPHORE_ARTIFACTS_DIR, DEMO_FILE (optional path to a text or image file).
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  parseEventLogs,
  stringToHex,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { zeroDropAbi } from "../packages/core/src/abi.ts";
import {
  artifactNames,
  buildGroup,
  deserializeIdentity,
  digestOf,
  prepareDocument,
  proveDisclosure,
  verifyDisclosureProof,
  verifyInclusion,
  cidFor,
} from "../packages/core/src/index.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const config = JSON.parse(readFileSync(resolve(root, "config/local.json"), "utf8")) as {
  rpcUrl: string;
  chainId: number;
  contracts: { zeroDrop: Hex };
};
const members = JSON.parse(readFileSync(resolve(root, ".local/demo-members.json"), "utf8")) as {
  groupId: string;
  root: string;
  members: string[];
};
const DEFAULT_ANVIL_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const account = privateKeyToAccount((process.env.DEPLOYER_PRIVATE_KEY ?? DEFAULT_ANVIL_KEY) as Hex);
const rpcUrl = process.env.RPC_URL ?? config.rpcUrl;
const transport = http(rpcUrl);
const publicClient = createPublicClient({ transport });
const walletClient = createWalletClient({ account, transport });
const zeroDrop = config.contracts.zeroDrop;

async function main(): Promise<void> {
  const artifactsDir = process.env.SEMAPHORE_ARTIFACTS_DIR;
  if (!artifactsDir) throw new Error("set SEMAPHORE_ARTIFACTS_DIR to the directory with the circuit files");

  const groupId = BigInt(members.groupId);
  const identities = members.members.map(deserializeIdentity);
  const { root: groupRoot, size, group } = buildGroup(identities.map((identity) => identity.commitment));
  if (groupRoot.toString() !== members.root) throw new Error("rebuilt group root differs from the recorded root");
  console.log(`group ${groupId}: ${size} members, root matches`);

  const filePath = process.env.DEMO_FILE;
  const input = filePath
    ? new Uint8Array(readFileSync(filePath))
    : new TextEncoder().encode(`ZeroDrop demo disclosure ${new Date().toISOString()}\n`);
  const prepared = await prepareDocument(
    new File([input], filePath ? filePath.split("/").pop()! : "demo.txt", { type: filePath ? "" : "text/plain" }),
  );
  const cidDigest = digestOf(prepared.bytes);
  console.log(`document CID ${cidFor(prepared.bytes)}`);

  const caseId = keccak256(stringToHex(`demo-case-${Date.now()}`));
  const depth = Math.max(1, Math.ceil(Math.log2(size)));
  const names = artifactNames(depth);
  const proof = await proveDisclosure({
    identity: identities[0],
    group,
    groupId,
    caseId,
    cidDigest,
    depth,
    artifacts: { wasm: `${artifactsDir}/${names.wasm}`, zkey: `${artifactsDir}/${names.zkey}` },
  });
  const verified = await verifyDisclosureProof({
    proofBytes: proof.proofBytes,
    root: proof.root,
    nullifier: proof.nullifier,
    depth: proof.depth,
    messageHash: proof.messageHash,
    scopeHash: proof.scopeHash,
  });
  console.log(`proof generated (depth ${proof.depth}), local check: ${verified}`);
  if (!verified) throw new Error("local proof check failed");

  const hash = await walletClient.writeContract({
    address: zeroDrop,
    abi: zeroDropAbi,
    functionName: "record",
    args: [groupId, caseId, cidDigest, proof.root, proof.nullifier, BigInt(proof.depth), proof.proofBytes],
    account,
    chain: null,
  } as never);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`record reverted (tx ${hash})`);
  parseEventLogs({ abi: zeroDropAbi, logs: receipt.logs, eventName: "Disclosed" });
  console.log(`recorded in block ${receipt.blockNumber}, tx ${hash}`);

  const inclusion = await verifyInclusion({
    publicClients: [publicClient],
    zeroDropAddress: zeroDrop,
    cidDigest,
    quorum: "single-endpoint",
    expectedChainId: config.chainId,
  });
  console.log(`L0 content hash: ${digestOf(prepared.bytes) === cidDigest ? "ok" : "FAILED"}`);
  console.log(`L1 inclusion: ${inclusion.ok ? "ok" : `FAILED (${inclusion.reason})`}`);
  console.log(`L1 note: ${inclusion.reason}`);
  console.log(`L2 proof: ${verified ? "ok" : "FAILED"}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
