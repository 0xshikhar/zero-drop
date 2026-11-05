/**
 * Creates a demo group on the local chain and adds N Semaphore identities through one issuer
 * transaction. Writes the identities to .local/demo-members.json (gitignored: it holds secrets
 * for local demo use only). Run after `pnpm contracts:deploy`:
 *   pnpm tsx scripts/seed-group.ts [count=4] [minSize=3]
 *   CONFIG=config/local-mock.json pnpm tsx scripts/seed-group.ts 4 3
 * Env: CONFIG (config file, default config/local.json), RPC_URL, DEPLOYER_PRIVATE_KEY (defaults: local anvil
 * account 0). Members are written to .local/demo-members.<config name>.json (config/local.json also keeps
 * writing .local/demo-members.json for older callers).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, http, parseEventLogs, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { zeroDropAbi } from "../packages/core/src/abi.ts";
import {
  buildGroup,
  commitment,
  createIdentity,
  serializeIdentity,
} from "../packages/core/src/index.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const configPath = resolve(root, process.env.CONFIG ?? "config/local.json");
const configName = basename(configPath, ".json");
const config = JSON.parse(readFileSync(configPath, "utf8")) as {
  rpcUrl: string;
  contracts: { zeroDrop: Hex };
};
const DEFAULT_ANVIL_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const account = privateKeyToAccount((process.env.DEPLOYER_PRIVATE_KEY ?? DEFAULT_ANVIL_KEY) as Hex);
const transport = http(process.env.RPC_URL ?? config.rpcUrl);
const publicClient = createPublicClient({ transport });
const walletClient = createWalletClient({ account, transport });

async function main(): Promise<void> {
  const count = Number(process.argv[2] ?? 4);
  const minSize = Number(process.argv[3] ?? 3);
  if (!Number.isInteger(count) || count < 1) throw new Error("count must be a positive integer");

  const identities = Array.from({ length: count }, () => createIdentity());
  const commitments = identities.map(commitment);
  const { root: newRoot, size } = buildGroup(commitments);

  const createHash = await walletClient.writeContract({
    address: config.contracts.zeroDrop,
    abi: zeroDropAbi,
    functionName: "createGroup",
    args: [minSize],
    account,
    chain: null,
  } as never);
  const created = await publicClient.waitForTransactionReceipt({ hash: createHash });
  const [event] = parseEventLogs({ abi: zeroDropAbi, logs: created.logs, eventName: "GroupCreated" });
  const groupId = event.args.groupId;

  const addHash = await walletClient.writeContract({
    address: config.contracts.zeroDrop,
    abi: zeroDropAbi,
    functionName: "addMembers",
    args: [groupId, commitments, newRoot],
    account,
    chain: null,
  } as never);
  const added = await publicClient.waitForTransactionReceipt({ hash: addHash });
  if (added.status !== "success") throw new Error(`addMembers reverted (tx ${addHash})`);

  const dir = resolve(root, ".local");
  mkdirSync(dir, { recursive: true });
  const payload = JSON.stringify(
    { groupId: groupId.toString(), minSize, root: newRoot.toString(), members: identities.map(serializeIdentity) },
    null,
    2,
  );
  const out = resolve(dir, `demo-members.${configName}.json`);
  writeFileSync(out, payload, { mode: 0o600 });
  if (configName === "local") writeFileSync(resolve(dir, "demo-members.json"), payload, { mode: 0o600 });
  console.log(`group ${groupId} created with ${size} members, root ${newRoot}`);
  console.log(`identities written to ${out} (local demo secrets, do not commit)`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
