/**
 * Pinner endpoints the app uses. The user's list (settings.pinnerEndpoints) wins. When it is empty and the active
 * deployment is local, a local default list is used and shown as such, never silently saved:
 *   - a zerodrop pinner (scripts/pinner.ts; `pnpm pinner`)
 *   - a Kubo node, with its API and its gateway on different ports
 * There are no default pinners for a non-local deployment: the user has to add them.
 */
import { resolveDocument, type PinnerEndpoint, type ResolveResult, type Settings } from "@zerodrop/core";
import type { Deployment } from "./config";

const env = import.meta.env as Record<string, string | undefined>;

export const DEFAULT_ZERODROP_PINNER_URL = env.VITE_ZERODROP_PINNER_URL ?? "http://127.0.0.1:8787";
export const DEFAULT_KUBO_API_URL = env.VITE_KUBO_API_URL ?? "http://127.0.0.1:15001";
export const DEFAULT_KUBO_GATEWAY_URL = env.VITE_KUBO_GATEWAY_URL ?? "http://127.0.0.1:18080";

export function defaultLocalPinners(): PinnerEndpoint[] {
  return [
    { id: "zerodrop-local", kind: "zerodrop", url: DEFAULT_ZERODROP_PINNER_URL },
    { id: "kubo-local", kind: "kubo", url: DEFAULT_KUBO_API_URL, gatewayUrl: DEFAULT_KUBO_GATEWAY_URL },
  ];
}

export type EffectivePinners = { endpoints: PinnerEndpoint[]; fromDefaults: boolean };

export function effectivePinners(settings: Pick<Settings, "pinnerEndpoints">, deployment: Deployment | undefined): EffectivePinners {
  if (settings.pinnerEndpoints.length > 0) return { endpoints: settings.pinnerEndpoints, fromDefaults: false };
  if (deployment?.local) return { endpoints: defaultLocalPinners(), fromDefaults: true };
  return { endpoints: [], fromDefaults: false };
}

export function describeEndpoint(e: PinnerEndpoint): string {
  return e.kind === "kubo" ? `Kubo ${e.url}${e.gatewayUrl ? ` (gateway ${e.gatewayUrl})` : " (no gateway URL: cannot be read from)"}` : `zerodrop pinner ${e.url}`;
}

export type HolderProbe = {
  /** Verified bytes from the first endpoint that had them. */
  bytes?: Uint8Array;
  source?: string;
  holders: string[];
  /** Endpoints that answered with the wrong bytes, which are rejected. */
  wrong: string[];
  failures: Array<{ id: string; error: string }>;
  results: ResolveResult[];
};

/**
 * Asks every endpoint on its own (resolveDocument with one endpoint each), so the reader learns which ones hold
 * the document, not just which answered first. Bytes are accepted only if their sha256 matches the CID.
 */
export async function probeHolders(cid: string, endpoints: readonly PinnerEndpoint[], signal?: AbortSignal): Promise<HolderProbe> {
  const results = await Promise.all(endpoints.map((e) => resolveDocument({ cid, endpoints: [e], role: "reader", signal })));
  const holders: string[] = [];
  const wrong: string[] = [];
  const failures: Array<{ id: string; error: string }> = [];
  let bytes: Uint8Array | undefined;
  let source: string | undefined;
  results.forEach((r, i) => {
    const id = endpoints[i]!.id;
    if (r.ok && r.bytes) {
      holders.push(id);
      if (!bytes) {
        bytes = r.bytes;
        source = id;
      }
    } else if (r.wrongBytes.length > 0) wrong.push(id);
    else failures.push({ id, error: r.attempts[0]?.error ?? r.reason ?? "failed" });
  });
  return { bytes, source, holders, wrong, failures, results };
}

/** Message for an http(s) URL field, or undefined when the text is acceptable. */
export function urlProblem(text: string): string | undefined {
  const value = text.trim();
  if (!value) return "Enter a URL.";
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "Only http:// and https:// URLs are accepted.";
  } catch {
    return "Not a valid URL.";
  }
  return undefined;
}
