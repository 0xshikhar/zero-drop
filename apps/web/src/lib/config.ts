/**
 * Deployments, read from config/*.json at build time.
 *
 * Every JSON in config/ that parses into something usable becomes an entry. A missing file is simply absent
 * (the app builds and runs with whatever is there), and config/devnet.json is kept as an entry even though its
 * ZeroDrop address is null, so Settings can say why it cannot be selected.
 *
 * The active deployment is a user preference (prefs.ts). Default: "local-mock", which works without circuit
 * artifacts. Nothing here talks to the network.
 */
import type { Address } from "viem";

export type VerifierKind = "mock" | "semaphore";

export type Deployment = {
  /** File name without .json. */
  id: string;
  label: string;
  chainId: number;
  rpcUrls: string[];
  verifierKind: VerifierKind;
  /** True when anyone can call ZeroDrop.record directly (local development). */
  directRecordEnabled: boolean;
  /** Null for a placeholder config (devnet before anything is deployed). */
  zeroDrop: Address | null;
  deployedBlock: number;
  sidecarUrls: string[];
  /** Every RPC URL is on this machine (127.0.0.1, localhost, ::1). */
  local: boolean;
  /** Why this entry cannot be selected, if it cannot. */
  unavailableReason?: string;
};

export const DEFAULT_DEPLOYMENT_ID = "local-mock";

const LABELS: Record<string, string> = {
  "local-mock": "Local anvil, mock verifier",
  local: "Local anvil, Semaphore verifier",
  devnet: "Alt-mempool devnet",
};

const files = import.meta.glob<unknown>("../../../../config/*.json", { eager: true, import: "default" });

export function isLoopbackUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]" || host.endsWith(".localhost");
  } catch {
    return false;
  }
}

type RawConfig = {
  chainId?: unknown;
  rpcUrl?: unknown;
  rpcUrls?: unknown;
  sidecarUrls?: unknown;
  verifierKind?: unknown;
  directRecordEnabled?: unknown;
  contracts?: { zeroDrop?: unknown };
  deployedBlock?: unknown;
};

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function fromFile(path: string, raw: unknown): Deployment | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const c = raw as RawConfig;
  const id = path.replace(/^.*\//, "").replace(/\.json$/, "");
  if (typeof c.chainId !== "number") return undefined;
  const rpcUrls = typeof c.rpcUrl === "string" ? [c.rpcUrl] : strings(c.rpcUrls);
  const zeroDrop = typeof c.contracts?.zeroDrop === "string" && /^0x[0-9a-fA-F]{40}$/.test(c.contracts.zeroDrop) ? (c.contracts.zeroDrop as Address) : null;
  const verifierKind: VerifierKind = c.verifierKind === "mock" ? "mock" : "semaphore";
  const directRecordEnabled = typeof c.directRecordEnabled === "boolean" ? c.directRecordEnabled : false;
  const deployment: Deployment = {
    id,
    label: LABELS[id] ?? id,
    chainId: c.chainId,
    rpcUrls,
    verifierKind,
    directRecordEnabled,
    zeroDrop,
    deployedBlock: typeof c.deployedBlock === "number" ? c.deployedBlock : 0,
    sidecarUrls: strings(c.sidecarUrls),
    local: rpcUrls.length > 0 && rpcUrls.every(isLoopbackUrl),
  };
  if (!zeroDrop) deployment.unavailableReason = `config/${id}.json has no ZeroDrop address (nothing deployed yet).`;
  else if (rpcUrls.length === 0) deployment.unavailableReason = `config/${id}.json has no RPC URL.`;
  return deployment;
}

/** All deployments found in config/, usable ones first (by default order: local-mock, local, then the rest). */
export const DEPLOYMENTS: Deployment[] = Object.entries(files)
  .map(([path, raw]) => fromFile(path, raw))
  .filter((d): d is Deployment => d !== undefined)
  .sort((a, b) => {
    const order = [DEFAULT_DEPLOYMENT_ID, "local"];
    const rank = (d: Deployment) => (d.unavailableReason ? 100 : order.indexOf(d.id) === -1 ? 50 : order.indexOf(d.id));
    return rank(a) - rank(b) || a.id.localeCompare(b.id);
  });

export function usableDeployments(): Deployment[] {
  return DEPLOYMENTS.filter((d) => !d.unavailableReason);
}

/** The devnet entry, if config/devnet.json exists. Frame transactions target it. */
export const DEVNET: Deployment | undefined = DEPLOYMENTS.find((d) => d.id === "devnet");

export function findDeployment(id: string | undefined): Deployment | undefined {
  return DEPLOYMENTS.find((d) => d.id === id && !d.unavailableReason);
}

/** Preferred default; falls back to the first usable deployment. Undefined when config/ has nothing usable. */
export function defaultDeployment(): Deployment | undefined {
  return findDeployment(DEFAULT_DEPLOYMENT_ID) ?? usableDeployments()[0];
}
