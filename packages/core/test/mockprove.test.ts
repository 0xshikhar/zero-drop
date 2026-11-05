import { describe, expect, it } from "vitest";
import { digestOf } from "../src/content";
import { buildGroup } from "../src/group";
import { createIdentity } from "../src/identity";
import { MOCK_PROOF_BYTES, mockNullifier, proveDisclosureMock } from "../src/mockprove";
import { messageOf, scopeOf, SNARK_SCALAR_FIELD } from "../src/prove";

const CASE_A = `0x${"11".repeat(32)}` as const;
const CASE_B = `0x${"22".repeat(32)}` as const;
const DIGEST = digestOf(new TextEncoder().encode("a document"));

describe("proveDisclosureMock", () => {
  const me = createIdentity();
  const others = [createIdentity(), createIdentity(), createIdentity()];
  const snapshot = buildGroup([me.commitment, ...others.map((i) => i.commitment)]);

  it("has the same shape as proveDisclosure, with the group's real root and depth", async () => {
    const proof = await proveDisclosureMock({ identity: me, group: snapshot.group, groupId: 1n, caseId: CASE_A, cidDigest: DIGEST });
    expect(proof.root).toBe(snapshot.root);
    expect(proof.depth).toBe(Math.max(1, snapshot.group.depth));
    expect(proof.messageHash).toBe(messageOf(DIGEST, 1n, CASE_A));
    expect(proof.scopeHash).toBe(scopeOf(CASE_A));
    expect(proof.proofBytes).toBe(MOCK_PROOF_BYTES);
    expect(proof.proofBytes).toMatch(/^0x(00){256}$/);
    expect(proof.publicInputs).toHaveLength(4);
    expect(Object.keys(proof).sort()).toEqual(["depth", "messageHash", "nullifier", "proofBytes", "publicInputs", "root", "scopeHash"]);
  });

  it("nullifier is nonzero, below the field, stable per (identity, case)", async () => {
    const a1 = await proveDisclosureMock({ identity: me, group: snapshot.group, groupId: 1n, caseId: CASE_A, cidDigest: DIGEST });
    const a2 = await proveDisclosureMock({ identity: me, group: snapshot.group, groupId: 1n, caseId: CASE_A, cidDigest: digestOf(new Uint8Array([9])) });
    expect(a1.nullifier).toBeGreaterThan(0n);
    expect(a1.nullifier).toBeLessThan(SNARK_SCALAR_FIELD);
    expect(a2.nullifier).toBe(a1.nullifier);
    expect(mockNullifier(me, CASE_A)).toBe(a1.nullifier);
  });

  it("a different case or a different identity gives a different nullifier", async () => {
    const a = await proveDisclosureMock({ identity: me, group: snapshot.group, groupId: 1n, caseId: CASE_A, cidDigest: DIGEST });
    const b = await proveDisclosureMock({ identity: me, group: snapshot.group, groupId: 1n, caseId: CASE_B, cidDigest: DIGEST });
    expect(b.nullifier).not.toBe(a.nullifier);
    expect(mockNullifier(others[0]!, CASE_A)).not.toBe(a.nullifier);
  });

  it("refuses an identity that is not in the group", async () => {
    await expect(
      proveDisclosureMock({ identity: createIdentity(), group: snapshot.group, groupId: 1n, caseId: CASE_A, cidDigest: DIGEST }),
    ).rejects.toThrow(/not a member/);
  });
});
