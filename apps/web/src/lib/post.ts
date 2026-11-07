/**
 * The posting pipeline. One function, `runPost`, walks the timeline steps in order and reports each real state
 * change through `onUpdate`. Nothing is marked done before the thing it names has happened.
 *
 * Steps: pinned (already done when this starts), delay, proving, simulate (frame only), submitted, mined/admitted.
 * - Proof: "mock" deployments use proveDisclosureMock (proves NOTHING); "semaphore" deployments use the real
 *   proveDisclosure, which needs circuit artifacts (the guard below blocks when they are not installed).
 * - Transport "direct": ZeroDrop.record from the key the user pastes (in memory only). The poster address is visible.
 * - Transport "frame": EIP-8141 frame transaction to the sidecars. NOT VERIFIED against a devnet.
 */
import {
  buildDisclosureFrameTx,
  proveDisclosure,
  proveDisclosureMock,
  randomDelayMs,
  runDelayed,
  simulateDisclosureFrameTx,
  submitDisclosureFrameTx,
  verifyDisclosureProof,
  waitForFrameTransaction,
  type DisclosureProof,
  type Settings,
} from "@zerodrop/core";
import { privateKeyToAccount } from "viem/accounts";
import type { Address, Hex } from "viem";
import { ARTIFACTS_MISSING_MESSAGE, hasArtifacts, loadBundledArtifacts } from "./artifacts";
import type { Deployment } from "./config";
import { zeroDropAbi } from "./adapter";
import { readClient, walletFor, type GroupView } from "./chain";
import type { TransportChoice } from "./prefs";
import type { Identity } from "./session";
import { errorMessage } from "./util";

export type StepStatus = "pending" | "active" | "done" | "error" | "skipped" | "cancelled";
export type StepId = "pinned" | "delay" | "proving" | "simulate" | "submitted" | "mined";

export type SidecarState = {
  url: string;
  /** Result of the submission to this sidecar. */
  submit: "pending" | "accepted" | "rejected";
  /** Latest status the sidecar reported while polling, as text. */
  status?: string;
  error?: string;
};

export type TimelineStep = { id: StepId; label: string; status: StepStatus; detail?: string; sidecars?: SidecarState[] };

export class PostCancelled extends Error {
  override name = "PostCancelled";
  constructor() {
    super("Posting was cancelled during the random delay. Nothing was sent to the chain.");
  }
}

export function initialSteps(transport: TransportChoice, pinnedDetail?: string): TimelineStep[] {
  const steps: TimelineStep[] = [
    { id: "pinned", label: "Document pinned", status: pinnedDetail ? "done" : "pending", detail: pinnedDetail },
    { id: "delay", label: "Random delay", status: "pending" },
    { id: "proving", label: "Proof", status: "pending" },
  ];
  if (transport === "frame") steps.push({ id: "simulate", label: "Simulated by the sidecar (unverified)", status: "pending" });
  steps.push({ id: "submitted", label: transport === "frame" ? "Submitted to sidecars (unverified)" : "Transaction sent", status: "pending" });
  steps.push({ id: "mined", label: transport === "frame" ? "Admitted and mined (unverified)" : "Mined", status: "pending" });
  return steps;
}

// ---------------------------------------------------------------------------------------------------
// What can be done on this deployment
// ---------------------------------------------------------------------------------------------------

export type FrameAvailability = { ok: true; sidecars: string[] } | { ok: false; reason: string };

/** The frame path needs a devnet deployment and at least one sidecar. Otherwise it says exactly what is missing. */
export function frameAvailability(deployment: Deployment | undefined, settings: Pick<Settings, "sidecarUrls" | "singleSidecar">): FrameAvailability {
  if (!deployment) return { ok: false, reason: "No deployment is selected." };
  if (deployment.local) {
    return {
      ok: false,
      reason: `${deployment.label} is a local anvil chain, which has no EIP-8141 frame mempool. The frame path needs a devnet deployment; config/devnet.json has no ZeroDrop address yet.`,
    };
  }
  const sidecars = settings.sidecarUrls.length > 0 ? settings.sidecarUrls : deployment.sidecarUrls;
  if (sidecars.length === 0) return { ok: false, reason: "No sidecar URLs are configured. Add them in Settings (or sidecarUrls in the deployment's config file)." };
  return { ok: true, sidecars: settings.singleSidecar ? sidecars.slice(0, 1) : sidecars };
}

