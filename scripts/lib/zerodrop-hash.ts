import {
  encodeAbiParameters,
  encodePacked,
  keccak256,
  type Hex,
} from "viem";

/** BN254 scalar field modulus. Must match ZeroDrop.SNARK_SCALAR_FIELD. */
export const SNARK_SCALAR_FIELD =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/** Mirrors ZeroDrop.messageOf: uint256(keccak256(abi.encode(cid, groupId, caseId))) % FIELD. */
export function messageOf(cidDigest: Hex, groupId: bigint, caseId: Hex): bigint {
  const encoded = encodeAbiParameters(
    [{ type: "bytes32" }, { type: "uint256" }, { type: "bytes32" }],
    [cidDigest, groupId, caseId],
  );
  return BigInt(keccak256(encoded)) % SNARK_SCALAR_FIELD;
}

/** Mirrors ZeroDrop.scopeOf: uint256(keccak256(abi.encodePacked("zerodrop/v1", caseId))) % FIELD. */
export function scopeOf(caseId: Hex): bigint {
  const packed = encodePacked(["string", "bytes32"], ["zerodrop/v1", caseId]);
  return BigInt(keccak256(packed)) % SNARK_SCALAR_FIELD;
}

/** ABI encoding of the proof bytes expected by SemaphoreVerifierAdapter: abi.encode(uint256[8]). */
export function encodeProofPoints(points: readonly bigint[]): Hex {
  if (points.length !== 8) throw new Error(`expected 8 proof points, got ${points.length}`);
  return encodeAbiParameters([{ type: "uint256[8]" }], [points as unknown as readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint]]);
}

export function toHexUint(value: bigint | string): Hex {
  return `0x${BigInt(value).toString(16).padStart(64, "0")}` as Hex;
}
