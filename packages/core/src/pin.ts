/**
 * Publishing to pinners (F4) and the reader's "Keep it online" re-pin (F19).
 *
 * PressProtocol is published (v1.0.7), but ZeroDrop intentionally implements its own lightweight
 * raw CIDv1 pinning client to maintain a zero-dependency, single-egress architecture that routes all traffic
 * through network.fetch. Two wire formats:
 *
 * - "kubo":     Kubo HTTP API. `POST {url}/api/v0/add?cid-version=1&raw-leaves=true&pin=true&chunker=size-1048576`
 *               (multipart). The returned Hash must equal our CID or the pin is rejected.
 * - "zerodrop": our own minimal protocol, implemented by scripts/pinner.ts.
 *               `PUT {url}/pin/<cid>` with the raw bytes; `GET {url}/ipfs/<cid>` returns them.
 *               The pinner re-hashes the body and rejects it when sha256 does not match the CID.
 *
 * Every request goes through `network.fetch` (net.ts), the only egress. Nothing here talks to the network
 * directly, and nothing here claims anonymity: the route is whatever net.ts says it is.
 */
import { cidFor } from "./content";
import { network, type NetworkClient, type RequestRole } from "./net";

export type PinnerKind = "kubo" | "zerodrop";

export type PinnerEndpoint = {
  id: string;
  kind: PinnerKind;
  /** Base URL without a trailing slash requirement (one is tolerated). */
  url: string;
  /**
   * Read gateway base URL. Kubo serves its HTTP API and its gateway on different ports, so a kubo
   * endpoint needs this for resolve (`GET {gatewayUrl}/ipfs/<cid>`). Zerodrop pinners serve both on `url`.
   */
  gatewayUrl?: string;
};

/** Documents are capped at 1 MiB everywhere (publish, pinner server, resolve). */
export const MAX_DOCUMENT_BYTES = 1_048_576;

/** CIDv1, raw codec (0x55), sha2-256 (0x12), 32-byte digest, base32 lowercase: "b" + 58 chars. */
const CID_PATTERN = /^b[a-z2-7]{58}$/;
const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

/**
 * Parses a CIDv1 raw/sha2-256 base32 string by hand (the multiformats subpath imports do not resolve under
 * Node ESM) and returns its 32-byte digest as 0x-hex. Returns undefined for anything else.
 */
