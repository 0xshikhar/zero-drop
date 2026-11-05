import {
  checkContentHash,
  messageOf,
  scopeOf,
  sizeAtRoot,
  verifyDisclosureProof,
  verifyInclusion,
  type InclusionResult,
} from "@zerodrop/core";
import type { Hex } from "viem";
import { LOCAL } from "./config";
import { zeroDropAbi } from "./adapter";
import { ZERODROP, loadGroups, readClient } from "./chain";

export type Layer = { ok: boolean; pending?: boolean; reason: string };

export type DisclosureReading = {
  l1: InclusionResult;
  /** Record fields, present when L1 found the record. */
  record?: { groupId: bigint; caseId: Hex; root: bigint; nullifier: bigint; depth: bigint; blockNumber: bigint; blockHash?: Hex };
  l2?: Layer;
  /** "Posted by k of N": k is the one-of-N statement, N is the group size at the record's root. */
  anonymity?: { groupId: bigint; size: number; minSize: number } | { error: string };
};

/** L1: the record and its Disclosed log agree across the configured endpoints. Not an eth_getProof check. */
export async function checkInclusion(cidDigest: Hex): Promise<InclusionResult> {
  return verifyInclusion({
    publicClients: [readClient()],
    zeroDropAddress: ZERODROP,
    cidDigest,
    quorum: "single-endpoint",
    expectedChainId: LOCAL.chainId,
  });
}

/**
 * L2: re-verify the Groth16 proof from the Disclosed log, bound to the record's digest, group and case.
 * It runs offline against the verification key shipped in @semaphore-protocol/proof.
 */
export async function checkProof(cidDigest: Hex, l1: InclusionResult): Promise<Layer> {
  if (!l1.ok || l1.groupId === undefined || l1.caseId === undefined || l1.root === undefined || l1.nullifier === undefined || l1.depth === undefined || l1.blockNumber === undefined) {
    return { ok: false, reason: "L1 did not produce a record to check" };
  }
  const logs = await readClient().getContractEvents({
    address: ZERODROP,
    abi: zeroDropAbi,
    eventName: "Disclosed",
    args: { cidDigest },
    fromBlock: l1.blockNumber,
    toBlock: l1.blockNumber,
  });
  const matching = logs.filter((log) => {
    const a = log.args as unknown as { groupId: bigint; caseId: Hex; root: bigint; nullifier: bigint };
    return a.groupId === l1.groupId && a.caseId.toLowerCase() === l1.caseId!.toLowerCase() && a.root === l1.root && a.nullifier === l1.nullifier;
  });
  if (matching.length !== 1) return { ok: false, reason: `expected one matching Disclosed log, found ${matching.length}` };
  const proofBytes = (matching[0]!.args as unknown as { proof: Hex }).proof;
  const ok = await verifyDisclosureProof({
    proofBytes,
    root: l1.root,
    nullifier: l1.nullifier,
    depth: Number(l1.depth),
    messageHash: messageOf(cidDigest, l1.groupId, l1.caseId),
    scopeHash: scopeOf(l1.caseId),
  });
  return ok
    ? { ok: true, reason: "Groth16 proof verifies against the record's root, nullifier, digest, group and case" }
    : { ok: false, reason: "Groth16 proof does not verify for this digest, group and case" };
}

/** Group size at the record's root, from the rebuilt group history. */
export async function anonymitySetFor(groupId: bigint, root: bigint): Promise<DisclosureReading["anonymity"]> {
  const groups = await loadGroups(readClient());
  const view = groups.find((g) => g.groupId === groupId);
  if (!view) return { error: "The group for this record was not found in the chain logs" };
  const size = sizeAtRoot(view.commitments, root);
  if (size === undefined) return { error: "The record's root is not a prefix of this group's member history" };
  return { groupId, size, minSize: view.minSize };
}

/** L0: the prepared bytes hash to the digest. */
export function checkContent(bytes: Uint8Array, digest: Hex): Layer {
  return checkContentHash(bytes, digest)
    ? { ok: true, reason: "Prepared bytes hash to the recorded digest" }
    : { ok: false, reason: "Prepared bytes do not hash to the recorded digest" };
}
