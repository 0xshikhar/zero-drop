import { createWalletClient, defineChain, http, type Account, type Address } from "viem";
import { makePublicClient, network, rebuildFromEvents, type GroupSnapshot, type NetworkClient } from "@zerodrop/core";
import type { Deployment } from "./config";
import { activeDeployment, currentSettings } from "./prefs";
import { effectiveRpcUrls } from "./network";
import { zeroDropAbi } from "./adapter";

/**
 * The read client comes from @zerodrop/core, so its viem types are the core copy. Wallet calls below use
 * the app's own viem copy and pass only addresses across the boundary.
 */
export type PublicClient = ReturnType<typeof makePublicClient>[number];

/** The active deployment, or a clear error when config/ has nothing usable. */
export function requireDeployment(): Deployment & { zeroDrop: Address } {
  const d = activeDeployment();
  if (!d || !d.zeroDrop) throw new Error("No usable deployment in config/. Run `pnpm contracts:deploy` first.");
  return d as Deployment & { zeroDrop: Address };
}

/**
 * Reads normally go through the network client (Anon-RPC when it is active). With "Direct RPC for readers" on,
 * READER-role reads go straight out instead; they are still counted, as direct requests.
 */
const directForReaders: Pick<NetworkClient, "fetch"> = {
  fetch: (input, init, role, session) => network.fetchDirect(input, init, role, session),
};

/** One read client per RPC URL (the user's list if set, else the deployment's). */
export function readClients(role: "reader" | "source" | "issuer" = "reader"): PublicClient[] {
  const d = requireDeployment();
  const settings = currentSettings();
  const urls = effectiveRpcUrls(settings, d);
  const net = role === "reader" && settings.directRpcForReader ? (directForReaders as NetworkClient) : undefined;
  return makePublicClient({ rpcUrls: urls, chainId: d.chainId, role, ...(net ? { net } : {}) });
}

export function readClient(role: "reader" | "source" | "issuer" = "reader"): PublicClient {
  return readClients(role)[0]!;
}

/** Wallet client for posting or issuing. Requests are counted under the given role. */
export function walletFor(account: Account, role: "source" | "issuer" = "source") {
  const d = requireDeployment();
  const url = effectiveRpcUrls(currentSettings(), d)[0]!;
  const chain = defineChain({
    id: d.chainId,
    name: d.label,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [url] } },
  });
  return createWalletClient({
    account,
    chain,
    transport: http(url, {
      fetchFn: (input, init) => network.fetch(input, init, role, "post"),
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
  const d = requireDeployment();
  const common = { address: d.zeroDrop, abi: zeroDropAbi, fromBlock: BigInt(d.deployedBlock), toBlock: "latest" } as const;
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
