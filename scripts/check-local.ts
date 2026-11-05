/**
 * Smoke test against a running local chain: reads config/local.json, creates a group, publishes the
 * fixture commitments and root, then records the fixture proof. Expects a fresh deployment, because
 * the fixture is bound to group id 1 and its CID can only be recorded once.
 * Run with: pnpm tsx scripts/check-local.ts (after pnpm contracts:deploy)
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, http, parseEventLogs, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { zeroDropAbi } from "../packages/core/src/abi.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const config = JSON.parse(readFileSync(resolve(root, "config/local.json"), "utf8")) as {
  rpcUrl: string;
  contracts: { zeroDrop: Hex };
};
const fixture = JSON.parse(
  readFileSync(resolve(root, "contracts/test/fixtures/semaphore-proof.json"), "utf8"),
) as {
  caseId: Hex;
  cidDigest: Hex;
  commitments: Hex[];
  root: Hex;
  nullifier: Hex;
  depth: number;
  proof: Hex;
};
const DEFAULT_ANVIL_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const account = privateKeyToAccount((process.env.DEPLOYER_PRIVATE_KEY ?? DEFAULT_ANVIL_KEY) as Hex);
const transport = http(process.env.RPC_URL ?? config.rpcUrl);
const publicClient = createPublicClient({ transport });
const walletClient = createWalletClient({ account, transport });
const address = config.contracts.zeroDrop;

async function write(functionName: string, args: readonly unknown[]) {
  const hash = await walletClient.writeContract({
    address,
    abi: zeroDropAbi,
    functionName,
    args,
    account,
    chain: null,
  } as never);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${functionName} reverted (tx ${hash})`);
  return receipt;
}

async function main(): Promise<void> {
  const created = await write("createGroup", [1]);
  const [event] = parseEventLogs({ abi: zeroDropAbi, logs: created.logs, eventName: "GroupCreated" });
  const groupId = event.args.groupId;
  if (groupId !== 1n) throw new Error(`expected fixture group id 1, got ${groupId}`);
  console.log(`created group ${groupId}`);

  await write("addMembers", [groupId, fixture.commitments.map(BigInt), BigInt(fixture.root)]);
  console.log("published fixture root");

  const rec = await write("record", [
    groupId,
    fixture.caseId,
    fixture.cidDigest,
    BigInt(fixture.root),
    BigInt(fixture.nullifier),
    BigInt(fixture.depth),
    fixture.proof,
  ]);
  console.log(`record() succeeded in block ${rec.blockNumber} (gas ${rec.gasUsed})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
