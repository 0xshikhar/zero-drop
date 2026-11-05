export type ProofMode = "mock" | "semaphore";

// Intentionally remains mock until the Semaphore flow is integrated end to end.
export const PROOF_MODE: ProofMode = "mock";

export function proofStatus() {
  return PROOF_MODE === "mock"
    ? { label: "Mock proof", verified: false as const }
    : { label: "Semaphore proof", verified: true as const };
}
