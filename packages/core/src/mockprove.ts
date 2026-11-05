/**
 * MOCK disclosure proof. For deployments whose verifier is MockVerifier (verifierKind "mock"), which accepts any
 * proof bytes. It proves NOTHING: no membership, no knowledge of a secret. It exists so the whole flow (pin, delay,
 * post, record, read, bundle) can run without the Semaphore circuit artifacts.
 *
 * What it does produce honestly:
 * - `root` and `depth` come from the real group (the contract still checks the root is a known root of the group
 *   and that the group has at least minSize members).
 * - `nullifier` is stable per (identity, caseId) and never zero, so the contract's one-disclosure-per-case rule
 *   behaves like the real thing. It is keccak256(secretScalar, scopeOf(caseId)) mod the field, not the Semaphore
 *   nullifier (poseidon2(scope, secret)), so it is NOT interchangeable with a real proof's nullifier.
 * - `proofBytes` is 256 zero bytes, the same length as an abi.encode(uint256[8]) Groth16 proof. The contract's
 *   proof length rule is 1..1024 bytes (the real adapter wants exactly 256).
 *
 * A mock proof must never be shown as verified. bundle.ts reports L2 "mock" for proofMode "mock".
 */
import type { Group } from "@semaphore-protocol/group";
import type { Identity } from "@semaphore-protocol/identity";
import { concat, keccak256, toHex } from "viem";
import { MAX_DEPTH, MIN_DEPTH, messageOf, scopeOf, semaphoreHash, SNARK_SCALAR_FIELD, type DisclosureProof } from "./prove";

export const MOCK_PROOF_BYTES: `0x${string}` = `0x${"00".repeat(256)}`;

export type ProveDisclosureMockInput = {
  identity: Identity;
  /** The group the identity's commitment is a member of. */
  group: Group;
  groupId: bigint;
  caseId: `0x${string}`;
  cidDigest: `0x${string}`;
  /** Defaults to the group's depth (at least 1). */
  depth?: number;
};

/** Stable, nonzero nullifier for (identity, case). Different cases and different identities differ. */
export function mockNullifier(identity: Identity, caseId: `0x${string}`): bigint {
  const secret = toHex(identity.secretScalar, { size: 32 });
  const scope = toHex(scopeOf(caseId), { size: 32 });
  const value = BigInt(keccak256(concat([secret, scope]))) % SNARK_SCALAR_FIELD;
  return value === 0n ? 1n : value;
}

/** Same shape as proveDisclosure. Async only so call sites can swap the two. */
export async function proveDisclosureMock(input: ProveDisclosureMockInput): Promise<DisclosureProof> {
  const { identity, group, groupId, caseId, cidDigest } = input;
  if (group.indexOf(identity.commitment) === -1) {
    throw new Error("Identity commitment is not a member of this group");
  }
  const depth = input.depth ?? Math.max(MIN_DEPTH, group.depth);
  if (!Number.isInteger(depth) || depth < MIN_DEPTH || depth > MAX_DEPTH) {
    throw new Error(`Depth must be an integer between ${MIN_DEPTH} and ${MAX_DEPTH}`);
  }
  if (group.depth > depth) throw new Error(`Group depth ${group.depth} exceeds requested depth ${depth}`);

  const root = BigInt(group.root);
  const nullifier = mockNullifier(identity, caseId);
  const messageHash = messageOf(cidDigest, groupId, caseId);
  const scopeHash = scopeOf(caseId);
  return {
    root,
    nullifier,
    depth,
    messageHash,
    scopeHash,
    proofBytes: MOCK_PROOF_BYTES,
    publicInputs: [root, nullifier, semaphoreHash(messageHash), semaphoreHash(scopeHash)],
  };
}