export function digestFromCid(cid: string): `0x${string}` | undefined {
  if (typeof cid !== "string" || !CID_PATTERN.test(cid)) return undefined;
  let buffer = 0;
  let bits = 0;
  const out: number[] = [];
  for (const char of cid.slice(1)) {
    buffer = ((buffer << 5) | BASE32_ALPHABET.indexOf(char)) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out.push((buffer >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  // 58 chars = 290 bits = 36 bytes + 2 padding bits, which must be zero for a canonical encoding.
  if (out.length !== 36 || (buffer & ((1 << bits) - 1)) !== 0) return undefined;
  if (out[0] !== 0x01 || out[1] !== 0x55 || out[2] !== 0x12 || out[3] !== 0x20) return undefined;
  return `0x${out.slice(4).map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export type PinOptions = {
  /** Defaults to the shared `network`. Tests pass a NetworkClient with a fake transport. */
  client?: NetworkClient;
  /** Isolation session label recorded by net.ts. */
  session?: string;
  signal?: AbortSignal;
};

export type PinResult = {
  endpointId: string;
  kind: PinnerKind;
  ok: boolean;
  /** Present when ok is false. */
  error?: string;
};

export type PublishInput = PinOptions & {
  bytes: Uint8Array;
  /** Must equal cidFor(bytes); checked before anything leaves the machine. */
  cid: string;
  endpoints: readonly PinnerEndpoint[];
  /** Pins that must succeed for `ok`. Default 2 (F19: more than one pinner). */
  minPins?: number;
  /** Defaults to "source". */
  role?: RequestRole;
};

export type PublishResult = {
  /** True when at least `minPins` endpoints stored the document. */
  ok: boolean;
  pinned: number;
  minPins: number;
  cid: string;
  results: PinResult[];
};

/** Thrown before any request for inputs that can never be pinned (wrong CID, too large, bad URL). */
export class PinInputError extends Error {
  override name = "PinInputError";
}

function trimUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

function checkInput(bytes: Uint8Array, cid: string): void {
  if (bytes.length === 0) throw new PinInputError("Refusing to pin an empty document.");
  // Kubo only yields a raw CIDv1 (sha2-256) for a file that fits in a single chunk. We pin a chunker of
  // exactly 1 MiB, so anything larger would be split into a dag-pb tree with a different CID. The
  // zerodrop pinner enforces the same cap, so the limit is the same for both wire formats.
  if (bytes.length > MAX_DOCUMENT_BYTES) {
    throw new PinInputError(
      `Document is ${bytes.length} bytes; the limit is ${MAX_DOCUMENT_BYTES} (1 MiB). Larger files would be chunked by Kubo into a different CID.`,
    );
  }
  if (!digestFromCid(cid)) throw new PinInputError(`"${cid}" is not a CIDv1 raw sha2-256 base32 string.`);
  if (cidFor(bytes) !== cid) throw new PinInputError("The CID does not match the bytes (cidFor(bytes) differs).");
}

async function describeFailure(response: Response): Promise<string> {
  let detail = "";
  try {
    detail = (await response.text()).slice(0, 200).trim();
  } catch {
    // body unreadable; the status is enough
  }
  return `HTTP ${response.status}${detail ? `: ${detail}` : ""}`;
}

async function uploadKubo(
  endpoint: PinnerEndpoint,
  bytes: Uint8Array,
  cid: string,
  role: RequestRole,
  opts: PinOptions,
): Promise<void> {
  const query = "cid-version=1&raw-leaves=true&pin=true&chunker=size-1048576&hash=sha2-256";
  const form = new FormData();
  form.append("file", new Blob([bytes as BlobPart], { type: "application/octet-stream" }), "document");
  const response = await (opts.client ?? network).fetch(
    `${trimUrl(endpoint.url)}/api/v0/add?${query}`,
    { method: "POST", body: form, signal: opts.signal },
    role,
    opts.session,
  );
  if (!response.ok) throw new Error(await describeFailure(response));
  // Kubo answers with newline-delimited JSON; the last object describes the root.
  const lines = (await response.text()).split("\n").filter((l) => l.trim());
  const last = lines[lines.length - 1];
  let hash: unknown;
  try {
    hash = (JSON.parse(last ?? "") as { Hash?: unknown }).Hash;
  } catch {
    throw new Error("Kubo returned a response that is not JSON.");
  }
  if (typeof hash !== "string") throw new Error("Kubo response has no Hash.");
  if (hash !== cid) throw new Error(`Kubo stored the data under ${hash}, expected ${cid}.`);
}

async function uploadZerodrop(
  endpoint: PinnerEndpoint,
  bytes: Uint8Array,
  cid: string,
  role: RequestRole,
  opts: PinOptions,
): Promise<void> {
  const response = await (opts.client ?? network).fetch(
    `${trimUrl(endpoint.url)}/pin/${cid}`,
    { method: "PUT", body: bytes as BodyInit, headers: { "content-type": "application/octet-stream" }, signal: opts.signal },
    role,
    opts.session,
  );
  if (!response.ok) throw new Error(await describeFailure(response));
  // The pinner may echo {cid}. If it does, it has to be ours.
  const text = await response.text().catch(() => "");
  if (text.trim().startsWith("{")) {
    try {
      const echoed = (JSON.parse(text) as { cid?: unknown }).cid;
      if (typeof echoed === "string" && echoed !== cid) throw new Error(`Pinner reports ${echoed}, expected ${cid}.`);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Pinner reports")) throw error;
    }
  }
}

async function pinOne(
  endpoint: PinnerEndpoint,
  bytes: Uint8Array,
  cid: string,
  role: RequestRole,
  opts: PinOptions,
): Promise<PinResult> {
  try {
    if (endpoint.kind === "kubo") await uploadKubo(endpoint, bytes, cid, role, opts);
    else if (endpoint.kind === "zerodrop") await uploadZerodrop(endpoint, bytes, cid, role, opts);
    else throw new Error(`Unknown pinner kind "${String((endpoint as { kind: unknown }).kind)}".`);
    return { endpointId: endpoint.id, kind: endpoint.kind, ok: true };
  } catch (caught) {
    return {
      endpointId: endpoint.id,
      kind: endpoint.kind,
      ok: false,
      error: caught instanceof Error ? caught.message : String(caught),
    };
  }
}

/**
 * Uploads the document to every endpoint in parallel and reports per-endpoint results.
 * `ok` is true when at least `minPins` (default 2) endpoints stored it. Failures never throw; invalid
 * input (CID mismatch, over 1 MiB, empty) throws PinInputError before any request is made.
 */
export async function publishDocument(input: PublishInput): Promise<PublishResult> {
  const { bytes, cid, endpoints } = input;
  const minPins = input.minPins ?? 2;
  if (!Number.isInteger(minPins) || minPins < 1) throw new PinInputError("minPins must be an integer >= 1.");
  checkInput(bytes, cid);
  const role = input.role ?? "source";
  const results = await Promise.all(endpoints.map((endpoint) => pinOne(endpoint, bytes, cid, role, input)));
  const pinned = results.filter((r) => r.ok).length;
  return { ok: pinned >= minPins, pinned, minPins, cid, results };
}

/**
 * F19 "Keep it online": a reader re-pins bytes they already verified to a pinner of their choice.
 * Same upload path as publishing, with role "reader". The bytes are re-checked against the CID first so a
 * reader cannot be tricked into pushing something that is not the document.
 */
export async function keepOnline(
  input: PinOptions & { bytes: Uint8Array; cid: string; endpoint: PinnerEndpoint },
): Promise<PinResult> {
  checkInput(input.bytes, input.cid);
  return pinOne(input.endpoint, input.bytes, input.cid, "reader", input);
}
