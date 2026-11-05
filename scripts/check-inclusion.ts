/**
 * Reader-side L1 check from the command line: given a deployment config and a record transaction (or a
 * cidDigest), verify the record with a storage proof across every RPC in RPC_URLS and require them all to agree.
 *
 *   CONFIG=config/sepolia.json RPC_URLS=https://a,https://b pnpm tsx scripts/check-inclusion.ts --tx 0x...
 *   CONFIG=config/sepolia.json pnpm tsx scripts/check-inclusion.ts --cid-digest 0x...
 *
 * RPC_URLS defaults to the config's rpcUrl (single endpoint: the state root is then trusted to that one RPC).
 * Keyed RPC URLs are never printed.
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createPublicClient, http, type Hex } from "viem";
import { verifyInclusion } from "../packages/core/src/index.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const configPath = resolve(root, process.env.CONFIG ?? "config/local.json");
const config = JSON.parse(readFileSync(configPath, "utf8")) as { chainId: number; rpcUrl: string; contracts: { zeroDrop: Hex } };
const { values } = parseArgs({ options: { tx: { type: "string" }, "cid-digest": { type: "string" } } });
const urls = (process.env.RPC_URLS ?? config.rpcUrl).split(",").map((u) => u.trim()).filter(Boolean);
const redact = (u: string) => u.replace(/\/v2\/[A-Za-z0-9_-]+/, "/v2/<key>").replace(/\/v3\/[A-Za-z0-9_-]+/, "/v3/<key>");

async function main(): Promise<void> {
  const clients = urls.map((u) => createPublicClient({ transport: http(u, { timeout: 60_000 }) }));
  let cidDigest = values["cid-digest"] as Hex | undefined;
  if (values.tx) {
    const receipt = await clients[0]!.getTransactionReceipt({ hash: values.tx as Hex });
    console.log(`tx ${values.tx}: status ${receipt.status}, block ${receipt.blockNumber}, gasUsed ${receipt.gasUsed}`);
    const log = receipt.logs.find((l) => l.address.toLowerCase() === config.contracts.zeroDrop.toLowerCase() && l.topics.length === 4);
    if (!log) throw new Error("no Disclosed event from the configured ZeroDrop in that transaction");
    cidDigest = log.topics[1] as Hex;
  }
  if (!cidDigest) throw new Error("pass --tx or --cid-digest");

  console.log(`chain ${config.chainId}, ZeroDrop ${config.contracts.zeroDrop}, cidDigest ${cidDigest}`);
  console.log(`endpoints (${urls.length}): ${urls.map(redact).join(", ")}`);
  const result = await verifyInclusion({
    publicClients: clients as never,
    zeroDropAddress: config.contracts.zeroDrop,
    cidDigest,
    quorum: urls.length === 1 ? "single-endpoint" : urls.length,
    expectedChainId: config.chainId,
  });
  const extra = result as unknown as { storageProofVerified?: boolean; anonymitySet?: bigint | number };
  console.log(`ok ${result.ok}, storage proof ${extra.storageProofVerified ?? false}, anonymity set ${extra.anonymitySet ?? "?"}`);
  console.log(`block ${result.blockNumber}, hash ${result.blockHash}, agreeing ${JSON.stringify(result.agreeingEndpoints)}`);
  console.log(`reason: ${result.reason}`);
  if (!result.ok) process.exit(1);
}

main().catch((error) => {
  console.error(redact(error instanceof Error ? error.message : String(error)));
  process.exit(1);
});
