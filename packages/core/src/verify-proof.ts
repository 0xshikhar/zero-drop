import { verifyProof, type SemaphoreProof } from "@semaphore-protocol/proof";
import { decodeAbiParameters } from "viem";
import { MAX_DEPTH, MIN_DEPTH, SNARK_SCALAR_FIELD } from "./prove";

export type VerifyDisclosureInput = {
  proofBytes: `0x${string}`;
  root: bigint;
  nullifier: bigint;
  depth: number;
  /** The raw messageOf value used when proving. */
  messageHash: bigint;
  /** The raw scopeOf value used when proving. */
  scopeHash: bigint;
};

/** Decodes abi.encode(uint256[8]) proof bytes into the eight Groth16 points. Throws on malformed input. */
export function decodeProofBytes(hex: `0x${string}`): bigint[] {
  if (!/^0x[0-9a-fA-F]{512}$/.test(hex)) {
    throw new Error("Proof bytes must be 256 bytes of hex (abi.encode of uint256[8])");
  }
  const [points] = decodeAbiParameters([{ type: "uint256[8]" }], hex);
  return [...points];
}

/**
 * Verifies a disclosure proof locally with the verification keys bundled in @semaphore-protocol/proof.
 * Makes no network requests. Malformed input or any failed check returns false rather than throwing.
 */
export async function verifyDisclosureProof(input: VerifyDisclosureInput): Promise<boolean> {
  const { root, nullifier, depth, messageHash, scopeHash } = input;
  if (!Number.isInteger(depth) || depth < MIN_DEPTH || depth > MAX_DEPTH) return false;
  for (const value of [root, nullifier, messageHash, scopeHash]) {
    if (typeof value !== "bigint" || value < 0n || value >= SNARK_SCALAR_FIELD) return false;
  }

  let points: bigint[];
  try {
    points = decodeProofBytes(input.proofBytes);
  } catch {
    return false;
  }

  const proof = {
    merkleTreeDepth: depth,
    merkleTreeRoot: root.toString(),
    nullifier: nullifier.toString(),
    message: messageHash.toString(),
    scope: scopeHash.toString(),
    points: points.map((p) => p.toString()),
  } as unknown as SemaphoreProof;

  try {
    return await verifyProof(proof);
  } catch {
    return false;
  }
}
