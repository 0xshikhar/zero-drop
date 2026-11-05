/**
 * The `.zerodrop.json` proof bundle (F9): a self-contained record of one disclosure that can be checked with
 * no network at all.
 *
 * Offline checks and what they mean:
 * - L0 content: sha256 of the embedded document equals `digest` and `cid`. Needs `bytesBase64`.
 * - L2 membership: only for proofMode "semaphore", and only when the caller injects a `verifyProof`
 *   callback (e.g. verifyDisclosureProof from verify-proof.ts). With proofMode "mock" the L2 status is
 *   always "mock": a mock proof proves nothing and is never reported as verified.
 * - NOT checked offline: L1 inclusion. A bundle cannot prove that `root` was ever a root of the group, or
 *   that the transaction exists. Someone could build a bundle around a self-made group. L1 needs the chain.
 *
 * Numeric fields that exceed 2^53 (groupId, root, nullifier, blockNumber) are decimal strings.
 */
import { cidFor, digestOf } from "./content";
import type { ProofMode } from "./mode";
import { digestFromCid, MAX_DOCUMENT_BYTES } from "./pin";
import { messageOf, scopeOf } from "./prove";
import type { VerifyDisclosureInput } from "./verify-proof";

export const BUNDLE_VERSION = 1 as const;
export const BUNDLE_MEDIA_TYPES = ["text/plain", "text/markdown", "image/jpeg", "image/png", "image/webp", "application/pdf"] as const;
export type BundleMediaType = (typeof BUNDLE_MEDIA_TYPES)[number];

export type ProofBundle = {
  version: 1;
  chainId: number;
  contract: `0x${string}`;
  txHash: `0x${string}`;
  /** Decimal string. */
  blockNumber: string;
  /** Decimal string. */
  groupId: string;
  caseId: `0x${string}`;
  /** Decimal string. */
  root: string;
  /** Decimal string. */
  nullifier: string;
  depth: number;
  proofBytes: `0x${string}`;
  proofMode: ProofMode;
  cid: string;
  /** 0x sha256 digest; equal to the digest inside `cid`. */
  digest: `0x${string}`;
  mediaType: BundleMediaType;
  /** Optional embedded document (standard base64). */
  bytesBase64?: string;
  /** ISO 8601. */
  createdAt: string;
};

export class BundleError extends Error {
  override name = "BundleError";
}

type NumLike = bigint | number | string;

export type CreateBundleInput = {
  chainId: number;
  contract: `0x${string}`;
  txHash: `0x${string}`;
  blockNumber: NumLike;
  groupId: NumLike;
  caseId: `0x${string}`;
  root: NumLike;
  nullifier: NumLike;
  depth: number;
  proofBytes: `0x${string}`;
  proofMode: ProofMode;
  cid: string;
  mediaType: BundleMediaType;
  /** Embed the document so the bundle works with every pinner gone. Checked against the cid. */
  bytes?: Uint8Array;
  createdAt?: Date | string;
};

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) binary += String.fromCharCode(...bytes.subarray(i, i + step));
  return btoa(binary);
}

export function base64ToBytes(text: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)) {
    throw new BundleError("bytesBase64 is not valid base64.");
  }
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function decimal(value: NumLike, field: string): string {
  let text: string;
  if (typeof value === "bigint") text = value.toString();
  else if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new BundleError(`${field} must be a safe integer.`);
    text = String(value);
  } else text = value;
  if (!/^(0|[1-9][0-9]*)$/.test(text)) throw new BundleError(`${field} must be a non-negative decimal integer.`);
  return text;
}

/** Builds a bundle and validates it. Throws BundleError when the inputs disagree (e.g. bytes vs cid). */
export function createBundle(input: CreateBundleInput): ProofBundle {
  const digest = digestFromCid(input.cid);
  if (!digest) throw new BundleError(`"${input.cid}" is not a CIDv1 raw sha2-256 base32 string.`);
  if (input.bytes) {
    if (input.bytes.length > MAX_DOCUMENT_BYTES) throw new BundleError("Embedded document exceeds 1 MiB.");
    if (cidFor(input.bytes) !== input.cid) throw new BundleError("The embedded bytes do not match the cid.");
  }
  const createdAt = input.createdAt instanceof Date ? input.createdAt.toISOString() : (input.createdAt ?? new Date().toISOString());
  const bundle: ProofBundle = {
    version: BUNDLE_VERSION,
    chainId: input.chainId,
    contract: input.contract,
    txHash: input.txHash,
    blockNumber: decimal(input.blockNumber, "blockNumber"),
    groupId: decimal(input.groupId, "groupId"),
    caseId: input.caseId,
    root: decimal(input.root, "root"),
    nullifier: decimal(input.nullifier, "nullifier"),
    depth: input.depth,
    proofBytes: input.proofBytes,
    proofMode: input.proofMode,
    cid: input.cid,
    digest,
    mediaType: input.mediaType,
    ...(input.bytes ? { bytesBase64: bytesToBase64(input.bytes) } : {}),
    createdAt,
  };
  // Run the same validation a reader will run, so a bundle we write is a bundle we can read.
  return validateBundle(bundle);
}

