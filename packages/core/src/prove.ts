import type { Identity } from "@semaphore-protocol/identity";
import type { Group } from "@semaphore-protocol/group";
import { generateProof } from "@semaphore-protocol/proof";
import { concat, encodeAbiParameters, keccak256, stringToHex, toHex } from "viem";

/** BN254 scalar field modulus. Every public input of the Semaphore circuit is a field element. */
export const SNARK_SCALAR_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

export const SCOPE_PREFIX = "zerodrop/v1";
export const MIN_DEPTH = 1;
export const MAX_DEPTH = 32;

/**
 * Semaphore's circuit input hash: keccak256 of the 32-byte value, shifted right by 8 bits.
 * generateProof and verifyProof apply this to `message` and `scope` before they reach the circuit,
 * so the Groth16 public inputs are semaphoreHash(messageOf(...)) and semaphoreHash(scopeOf(...)).
 */
export function semaphoreHash(value: bigint): bigint {
  return BigInt(keccak256(toHex(value, { size: 32 }))) >> 8n;
}

/** Message bound by a disclosure: keccak256(abi.encode(cidDigest, groupId, caseId)) mod the scalar field. */
export function messageOf(cidDigest: `0x${string}`, groupId: bigint, caseId: `0x${string}`): bigint {
  const encoded = encodeAbiParameters(
    [{ type: "bytes32" }, { type: "uint256" }, { type: "bytes32" }],
    [cidDigest, groupId, caseId],
  );
  return BigInt(keccak256(encoded)) % SNARK_SCALAR_FIELD;
}

/** Scope bound to a case: keccak256("zerodrop/v1" || caseId) mod the scalar field (encodePacked). */
export function scopeOf(caseId: `0x${string}`): bigint {
  return BigInt(keccak256(concat([stringToHex(SCOPE_PREFIX), caseId]))) % SNARK_SCALAR_FIELD;
}

/** Semaphore circuit artifacts as file paths or URLs. Node reads them as paths; browsers fetch them as URLs. */
export type SemaphoreArtifacts = { wasm: string; zkey: string };

export class ArtifactsMissingError extends Error {
  override name = "ArtifactsMissingError";
}

/** File names expected for a tree depth: semaphore-<depth>.wasm and semaphore-<depth>.zkey. */
export function artifactNames(depth: number): { wasm: string; zkey: string } {
  return { wasm: `semaphore-${depth}.wasm`, zkey: `semaphore-${depth}.zkey` };
}

/**
 * Resolves the circuit artifacts for a depth. Nothing is fetched from a network here: the caller
 * must pass them, or register a provider that returns bundled asset URLs (e.g. Vite `?url` imports).
 * generateProof without artifacts would download them from snark-artifacts.pse.dev, which this package never does.
 */
export async function loadArtifacts(
  depth: number,
  provider?: (depth: number) => SemaphoreArtifacts | Promise<SemaphoreArtifacts>,
): Promise<SemaphoreArtifacts> {
  if (!provider) {
    const names = artifactNames(depth);
    throw new ArtifactsMissingError(
      `No Semaphore artifacts supplied for depth ${depth}. Expected ${names.wasm} and ${names.zkey} from a bundled asset provider.`,
    );
  }
  return provider(depth);
}

export type ProveDisclosureInput = {
  identity: Identity;
  /** The group the identity's commitment is a member of. Its root must be one the contract has recorded. */
  group: Group;
  groupId: bigint;
  caseId: `0x${string}`;
  cidDigest: `0x${string}`;
  /** Tree depth the circuit was compiled for. Defaults to the group's depth (at least 1). */
  depth?: number;
  /** Circuit artifacts for that depth. Required: this function never downloads them. */
  artifacts: SemaphoreArtifacts;
};

export type DisclosureProof = {
  root: bigint;
  nullifier: bigint;
  depth: number;
  /** Raw message passed to Semaphore (messageOf). */
  messageHash: bigint;
  /** Raw scope passed to Semaphore (scopeOf). */
  scopeHash: bigint;
  /** abi.encode(uint256[8]) of the Groth16 points, 256 bytes. */
  proofBytes: `0x${string}`;
  /** Groth16 public inputs in verifier order: [root, nullifier, semaphoreHash(messageHash), semaphoreHash(scopeHash)]. */
  publicInputs: bigint[];
};

/**
 * Generates a Semaphore disclosure proof for one identity in one group, bound to a case and a document digest.
 * Two proofs by the same identity for the same caseId share a nullifier, which is what prevents double disclosure.
 */
export async function proveDisclosure(input: ProveDisclosureInput): Promise<DisclosureProof> {
  const { identity, group, groupId, caseId, cidDigest, artifacts } = input;
  if (group.indexOf(identity.commitment) === -1) {
    throw new Error("Identity commitment is not a member of this group");
  }
  const depth = input.depth ?? Math.max(MIN_DEPTH, group.depth);
  if (!Number.isInteger(depth) || depth < MIN_DEPTH || depth > MAX_DEPTH) {
    throw new Error(`Depth must be an integer between ${MIN_DEPTH} and ${MAX_DEPTH}`);
  }
  if (group.depth > depth) {
    throw new Error(`Group depth ${group.depth} exceeds requested circuit depth ${depth}`);
  }

  const messageHash = messageOf(cidDigest, groupId, caseId);
  const scopeHash = scopeOf(caseId);

  const proof = await generateProof(identity, group, messageHash, scopeHash, depth, artifacts);

  const root = BigInt(proof.merkleTreeRoot);
  const nullifier = BigInt(proof.nullifier);
  const points = proof.points.map((p) => BigInt(p)) as unknown as readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint];
  const proofBytes = encodeAbiParameters([{ type: "uint256[8]" }], [points]);

  return {
    root,
    nullifier,
    depth,
    messageHash,
    scopeHash,
    proofBytes,
    publicInputs: [root, nullifier, semaphoreHash(messageHash), semaphoreHash(scopeHash)],
  };
}
