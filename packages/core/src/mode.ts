/**
 * What this build actually does. The UI shows these labels, so each one must stay true.
 *
 * The labels follow the ACTIVE deployment (verifierKind, directRecordEnabled) and the live network client
 * (mode and boot state). The app calls `setDeploymentInfo` whenever the user picks a deployment; nothing here
 * guesses. Before any call the default is the most cautious reading: a mock verifier, direct posting.
 */
import { network, type NetworkClient } from "./net";

export type ProofMode = "mock" | "semaphore";
export type TransportMode = "direct" | "frame";
export type VerifierKind = ProofMode;

export type DeploymentInfo = {
  /** "mock": MockVerifier, accepts any proof. "semaphore": the Groth16 verifier adapter. */
  verifierKind: VerifierKind;
  /** True when anyone may call ZeroDrop.record directly (local development). */
  directRecordEnabled: boolean;
};

let deployment: DeploymentInfo = { verifierKind: "mock", directRecordEnabled: true };

/** Tells the status labels which deployment is active. */
export function setDeploymentInfo(info: DeploymentInfo): void {
  deployment = { verifierKind: info.verifierKind, directRecordEnabled: info.directRecordEnabled };
}

export function getDeploymentInfo(): DeploymentInfo {
  return { ...deployment };
}

/** The proof mode of the active deployment. */
export function currentProofMode(): ProofMode {
  return deployment.verifierKind;
}

export const PROOF_LABELS: Record<ProofMode, string> = {
  mock: "Mock proof (not a membership proof)",
  semaphore: "Semaphore proof (real, on a local chain)",
};

export const TRANSPORT_LABELS: Record<TransportMode, string> = {
  direct: "Direct transaction: poster address visible",
  frame: "Frame transaction (EIP-8141): not verified against a devnet",
};

/** Label for the network route, from the client's mode and the boot state of its anonymous transport. */
export function anonNetworkLabel(client: NetworkClient = network): string {
  if (client.mode === "direct") return "Not routed (direct)";
  const state = client.bootState;
  switch (state.status) {
    case "ready":
      return "Anon-RPC: ready";
    case "booting":
      return state.percent !== undefined ? `Anon-RPC: booting ${state.percent}%` : "Anon-RPC: booting";
    case "failed":
      return `Anon-RPC: failed: ${state.reason}`;
    default:
      return "Anon-RPC: not started";
  }
}

export type StatusLabelsInput = {
  /** The transport the user chose. Defaults to "direct" when the deployment allows direct records, else "frame". */
  transport?: TransportMode;
  net?: NetworkClient;
};

export function statusLabels(input: StatusLabelsInput = {}): { proof: string; transport: string; anonNetwork: string } {
  const transport = input.transport ?? (deployment.directRecordEnabled ? "direct" : "frame");
  return {
    proof: PROOF_LABELS[deployment.verifierKind],
    transport: TRANSPORT_LABELS[transport],
    anonNetwork: anonNetworkLabel(input.net),
  };
}

/**
 * `verified` is true only when proofs are real. Even then it means "checked on the local chain", not
 * "checked on the devnet", and not "the poster is anonymous" (the transport label covers that).
 */
export function proofStatus() {
  return {
    label: PROOF_LABELS[deployment.verifierKind],
    verified: deployment.verifierKind === "semaphore",
  };
}
