import { createPublicClient, defineChain, http, type Chain, type PublicClient } from "viem";
import { DEFAULT_TIMEOUT_MS, network as defaultNetwork, type NetworkClient, type RequestRole } from "./net";

/**
 * Chain definitions. Endpoints are passed in by the caller: the app and scripts layer reads
 * config/local.json and config/devnet.json, and this module never imports JSON.
 *
 * The default URLs below are only fallbacks for display. The app should always pass the endpoint
 * list from config.
 */
export const localChain = defineChain({
  id: 31337,
  name: "Anvil (local)",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["http://127.0.0.1:8545"] } },
});

/**
 * Public alt-mempool devnet. Frame transactions (EIP-8141) are NOT verified against this devnet yet:
 * from the development machine its TLS certificate currently fails validation ("certificate is not
 * yet valid"). Do not disable TLS verification to get around it.
 */
export const altMempoolDevnet = defineChain({
  id: 1337,
  name: "ZeroDrop devnet (alt-mempool)",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://altmempool.forshtat.com"] } },
});

const KNOWN_CHAINS: Record<number, Chain> = {
  [localChain.id]: localChain,
  [altMempoolDevnet.id]: altMempoolDevnet,
};

export type MakePublicClientOptions = {
  /** One viem public client is returned per URL, in the same order. */
  rpcUrls: readonly string[];
  chainId: number;
  /** Isolation role recorded on every request made by these clients. */
  role: RequestRole;
  session?: string;
  timeoutMs?: number;
  /** Defaults to the module-level `network` singleton. Tests inject a fake. */
  net?: NetworkClient;
};

/**
 * viem public clients, one per endpoint. Every request goes through `net.fetch`, so it is counted
 * and tagged with the role's isolation key. Requests are direct until Anon-RPC is integrated.
 */
export function makePublicClient(options: MakePublicClientOptions): PublicClient[] {
  const { rpcUrls, chainId, role, session = "default", timeoutMs = DEFAULT_TIMEOUT_MS } = options;
  const net = options.net ?? defaultNetwork;
  if (rpcUrls.length === 0) throw new Error("makePublicClient: no RPC endpoints configured");
  const chain = KNOWN_CHAINS[chainId];
  return rpcUrls.map(
    (url) =>
      createPublicClient({
        chain,
        transport: http(url, {
          timeout: timeoutMs,
          fetchFn: (input, init) => net.fetch(input, init, role, session),
        }),
      }) as PublicClient,
  );
}

export type FanOutOptions<T> = {
  /** How many endpoints must return the same answer. */
  quorum: number;
  /** Turns an answer into a comparable string. Defaults to a bigint-safe JSON encoding. */
  key?: (value: T) => string;
};

export type FanOutResult<T> = {
  ok: boolean;
  /** The agreed value when `ok`. */
  value?: T;
  /** Size of the largest agreeing group. */
  agreeing: number;
  total: number;
  reason: string;
  errors: string[];
};

/** Bigint-safe, key-order-stable encoding used to compare answers. */
export function stableKey(value: unknown): string {
  return JSON.stringify(value, (_key, v) => {
    if (typeof v === "bigint") return `${v.toString()}n`;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return Object.fromEntries(Object.keys(v).sort().map((k) => [k, (v as Record<string, unknown>)[k]]));
    }
    return v;
  });
}

/**
 * Asks every client the same question in parallel. Returns a value only when at least `quorum`
 * endpoints give the same answer. A single agreeing answer below the quorum is not enough. If two
 * different answers each reach the quorum, the result is ambiguous and is not returned.
 */
export async function fanOutRead<T>(
  clients: readonly PublicClient[],
  read: (client: PublicClient, index: number) => Promise<T>,
  options: FanOutOptions<T>,
): Promise<FanOutResult<T>> {
  const total = clients.length;
  const { quorum } = options;
  const key = options.key ?? stableKey;
  const fail = (reason: string, agreeing = 0, errors: string[] = []): FanOutResult<T> => ({
    ok: false,
    agreeing,
    total,
    reason,
    errors,
  });

  if (!Number.isInteger(quorum) || quorum < 1) return fail(`quorum must be an integer >= 1, got ${quorum}`);
  if (quorum > total) return fail(`quorum ${quorum} exceeds the ${total} configured endpoint(s)`);

  const settled = await Promise.allSettled(clients.map((client, index) => read(client, index)));
  const groups = new Map<string, { value: T; count: number }>();
  const errors: string[] = [];
  for (const outcome of settled) {
    if (outcome.status === "rejected") {
      errors.push(outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason));
      continue;
    }
    const k = key(outcome.value);
    const group = groups.get(k);
    if (group) group.count += 1;
    else groups.set(k, { value: outcome.value, count: 1 });
  }

  const largest = Math.max(0, ...[...groups.values()].map((g) => g.count));
  const winners = [...groups.values()].filter((g) => g.count >= quorum);
  if (winners.length === 0) {
    return fail(`no agreement: best answer has ${largest} of ${total} endpoints, quorum is ${quorum}`, largest, errors);
  }
  if (winners.length > 1) {
    return fail(`conflicting answers each reached the quorum of ${quorum}`, largest, errors);
  }
  const [winner] = winners;
  return { ok: true, value: winner!.value, agreeing: winner!.count, total, reason: "quorum reached", errors };
}