/** Why posting is blocked on this deployment, if it is. */
export function proofBlocker(deployment: Deployment, depth: number): string | undefined {
  if (deployment.verifierKind === "semaphore" && !hasArtifacts(depth)) {
    return `${ARTIFACTS_MISSING_MESSAGE}. Posting to a Semaphore deployment is blocked until the depth ${depth} files are in apps/web/public/zk/. The mock deployment works without them.`;
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------------
// runPost
// ---------------------------------------------------------------------------------------------------

export type PostInput = {
  deployment: Deployment & { zeroDrop: Address };
  transport: TransportChoice;
  settings: Settings;
  identity: Identity;
  view: GroupView;
  caseId: Hex;
  cidDigest: Hex;
  /** Throwaway dev key, direct transport only. Used in memory and never stored. */
  anvilKey?: Hex;
  pinnedDetail: string;
  signal: AbortSignal;
  onUpdate: (steps: TimelineStep[]) => void;
};

export type PostOutcome = {
  txHash: Hex;
  blockNumber: bigint;
  proof: DisclosureProof;
  transport: TransportChoice;
};

export async function runPost(input: PostInput): Promise<PostOutcome> {
  const { deployment, transport, settings, identity, view, caseId, cidDigest, signal } = input;
  const steps = initialSteps(transport, input.pinnedDetail);
  const emit = () => input.onUpdate(steps.map((s) => ({ ...s, sidecars: s.sidecars?.map((c) => ({ ...c })) })));
  const set = (id: StepId, patch: Partial<TimelineStep>) => {
    Object.assign(steps.find((s) => s.id === id)!, patch);
    emit();
  };
  const fail = (id: StepId, message: string): never => {
    set(id, { status: "error", detail: message });
    throw new Error(message);
  };
  emit();

  // Delay -------------------------------------------------------------------------------------------
  const delayMs = randomDelayMs(settings);
  if (delayMs === 0) {
    set("delay", { status: "skipped", detail: settings.skipRandomDelay ? "Skipped (Settings: skip the random delay). Posting time stays close to when you joined or opened the app." : "Delay is 0 minutes" });
  } else {
    set("delay", { status: "active", detail: `${Math.ceil(delayMs / 1000)} s` });
    try {
      await runDelayed({
        delayMs,
        signal,
        onTick: (left) => set("delay", { status: "active", detail: `${Math.ceil(left / 1000)} s left of ${Math.ceil(delayMs / 1000)} s. Cancel to stop.` }),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        set("delay", { status: "cancelled", detail: "Cancelled by you. Nothing was sent." });
        throw new PostCancelled();
      }
      throw error;
    }
    set("delay", { status: "done", detail: `Waited ${Math.ceil(delayMs / 1000)} s` });
  }

  // Proof -------------------------------------------------------------------------------------------
  set("proving", { status: "active" });
  const mock = deployment.verifierKind === "mock";
  const blocker = proofBlocker(deployment, view.depth);
  if (blocker) fail("proving", blocker);
  let proof: DisclosureProof;
  try {
    if (mock) {
      proof = await proveDisclosureMock({ identity, group: view.group, groupId: view.groupId, caseId, cidDigest, depth: view.depth });
    } else {
      const artifacts = await loadBundledArtifacts(view.depth);
      if (!artifacts) return fail("proving", ARTIFACTS_MISSING_MESSAGE);
      proof = await proveDisclosure({ identity, group: view.group, groupId: view.groupId, caseId, cidDigest, depth: view.depth, artifacts });
    }
  } catch (error) {
    return fail("proving", errorMessage(error));
  }
  if (view.chainRoot !== proof.root) fail("proving", "The proof's root is not the root the chain last published for this group");
  if (mock) {
    set("proving", { status: "done", detail: "MOCK proof: it proves no membership. Depth " + proof.depth + ", root " + proof.root.toString(16).slice(0, 12) + "…" });
  } else {
    const ok = await verifyDisclosureProof({
      proofBytes: proof.proofBytes,
      root: proof.root,
      nullifier: proof.nullifier,
      depth: proof.depth,
      messageHash: proof.messageHash,
      scopeHash: proof.scopeHash,
    });
    if (!ok) fail("proving", "Local proof check failed");
    set("proving", { status: "done", detail: `Groth16 (BN254) proof generated and verified locally. Depth ${proof.depth}, root ${proof.root.toString(16).slice(0, 12)}…. On-chain: SemaphoreVerifierAdapter → ISemaphoreVerifier (locked on Sepolia).` });
  }

  const args7 = [view.groupId, caseId, cidDigest, proof.root, proof.nullifier, BigInt(proof.depth), proof.proofBytes] as const;
  const client = readClient("source");

  // ---- direct ---------------------------------------------------------------------------------------
  if (transport === "direct") {
    if (!input.anvilKey) return fail("submitted", "No dev key was given.");
    const account = privateKeyToAccount(input.anvilKey);
    set("submitted", { status: "active", detail: "Simulating, then sending" });
    try {
      await client.simulateContract({ account: account.address, address: deployment.zeroDrop, abi: zeroDropAbi, functionName: "record", args: args7 });
    } catch (error) {
      return fail("submitted", `The contract would reject this disclosure: ${errorMessage(error)}`);
    }
    let txHash: Hex;
    try {
      txHash = await walletFor(account).writeContract({ address: deployment.zeroDrop, abi: zeroDropAbi, functionName: "record", args: args7 });
    } catch (error) {
      return fail("submitted", `Sending failed: ${errorMessage(error)}`);
    }
    set("submitted", { status: "done", detail: `Hash ${txHash}. Sent from ${account.address}: the poster address is visible on chain.` });
    set("mined", { status: "active" });
    const receipt = await client.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") return fail("mined", `Transaction reverted (${txHash})`);
    set("mined", { status: "done", detail: `Block ${receipt.blockNumber}` });
    return { txHash, blockNumber: receipt.blockNumber, proof, transport };
  }

  // ---- frame (UNVERIFIED) ----------------------------------------------------------------------------
  const availability = frameAvailability(deployment, settings);
  if (!availability.ok) return fail("submitted", availability.reason);
  const sidecars = availability.sidecars;
  const built = buildDisclosureFrameTx({
    chainId: deployment.chainId,
    zeroDrop: deployment.zeroDrop,
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

  set("simulate", { status: "active", detail: `Asking ${sidecars[0]}` });
  try {
    await simulateDisclosureFrameTx({ url: sidecars[0]!, tx: built.tx, role: "source", session: "post" });
  } catch (error) {
    return fail("simulate", `Simulation failed: ${errorMessage(error)}`);
  }
  set("simulate", { status: "done", detail: "The sidecar's simulation did not return an error. Not verified against a real devnet." });

  const states: SidecarState[] = sidecars.map((url) => ({ url, submit: "pending" }));
  set("submitted", { status: "active", sidecars: states, detail: `Fan-out to ${sidecars.length} sidecar${sidecars.length === 1 ? "" : "s"}` });
  const submitted = await submitDisclosureFrameTx({ tx: built.tx, mempoolUrls: sidecars, role: "source", session: "post" });
  for (const r of submitted.results) {
    const state = states.find((s) => s.url === r.url)!;
    state.submit = r.ok ? "accepted" : "rejected";
    if (!r.ok) state.error = r.error;
  }
  if (!submitted.accepted) {
    set("submitted", { status: "error", sidecars: states, detail: "Every sidecar rejected the transaction." });
    throw new Error("Every sidecar rejected the transaction.");
  }
  set("submitted", { status: "done", sidecars: states, detail: `Frame transaction ${built.txHash}` });

  set("mined", { status: "active", sidecars: states });
  const waited = await waitForFrameTransaction({
    txHash: built.txHash,
    mempoolUrls: sidecars,
    signal,
    role: "source",
    session: "post",
    onUpdate: (results) => {
      for (const r of results) {
        const state = states.find((s) => s.url === r.url);
        if (!state) continue;
        state.status = r.ok ? JSON.stringify(r.status) : undefined;
        state.error = r.ok ? state.error : r.error;
      }
      set("mined", { status: "active", sidecars: states });
    },
  });
  if (!waited.terminal) return fail("mined", "No sidecar reported the transaction on chain before the deadline. It may still land; check the reader link later.");
  const text = JSON.stringify(waited.results.map((r) => r.status ?? null)).toLowerCase();
  if (text.includes("reverted")) return fail("mined", "A sidecar reported the frame transaction as reverted.");
  // The block number is read from the record itself, not guessed from sidecar replies.
  let blockNumber = 0n;
  try {
    const rec = (await client.readContract({ address: deployment.zeroDrop, abi: zeroDropAbi, functionName: "records", args: [cidDigest] })) as readonly [bigint, Hex, bigint, bigint, bigint, boolean];
    blockNumber = BigInt(rec[4]);
  } catch {
    // reported below as unknown
  }
  set("mined", { status: "done", sidecars: states, detail: blockNumber > 0n ? `Block ${blockNumber}` : "Reported on chain by a sidecar; block number not read" });
  return { txHash: built.txHash, blockNumber, proof, transport };
}
