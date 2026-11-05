import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildGroup, sizeAtRoot } from "../src/group";
import { commitment, createIdentity } from "../src/identity";
import { artifactNames, messageOf, proveDisclosure, scopeOf, SNARK_SCALAR_FIELD, type SemaphoreArtifacts } from "../src/prove";
import { decodeProofBytes, verifyDisclosureProof } from "../src/verify-proof";
import { digestOf } from "../src/content";

// Circuit artifacts are not bundled in this repo and generateProof would otherwise download them.
// Point SEMAPHORE_ARTIFACTS_DIR at a folder with semaphore-<depth>.wasm and semaphore-<depth>.zkey.
const artifactDir = process.env.SEMAPHORE_ARTIFACTS_DIR ?? "";
const DEPTH = 2;
const names = artifactNames(DEPTH);
const haveArtifacts = artifactDir !== "" && existsSync(join(artifactDir, names.wasm)) && existsSync(join(artifactDir, names.zkey));
const artifacts: SemaphoreArtifacts = { wasm: join(artifactDir, names.wasm), zkey: join(artifactDir, names.zkey) };

const CASE = `0x${"11".repeat(32)}` as const;
const CID_DIGEST = digestOf(new TextEncoder().encode("document bytes"));

describe("bindings", () => {
  it("messageOf and scopeOf are field elements and depend on every input", () => {
    const m = messageOf(CID_DIGEST, 1n, CASE);
    expect(m).toBeGreaterThanOrEqual(0n);
    expect(m).toBeLessThan(SNARK_SCALAR_FIELD);
    expect(messageOf(CID_DIGEST, 2n, CASE)).not.toBe(m);
    expect(messageOf(digestOf(new Uint8Array([1])), 1n, CASE)).not.toBe(m);
    expect(scopeOf(CASE)).toBeLessThan(SNARK_SCALAR_FIELD);
    expect(scopeOf(`0x${"22".repeat(32)}`)).not.toBe(scopeOf(CASE));
  });

  it("malformed proofs verify as false without throwing and without artifacts", async () => {
    const base = { proofBytes: `0x${"00".repeat(256)}` as const, root: 1n, nullifier: 2n, depth: 2, messageHash: 3n, scopeHash: 4n };
    expect(await verifyDisclosureProof(base)).toBe(false);
    expect(await verifyDisclosureProof({ ...base, proofBytes: "0x1234" })).toBe(false);
    expect(await verifyDisclosureProof({ ...base, depth: 0 })).toBe(false);
    expect(await verifyDisclosureProof({ ...base, root: SNARK_SCALAR_FIELD })).toBe(false);
    expect(() => decodeProofBytes("0x1234")).toThrow();
  });
});

describe.skipIf(!haveArtifacts)("prove + verify (needs SEMAPHORE_ARTIFACTS_DIR)", () => {
  it(
    "roundtrips for a 3-member group, binds the root, and rejects tampering",
    async () => {
      const ids = [createIdentity(), createIdentity(), createIdentity()];
      const commitments = ids.map(commitment);
      const { group, root } = buildGroup(commitments);
      const groupId = 7n;

      const started = performance.now();
      const proof = await proveDisclosure({
        identity: ids[1]!,
        group,
        groupId,
        caseId: CASE,
        cidDigest: CID_DIGEST,
        depth: DEPTH,
        artifacts,
      });
      const provingMs = performance.now() - started;
      console.log(`proveDisclosure depth=${DEPTH} members=3: ${provingMs.toFixed(0)} ms`);
      expect(provingMs).toBeLessThan(60_000);

      expect(proof.root).toBe(root);
      expect(sizeAtRoot(commitments, proof.root)).toBe(3);
      expect(proof.proofBytes).toMatch(/^0x[0-9a-f]{512}$/);
      expect(decodeProofBytes(proof.proofBytes)).toHaveLength(8);
      expect(proof.publicInputs).toHaveLength(4);

      const ok = {
        proofBytes: proof.proofBytes,
        root: proof.root,
        nullifier: proof.nullifier,
        depth: proof.depth,
        messageHash: proof.messageHash,
        scopeHash: proof.scopeHash,
      };
      const verifyStarted = performance.now();
      expect(await verifyDisclosureProof(ok)).toBe(true);
      console.log(`verifyDisclosureProof: ${(performance.now() - verifyStarted).toFixed(0)} ms`);

      expect(await verifyDisclosureProof({ ...ok, messageHash: proof.messageHash + 1n })).toBe(false);
      expect(await verifyDisclosureProof({ ...ok, scopeHash: proof.scopeHash + 1n })).toBe(false);
      expect(await verifyDisclosureProof({ ...ok, nullifier: proof.nullifier + 1n })).toBe(false);
      expect(await verifyDisclosureProof({ ...ok, depth: DEPTH + 1 })).toBe(false);
      const flipped = (ok.proofBytes.slice(0, -2) + (ok.proofBytes.endsWith("00") ? "01" : "00")) as `0x${string}`;
      expect(await verifyDisclosureProof({ ...ok, proofBytes: flipped })).toBe(false);
    },
    120_000,
  );

  it("nullifier is stable per identity and case, and differs across cases", async () => {
    const ids = [createIdentity(), createIdentity(), createIdentity()];
    const { group } = buildGroup(ids.map(commitment));
    const base = { identity: ids[0]!, group, groupId: 7n, cidDigest: CID_DIGEST, depth: DEPTH, artifacts };
    const a = await proveDisclosure({ ...base, caseId: CASE });
    const b = await proveDisclosure({ ...base, caseId: CASE });
    const c = await proveDisclosure({ ...base, caseId: `0x${"33".repeat(32)}` });
    expect(a.nullifier).toBe(b.nullifier);
    expect(c.nullifier).not.toBe(a.nullifier);
  }, 120_000);

  it("refuses an identity that is not in the group", async () => {
    const ids = [createIdentity(), createIdentity()];
    const { group } = buildGroup(ids.map(commitment));
    await expect(
      proveDisclosure({ identity: createIdentity(), group, groupId: 1n, caseId: CASE, cidDigest: CID_DIGEST, depth: DEPTH, artifacts }),
    ).rejects.toThrow(/not a member/);
  });
});
