import {
  buildDisclosureFrameTx,
  proveDisclosure,
  submitDisclosureFrameTx,
  verifyDisclosureProof,
  type DisclosureProof,
} from "@zerodrop/core";
import { privateKeyToAccount } from "viem/accounts";
import type { Address, Hex } from "viem";
import { ARTIFACTS_MISSING_MESSAGE, loadBundledArtifacts } from "./artifacts";
import { DEVNET } from "./config";
import { zeroDropAbi } from "./adapter";
import { ZERODROP, readClient, walletFor, type GroupView } from "./chain";
import type { Identity } from "./session";

export type StepStatus = "pending" | "active" | "done" | "error";
export type PostStep = { id: string; label: string; status: StepStatus; detail?: string };

export const DIRECT_STEPS: PostStep[] = [
  { id: "prove", label: "Proof generated in this browser", status: "pending" },
  { id: "check", label: "Proof checked locally", status: "pending" },
  { id: "submit", label: "Transaction sent to the local RPC", status: "pending" },
  { id: "mined", label: "Record mined", status: "pending" },
];

export type PostResult = { txHash: Hex; blockNumber: bigint; proof: DisclosureProof };

/**
 * Direct path: proves, checks locally, simulates, sends ZeroDrop.record from the poster address and waits for the
 * receipt. The poster address is visible on chain. The key is used in memory only.
 */
export async function postDirect(args: {
  identity: Identity;
  view: GroupView;
  caseId: Hex;
  cidDigest: Hex;
  anvilKey: Hex;
  onStep: (steps: PostStep[]) => void;
}): Promise<PostResult> {
  const { identity, view, caseId, cidDigest, anvilKey, onStep } = args;
  const steps = DIRECT_STEPS.map((s) => ({ ...s }));
  const set = (id: string, status: StepStatus, detail?: string) => {
    const step = steps.find((s) => s.id === id)!;
    step.status = status;
    if (detail !== undefined) step.detail = detail;
    onStep(steps.map((s) => ({ ...s })));
  };

  set("prove", "active");
  const artifacts = await loadBundledArtifacts(view.depth);
  if (!artifacts) {
    set("prove", "error", ARTIFACTS_MISSING_MESSAGE);
    throw new Error(ARTIFACTS_MISSING_MESSAGE);
  }
  const proof = await proveDisclosure({
    identity,
    group: view.group,
    groupId: view.groupId,
    caseId,
    cidDigest,
    depth: view.depth,
    artifacts,
  });
  set("prove", "done", `Depth ${proof.depth}, root ${proof.root.toString(16).slice(0, 12)}…`);

  set("check", "active");
  const failCheck = (message: string): never => {
    set("check", "error", message);
    throw new Error(message);
  };
  if (view.chainRoot !== proof.root) failCheck("The proof's root is not the root the chain last published for this group");
  const ok = await verifyDisclosureProof({
    proofBytes: proof.proofBytes,
    root: proof.root,
    nullifier: proof.nullifier,
    depth: proof.depth,
    messageHash: proof.messageHash,
    scopeHash: proof.scopeHash,
  });
  if (!ok) failCheck("Local proof check failed");
  set("check", "done", "Verifies against the group root");

  const account = privateKeyToAccount(anvilKey);
  const args7 = [view.groupId, caseId, cidDigest, proof.root, proof.nullifier, BigInt(proof.depth), proof.proofBytes] as const;
  const client = readClient();

  set("submit", "active");
  try {
    await client.simulateContract({ account: account.address, address: ZERODROP, abi: zeroDropAbi, functionName: "record", args: args7 });
  } catch (error) {
    const message = `The contract would reject this disclosure: ${reason(error)}`;
    set("submit", "error", message);
    throw new Error(message);
  }
  let txHash: Hex;
  try {
    txHash = await walletFor(account).writeContract({ address: ZERODROP, abi: zeroDropAbi, functionName: "record", args: args7 });
  } catch (error) {
    const message = `Sending failed: ${reason(error)}`;
    set("submit", "error", message);
    throw new Error(message);
  }
  set("submit", "done", `Hash ${txHash}`);

  set("mined", "active");
  const receipt = await client.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") {
    const message = `Transaction reverted (${txHash})`;
    set("mined", "error", message);
    throw new Error(message);
  }
  set("mined", "done", `Block ${receipt.blockNumber}`);
  return { txHash, blockNumber: receipt.blockNumber, proof };
}

/** The frame path builds an EIP-8141 transaction and submits it to every configured mempool endpoint. Unverified. */
export async function postFrame(args: {
  identity: Identity;
  view: GroupView;
  caseId: Hex;
  cidDigest: Hex;
}): Promise<{ accepted: boolean; results: Array<{ url: string; ok: boolean; error?: string }> }> {
  const { identity, view, caseId, cidDigest } = args;
  const zeroDrop = DEVNET.contracts.zeroDrop;
  if (!zeroDrop || DEVNET.sidecarUrls.length === 0) {
    throw new Error("Frame path unavailable: config/devnet.json has no ZeroDrop address and no sidecar URLs.");
  }
  const artifacts = await loadBundledArtifacts(view.depth);
  if (!artifacts) throw new Error("Circuit artifacts not installed. See the README");
  const proof = await proveDisclosure({ identity, group: view.group, groupId: view.groupId, caseId, cidDigest, depth: view.depth, artifacts });
  const built = buildDisclosureFrameTx({
    chainId: DEVNET.chainId,
    zeroDrop: zeroDrop as Address,
    groupId: view.groupId,
    caseId,
    cidDigest,
    root: proof.root,
    nullifier: proof.nullifier,
    depth: BigInt(proof.depth),
    proof: proof.proofBytes,
    // Placeholder fee cap for the unverified devnet path. Not tuned against a real devnet.
    maxFeePerGas: 1_000_000_000n,
  });
  const submitted = await submitDisclosureFrameTx({ tx: built.tx, mempoolUrls: DEVNET.sidecarUrls });
  return {
    accepted: submitted.accepted,
    results: submitted.results.map((r) => ({ url: r.url, ok: r.ok, error: r.error })),
  };
}

function reason(error: unknown): string {
  if (error instanceof Error) {
    const short = (error as { shortMessage?: string }).shortMessage;
    return short ?? error.message.split("\n")[0] ?? error.message;
  }
  return String(error);
}