export function serializeBundle(bundle: ProofBundle): string {
  return `${JSON.stringify(validateBundle(bundle), null, 2)}\n`;
}

const KEYS = new Set([
  "version", "chainId", "contract", "txHash", "blockNumber", "groupId", "caseId", "root", "nullifier",
  "depth", "proofBytes", "proofMode", "cid", "digest", "mediaType", "bytesBase64", "createdAt",
]);

function hex(value: unknown, field: string, bytes?: number): `0x${string}` {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]*$/.test(value) || value.length % 2 !== 0) {
    throw new BundleError(`${field} must be 0x-prefixed hex with an even number of digits.`);
  }
  if (bytes !== undefined && value.length !== 2 + bytes * 2) throw new BundleError(`${field} must be ${bytes} bytes of hex.`);
  return value as `0x${string}`;
}

function integer(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new BundleError(`${field} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

/** Strict validation of an untrusted value. Returns a normalized bundle or throws BundleError. */
export function validateBundle(raw: unknown): ProofBundle {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new BundleError("A bundle must be a JSON object.");
  const o = raw as Record<string, unknown>;
  if (o.version !== BUNDLE_VERSION) {
    throw new BundleError(`Unsupported bundle version ${JSON.stringify(o.version)}; this build reads version ${BUNDLE_VERSION}.`);
  }
  for (const key of Object.keys(o)) if (!KEYS.has(key)) throw new BundleError(`Unknown field "${key}".`);

  const proofMode = o.proofMode;
  if (proofMode !== "mock" && proofMode !== "semaphore") throw new BundleError('proofMode must be "mock" or "semaphore".');
  const mediaType = o.mediaType;
  if (typeof mediaType !== "string" || !(BUNDLE_MEDIA_TYPES as readonly string[]).includes(mediaType)) {
    throw new BundleError(`mediaType must be one of ${BUNDLE_MEDIA_TYPES.join(", ")}.`);
  }
  const cid = o.cid;
  if (typeof cid !== "string") throw new BundleError("cid must be a string.");
  const cidDigest = digestFromCid(cid);
  if (!cidDigest) throw new BundleError(`cid "${cid}" is not a CIDv1 raw sha2-256 base32 string.`);
  const digest = hex(o.digest, "digest", 32);
  if (digest.toLowerCase() !== cidDigest) throw new BundleError("digest does not match the digest inside cid.");

  const proofBytes = hex(o.proofBytes, "proofBytes");
  if (proofMode === "semaphore" && proofBytes.length !== 2 + 512) {
    throw new BundleError("proofBytes must be 256 bytes (abi.encode of uint256[8]) for a semaphore proof.");
  }
  if (proofBytes.length < 4) throw new BundleError("proofBytes must not be empty.");

  const createdAt = o.createdAt;
  if (typeof createdAt !== "string" || Number.isNaN(Date.parse(createdAt))) throw new BundleError("createdAt must be an ISO 8601 date string.");

  const bundle: ProofBundle = {
    version: BUNDLE_VERSION,
    chainId: integer(o.chainId, "chainId", 1, Number.MAX_SAFE_INTEGER),
    contract: hex(o.contract, "contract", 20),
    txHash: hex(o.txHash, "txHash", 32),
    blockNumber: decimal(requireString(o.blockNumber, "blockNumber"), "blockNumber"),
    groupId: decimal(requireString(o.groupId, "groupId"), "groupId"),
    caseId: hex(o.caseId, "caseId", 32),
    root: decimal(requireString(o.root, "root"), "root"),
    nullifier: decimal(requireString(o.nullifier, "nullifier"), "nullifier"),
    depth: integer(o.depth, "depth", 1, 32),
    proofBytes,
    proofMode,
    cid,
    digest,
    mediaType: mediaType as BundleMediaType,
    createdAt,
  };
  if (o.bytesBase64 !== undefined) {
    if (typeof o.bytesBase64 !== "string") throw new BundleError("bytesBase64 must be a string.");
    // 1 MiB of bytes is at most 1,398,104 base64 characters.
    if (o.bytesBase64.length > Math.ceil(MAX_DOCUMENT_BYTES / 3) * 4) throw new BundleError("bytesBase64 exceeds 1 MiB.");
    base64ToBytes(o.bytesBase64); // throws on malformed input
    bundle.bytesBase64 = o.bytesBase64;
  }
  return bundle;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") throw new BundleError(`${field} must be a decimal string.`);
  return value;
}

/** Parses and validates bundle JSON text (or an already-parsed value). Throws BundleError with a specific reason. */
export function parseBundle(input: string | unknown): ProofBundle {
  let value: unknown = input;
  if (typeof input === "string") {
    try {
      value = JSON.parse(input);
    } catch {
      throw new BundleError("The file is not valid JSON.");
    }
  }
  return validateBundle(value);
}

export type L0Status = "verified" | "failed" | "unchecked";
export type L2Status = "verified" | "failed" | "mock" | "unchecked";

export type BundleVerification = {
  /** False when any check that ran failed. It does NOT mean everything was verified: read the statuses. */
  ok: boolean;
  l0: { status: L0Status; reason: string };
  l2: { status: L2Status; reason: string };
  /** What an offline check cannot establish. */
  notes: string[];
};

export type VerifyBundleOptions = {
  /** Local Groth16 verifier, e.g. verifyDisclosureProof. Required to reach L2 "verified". */
  verifyProof?: (input: VerifyDisclosureInput) => Promise<boolean> | boolean;
};

/** Checks L0 and (when a verifier is injected) L2. Makes no network requests. */
export async function verifyBundleOffline(bundle: ProofBundle, options: VerifyBundleOptions = {}): Promise<BundleVerification> {
  const notes = [
    "L1 (the onchain record and that this root belongs to the group) is not checked offline. Verify it against the chain.",
  ];

  let l0: BundleVerification["l0"];
  if (!bundle.bytesBase64) {
    l0 = { status: "unchecked", reason: "The bundle carries no document. Fetch it by CID and check its sha256 yourself." };
  } else {
    try {
      const bytes = base64ToBytes(bundle.bytesBase64);
      const digestOk = digestOf(bytes).toLowerCase() === bundle.digest.toLowerCase();
      const cidOk = cidFor(bytes) === bundle.cid;
      l0 =
        digestOk && cidOk
          ? { status: "verified", reason: "sha256 of the embedded document equals the digest and the CID." }
          : { status: "failed", reason: "The embedded document does not hash to the digest and CID in this bundle." };
    } catch (caught) {
      l0 = { status: "failed", reason: caught instanceof Error ? caught.message : String(caught) };
    }
  }

  let l2: BundleVerification["l2"];
  if (bundle.proofMode === "mock") {
    l2 = { status: "mock", reason: "Mock proof: it proves no membership and is never reported as verified." };
  } else if (!options.verifyProof) {
    l2 = { status: "unchecked", reason: "No proof verifier was provided, so the Semaphore proof was not checked." };
  } else {
    try {
      const groupId = BigInt(bundle.groupId);
      const input: VerifyDisclosureInput = {
        proofBytes: bundle.proofBytes,
        root: BigInt(bundle.root),
        nullifier: BigInt(bundle.nullifier),
        depth: bundle.depth,
        messageHash: messageOf(bundle.digest, groupId, bundle.caseId),
        scopeHash: scopeOf(bundle.caseId),
      };
      const valid = await options.verifyProof(input);
      l2 = valid
        ? { status: "verified", reason: "The Groth16 proof is valid for this root, nullifier, document digest and case." }
        : { status: "failed", reason: "The Groth16 proof does not verify for this root, nullifier, document digest and case." };
    } catch (caught) {
      l2 = { status: "failed", reason: caught instanceof Error ? caught.message : String(caught) };
    }
  }

  return { ok: l0.status !== "failed" && l2.status !== "failed", l0, l2, notes };
}
