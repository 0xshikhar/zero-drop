/**
 * What this build actually does. The UI shows these labels, so each one must stay true.
 */
export type ProofMode = "mock" | "semaphore";
/**
 * "semaphore": real Semaphore proofs are generated and verified on the local chain (anvil, 31337).
 * "mock" is kept only for tests and for disclosures that must never claim verification.
 */
export const PROOF_MODE: ProofMode = "semaphore";

export type TransportMode = "direct" | "frame";
/**
 * "direct": one ordinary transaction from the poster's address. The poster address is visible on chain.
 * "frame": EIP-8141 frame transaction, which hides the payer. NOT verified against the devnet yet.
 */
export const TRANSPORT_MODE: TransportMode = "direct";

export const PROOF_LABELS: Record<ProofMode, string> = {
  mock: "Mock proof (no membership check)",
  semaphore: "Semaphore proof (real, on a local chain)",
};

export const TRANSPORT_LABELS: Record<TransportMode, string> = {
  direct: "Direct transaction: poster address visible on chain",
  frame: "Frame transaction (EIP-8141): not yet verified against the devnet",
};

/** Anon-RPC is not integrated in this build, so every request leaves the machine directly. */
export const ANON_NETWORK_LABEL = "Anon-RPC not integrated";

export function statusLabels(): { proof: string; transport: string; anonNetwork: string } {
  return {
    proof: PROOF_LABELS[PROOF_MODE],
    transport: TRANSPORT_LABELS[TRANSPORT_MODE],
    anonNetwork: ANON_NETWORK_LABEL,
  };
}

/**
 * `verified` is true only when proofs are real. Even then it means "checked on the local chain", not
 * "checked on the devnet", and not "the poster is anonymous" (the transport label covers that).
 */
export function proofStatus() {
  return {
    label: PROOF_LABELS[PROOF_MODE],
    verified: PROOF_MODE === "semaphore",
  };
}
