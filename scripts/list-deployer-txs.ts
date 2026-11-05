/**
 * Lists the transactions an address sent in a block range, with what they created or called. Used to
 * fill evidence/txs.md from the chain instead of from memory.
 *   RPC_URL=https://ethereum-sepolia-rpc.publicnode.com pnpm tsx scripts/list-deployer-txs.ts 0xADDR FROM TO
 */
import { createPublicClient, http, type Hex } from "viem";

const [address, from, to] = process.argv.slice(2);
if (!address || !from || !to) throw new Error("usage: list-deployer-txs.ts <address> <fromBlock> <toBlock>");
const client = createPublicClient({ transport: http(process.env.RPC_URL ?? "http://127.0.0.1:8545") });

async function main(): Promise<void> {
  for (let n = BigInt(from); n <= BigInt(to); n++) {
    const block = await client.getBlock({ blockNumber: n, includeTransactions: true });
    for (const tx of block.transactions) {
      if (typeof tx === "string" || tx.from.toLowerCase() !== address!.toLowerCase()) continue;
      const receipt = await client.getTransactionReceipt({ hash: tx.hash as Hex });
      const what = receipt.contractAddress ? `create ${receipt.contractAddress}` : `call ${tx.to} ${tx.input.slice(0, 10)}`;
      console.log(`${n}\t${tx.hash}\t${receipt.status}\tgas ${receipt.gasUsed}\t${what}`);
    }
  }
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
