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
import { zeroDropAbi } from "./adapter";
import { loadGroups, readClient, readClients, requireDeployment } from "./chain";

/** `tone` "mock" is the neutral/amber state for a mock proof: not a pass, not a failure. */
export type Layer = { ok: boolean; tone?: "mock"; pending?: boolean; reason: string };

export type DisclosureReading = {
  l1: InclusionResult;
  l2?: Layer;
  /** "Posted by k of N": k is the one-of-N statement, N is the group size at the record's root. */
  anonymity?: { groupId: bigint; size: number; minSize: number } | { error: string };
};

/** How many RPC endpoints L1 will compare, for the "trust" sentence in the reader. */
export function l1Endpoints(): number {
  return readClients("reader").length;
}

/** L1: the record and its Disclosed log agree across the configured endpoints. Not an eth_getProof check. */
export async function checkInclusion(cidDigest: Hex): Promise<InclusionResult> {
  const d = requireDeployment();
  const clients = readClients("reader");
  return verifyInclusion({
    publicClients: clients,
    zeroDropAddress: d.zeroDrop,
    cidDigest,
    quorum: clients.length >= 2 ? 2 : "single-endpoint",
    expectedChainId: d.chainId,
  });
}

/**
 * L2: re-verify the Groth16 proof from the Disclosed log, bound to the record's digest, group and case.
 * On a MOCK deployment there is nothing to verify: the answer is the neutral "Mock proof" state, never a pass.
 */
export async function checkProof(cidDigest: Hex, l1: InclusionResult): Promise<Layer> {
  const d = requireDeployment();
  if (d.verifierKind === "mock") {
    return {
      ok: false,
      tone: "mock",
      reason: "Mock proof — not verified. This deployment uses a mock verifier that accepts any proof, so nothing shows that a group member posted this.",
    };
  }
  if (!l1.ok || l1.groupId === undefined || l1.caseId === undefined || l1.root === undefined || l1.nullifier === undefined || l1.depth === undefined || l1.blockNumber === undefined) {
    return { ok: false, reason: "L1 did not produce a record to check" };
  }
  const logs = await readClient("reader").getContractEvents({
    address: d.zeroDrop,
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
  const groups = await loadGroups(readClient("reader"));
  const view = groups.find((g) => g.groupId === groupId);
  if (!view) return { error: "The group for this record was not found in the chain logs" };
  const size = sizeAtRoot(view.commitments, root);
  if (size === undefined) return { error: "The record's root is not a prefix of this group's member history" };
  return { groupId, size, minSize: view.minSize };
}

/** L0: the bytes hash to the digest. */
export function checkContent(bytes: Uint8Array, digest: Hex): Layer {
  return checkContentHash(bytes, digest)
    ? { ok: true, reason: "sha256 of the document equals the recorded digest" }
    : { ok: false, reason: "The bytes do not hash to the recorded digest" };
}
