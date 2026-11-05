import { createWalletClient, defineChain, http, type Account, type Address } from "viem";
import { makePublicClient, network, rebuildFromEvents, type GroupSnapshot } from "@zerodrop/core";
import { LOCAL } from "./config";
import { zeroDropAbi } from "./adapter";

export const ZERODROP = LOCAL.contracts.zeroDrop;
export const DEPLOYED_BLOCK = BigInt(LOCAL.deployedBlock);

/**
 * The read client comes from @zerodrop/core, so its viem types are the core copy. Wallet calls below use
 * the app's own viem copy and pass only addresses across the boundary.
 */
export type PublicClient = ReturnType<typeof makePublicClient>[number];

/** Anvil chain for the wallet client. Defined here so the wallet's viem types stay in one copy. */
export const anvil = defineChain({
  id: LOCAL.chainId,
  name: "Anvil (local)",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [LOCAL.rpcUrl] } },
});

/** Read client for the configured RPC. Every request goes through the core network client (traffic meter). */
export function readClient(): PublicClient {
  return makePublicClient({ rpcUrls: [LOCAL.rpcUrl], chainId: LOCAL.chainId, role: "reader" })[0]!;
}

/** Wallet client for posting. Requests are counted under the "source" role. */
export function walletFor(account: Account) {
  return createWalletClient({
    account,
    chain: anvil,
    transport: http(LOCAL.rpcUrl, {
      fetchFn: (input, init) => network.fetch(input, init, "source", "post"),
    }),
  });
}

export type GroupView = {
  groupId: bigint;
  issuer: Address;
  minSize: number;
  /** Commitments in leaf order, rebuilt from MembersAdded events. */
  commitments: bigint[];
  group: GroupSnapshot["group"];
  /** Depth of the rebuilt tree, used as the circuit depth. */
  depth: number;
  /** Root from rebuilding the leaves. */
  root: bigint;
  /** Root the issuer last published on chain (MembersAdded.root). */
  chainRoot?: bigint;
  /** True only when the rebuilt root equals the last published root. */
  rootMatches: boolean;
  error?: string;
};

type MembersLog = { args: { groupId: bigint; startIndex: number; root: bigint; commitments: readonly bigint[] }; blockNumber: bigint; logIndex: number };

/**
 * Lists groups from GroupCreated and MembersAdded logs. A group whose leaves cannot be rebuilt, or whose
 * rebuilt root differs from the last published root, is returned with an error and rootMatches false.
 */
export async function loadGroups(client: PublicClient): Promise<GroupView[]> {
  const common = { address: ZERODROP, abi: zeroDropAbi, fromBlock: DEPLOYED_BLOCK, toBlock: "latest" } as const;
  const [created, added] = await Promise.all([
    client.getContractEvents({ ...common, eventName: "GroupCreated" }),
    client.getContractEvents({ ...common, eventName: "MembersAdded" }),
  ]);
  const logs = added as unknown as MembersLog[];

  return created.map((log) => {
    const args = log.args as unknown as { groupId: bigint; issuer: Address; minSize: number };
    const batches = logs
      .filter((l) => l.args.groupId === args.groupId)
      .sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : Number(a.blockNumber - b.blockNumber)));
    try {
      const snapshot = rebuildFromEvents(
        batches.map((b) => ({ startIndex: Number(b.args.startIndex), commitments: [...b.args.commitments] })),
      );
      const chainRoot = batches.at(-1)?.args.root;
      return {
        groupId: args.groupId,
        issuer: args.issuer,
        minSize: Number(args.minSize),
        commitments: batches.flatMap((b) => [...b.args.commitments]),
        group: snapshot.group,
        depth: Math.max(1, snapshot.group.depth),
        root: snapshot.root,
        chainRoot,
        rootMatches: chainRoot !== undefined && chainRoot === snapshot.root,
        error: chainRoot !== undefined && chainRoot !== snapshot.root ? "Rebuilt root differs from the published root" : undefined,
      };
    } catch (error) {
      const empty = rebuildFromEvents([]);
      return {
        groupId: args.groupId,
        issuer: args.issuer,
        minSize: Number(args.minSize),
        commitments: [],
        group: empty.group,
        depth: 1,
        root: empty.root,
        rootMatches: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
}
