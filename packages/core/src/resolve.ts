/**
 * Resolving a document by CID (F4, F19): race every pinner / gateway, accept only bytes whose sha256 matches
 * the CID digest. Mismatching bytes are never returned, whatever the endpoint claims.
 *
 * Wire format: `GET {url}/ipfs/<cid>` on zerodrop pinners, Kubo gateways and public-style gateways alike.
 * All requests go through `network.fetch` (net.ts) with the given role.
 */
import { checkContentHash } from "./content";
import { network, type NetworkClient, type RequestRole } from "./net";
import { digestFromCid, MAX_DOCUMENT_BYTES, type PinnerEndpoint } from "./pin";

export type ResolveAttemptStatus =
  /** Returned bytes that hash to the CID. */
  | "verified"
  /** Answered, but the bytes do not hash to the CID. Rejected. */
  | "wrong-bytes"
  /** Network error, non-2xx, or over the size cap. */
  | "failed"
  /** Aborted because another endpoint won first. */
  | "cancelled";

export type ResolveAttempt = {
  endpointId: string;
  url: string;
  status: ResolveAttemptStatus;
  error?: string;
};

export type ResolveResult = {
  ok: boolean;
  cid: string;
  /** The verified bytes. Present only when ok. */
  bytes?: Uint8Array;
  /** Endpoint that delivered the verified bytes. */
  source?: string;
  reason?: string;
  attempts: ResolveAttempt[];
  /** Endpoint ids that answered with a body (verified or not). */
  answered: string[];
  failed: string[];
  wrongBytes: string[];
};

export type ResolveInput = {
  cid: string;
  endpoints: readonly PinnerEndpoint[];
  /** Extra gateway base URLs (e.g. a public IPFS gateway the caller chose). None by default. */
  gateways?: readonly string[];
  role?: RequestRole;
  client?: NetworkClient;
  session?: string;
  signal?: AbortSignal;
  /** Default and maximum 1 MiB. */
  maxBytes?: number;
};

class NotOk extends Error {}

async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new NotOk(`Response is ${declared} bytes; limit is ${maxBytes}.`);
  if (!response.body) {
    const all = new Uint8Array(await response.arrayBuffer());
    if (all.length > maxBytes) throw new NotOk(`Response exceeds ${maxBytes} bytes.`);
    return all;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new NotOk(`Response exceeds ${maxBytes} bytes.`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * Races all endpoints and gateways. Resolves with the first response whose sha256 matches the CID digest
 * and aborts the rest. When nothing verifies, `ok` is false and `attempts` says why per endpoint.
 */
export async function resolveDocument(input: ResolveInput): Promise<ResolveResult> {
  const { cid } = input;
  const digest = digestFromCid(cid);
  const role = input.role ?? "reader";
  const maxBytes = Math.min(input.maxBytes ?? MAX_DOCUMENT_BYTES, MAX_DOCUMENT_BYTES);
  const client = input.client ?? network;

  const targets: Array<{ id: string; url: string }> = [];
  const seen = new Set<string>();
  const add = (id: string, base: string) => {
    const url = `${base.replace(/\/+$/, "")}/ipfs/${cid}`;
    if (seen.has(url)) return;
    seen.add(url);
    targets.push({ id, url });
  };
  for (const endpoint of input.endpoints) add(endpoint.id, endpoint.url);
  for (const gateway of input.gateways ?? []) add(gateway, gateway);

  const fail = (reason: string, attempts: ResolveAttempt[] = []): ResolveResult => summarize({ ok: false, cid, reason, attempts });
  if (!digest) return fail(`"${cid}" is not a CIDv1 raw sha2-256 base32 string.`);
  if (targets.length === 0) return fail("No endpoints or gateways to resolve from.");

  const controllers = targets.map(() => new AbortController());
  const abortAll = () => controllers.forEach((c) => c.abort());
  if (input.signal?.aborted) abortAll();
  input.signal?.addEventListener("abort", abortAll, { once: true });

  const attempts: ResolveAttempt[] = targets.map((t) => ({ endpointId: t.id, url: t.url, status: "cancelled" as const }));
  let winner: { index: number; bytes: Uint8Array } | undefined;

  await new Promise<void>((resolve) => {
    let pending = targets.length;
    const settle = () => {
      pending -= 1;
      if (pending === 0) resolve();
    };
    targets.forEach((target, index) => {
      const attempt = attempts[index]!;
      void (async () => {
        try {
          const response = await client.fetch(target.url, { method: "GET", signal: controllers[index]!.signal }, role, input.session);
          if (!response.ok) throw new NotOk(`HTTP ${response.status}`);
          const bytes = await readCapped(response, maxBytes);
          if (winner) return; // lost the race; stays "cancelled"
          if (checkContentHash(bytes, digest)) {
            attempt.status = "verified";
            winner = { index, bytes };
            controllers.forEach((c, i) => i !== index && c.abort());
            resolve();
          } else {
            attempt.status = "wrong-bytes";
            attempt.error = "sha256 of the returned bytes does not match the CID digest.";
          }
        } catch (caught) {
          if (winner || controllers[index]!.signal.aborted) return; // aborted by us: "cancelled"
          attempt.status = "failed";
          attempt.error = caught instanceof Error ? caught.message : String(caught);
        } finally {
          settle();
        }
      })();
    });
  });

  input.signal?.removeEventListener("abort", abortAll);

  if (winner) {
    return summarize({ ok: true, cid, bytes: winner.bytes, source: targets[winner.index]!.id, attempts });
  }
  const failedAll = attempts.some((a) => a.status === "wrong-bytes")
    ? "Every endpoint failed or returned bytes that do not match the CID."
    : "No endpoint could be reached with a valid response.";
  return summarize({ ok: false, cid, reason: failedAll, attempts });
}

function summarize(partial: Pick<ResolveResult, "ok" | "cid" | "attempts"> & Partial<ResolveResult>): ResolveResult {
  const ids = (pred: (a: ResolveAttempt) => boolean) => partial.attempts.filter(pred).map((a) => a.endpointId);
  return {
    ...partial,
    answered: ids((a) => a.status === "verified" || a.status === "wrong-bytes"),
    failed: ids((a) => a.status === "failed"),
    wrongBytes: ids((a) => a.status === "wrong-bytes"),
  };
}
