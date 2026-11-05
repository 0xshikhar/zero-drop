import { describe, expect, it } from "vitest";
import {
  BundleError, createBundle, parseBundle, serializeBundle, verifyBundleOffline, type CreateBundleInput, type ProofBundle,
} from "../src/bundle";
import { cidFor, digestOf } from "../src/content";
import { messageOf, scopeOf } from "../src/prove";

const bytes = new TextEncoder().encode("# Disclosure\nline two\n");
const cid = cidFor(bytes);
const caseId = `0x${"ab".repeat(32)}` as const;
const proofBytes = `0x${"11".repeat(256)}` as const;

function input(over: Partial<CreateBundleInput> = {}): CreateBundleInput {
  return {
    chainId: 31337,
    contract: `0x${"22".repeat(20)}`,
    txHash: `0x${"33".repeat(32)}`,
    blockNumber: 12n,
    groupId: 1n,
    caseId,
    root: 2n ** 200n + 5n,
    nullifier: 2n ** 250n,
    depth: 20,
    proofBytes,
    proofMode: "semaphore",
    cid,
    mediaType: "text/markdown",
    bytes,
    createdAt: new Date("2026-11-06T10:00:00Z"),
    ...over,
  };
}

const tamper = (b: ProofBundle, patch: Record<string, unknown>) => JSON.stringify({ ...b, ...patch });

describe("bundle", () => {
  it("round-trips through serialize and parse, with big numbers as decimal strings", () => {
    const bundle = createBundle(input());
    expect(bundle.digest).toBe(digestOf(bytes));
    expect(bundle.root).toBe((2n ** 200n + 5n).toString());
    const text = serializeBundle(bundle);
    expect(JSON.parse(text).version).toBe(1);
    expect(parseBundle(text)).toEqual(bundle);
    expect(parseBundle(JSON.parse(text))).toEqual(bundle);
  });

  it("works without an embedded document", () => {
    const bundle = createBundle(input({ bytes: undefined }));
    expect(bundle.bytesBase64).toBeUndefined();
    expect(parseBundle(serializeBundle(bundle))).toEqual(bundle);
  });

  it("createBundle refuses bytes that do not match the cid, and bad cids", () => {
    expect(() => createBundle(input({ bytes: new Uint8Array([1]) }))).toThrow(/do not match/);
    expect(() => createBundle(input({ cid: "nope" }))).toThrow(BundleError);
    expect(() => createBundle(input({ root: "0x10" }))).toThrow(/decimal/);
  });

  it("parseBundle rejects malformed or tampered documents with clear errors", () => {
    const b = createBundle(input());
    expect(() => parseBundle("{nope")).toThrow(/not valid JSON/);
    expect(() => parseBundle("[]")).toThrow(/object/);
    expect(() => parseBundle(tamper(b, { version: 2 }))).toThrow(/Unsupported bundle version 2/);
    expect(() => parseBundle(tamper(b, { version: undefined }))).toThrow(/Unsupported bundle version/);
    expect(() => parseBundle(tamper(b, { txHash: "0x12" }))).toThrow(/txHash must be 32 bytes/);
    expect(() => parseBundle(tamper(b, { caseId: `0x${"zz".repeat(32)}` }))).toThrow(/caseId must be 0x-prefixed hex/);
    expect(() => parseBundle(tamper(b, { contract: `0x${"2".repeat(41)}` }))).toThrow(/contract/);
    expect(() => parseBundle(tamper(b, { digest: `0x${"00".repeat(32)}` }))).toThrow(/digest does not match/);
    expect(() => parseBundle(tamper(b, { cid: cidFor(new Uint8Array([5])) }))).toThrow(/digest does not match/);
    expect(() => parseBundle(tamper(b, { cid: "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi" }))).toThrow(/cid/);
    expect(() => parseBundle(tamper(b, { proofMode: "real" }))).toThrow(/proofMode/);
    expect(() => parseBundle(tamper(b, { proofBytes: "0x1234" }))).toThrow(/256 bytes/);
    expect(() => parseBundle(tamper(b, { depth: 0 }))).toThrow(/depth/);
    expect(() => parseBundle(tamper(b, { root: "-1" }))).toThrow(/root/);
    expect(() => parseBundle(tamper(b, { root: 5 }))).toThrow(/decimal string/);
    expect(() => parseBundle(tamper(b, { mediaType: "application/pdf" }))).toThrow(/mediaType/);
    expect(() => parseBundle(tamper(b, { createdAt: "yesterday" }))).toThrow(/createdAt/);
    expect(() => parseBundle(tamper(b, { bytesBase64: "!!!" }))).toThrow(/base64/);
    expect(() => parseBundle(tamper(b, { extra: 1 }))).toThrow(/Unknown field "extra"/);
  });

  it("L0 verifies the embedded document and fails when the bytes are swapped", async () => {
    const b = createBundle(input());
    const ok = await verifyBundleOffline(b);
    expect(ok.l0.status).toBe("verified");
    expect(ok.ok).toBe(true);

    // Same shape, different document: parse still passes (it is valid base64), L0 must catch it.
    const swapped = parseBundle(tamper(b, { bytesBase64: Buffer.from("forged").toString("base64") }));
    const bad = await verifyBundleOffline(swapped);
    expect(bad.l0.status).toBe("failed");
    expect(bad.ok).toBe(false);
  });

  it("L0 is unchecked when no document is embedded", async () => {
    const result = await verifyBundleOffline(createBundle(input({ bytes: undefined })));
    expect(result.l0.status).toBe("unchecked");
    expect(result.ok).toBe(true);
    expect(result.notes.join(" ")).toMatch(/L1/);
  });

  it("mock proofs are reported as mock, never verified, even with a verifier that says true", async () => {
    let called = false;
    const b = createBundle(input({ proofMode: "mock", proofBytes: "0x1234" }));
    const result = await verifyBundleOffline(b, { verifyProof: () => ((called = true), true) });
    expect(result.l2.status).toBe("mock");
    expect(called).toBe(false);
    expect((await verifyBundleOffline(b)).l2.status).toBe("mock");
  });

  it("semaphore: L2 needs an injected verifier and passes it the bound message and scope", async () => {
    const b = createBundle(input());
    expect((await verifyBundleOffline(b)).l2.status).toBe("unchecked");

    let seen: unknown;
    const verified = await verifyBundleOffline(b, { verifyProof: (i) => ((seen = i), true) });
    expect(verified.l2.status).toBe("verified");
    expect(seen).toEqual({
      proofBytes,
      root: 2n ** 200n + 5n,
      nullifier: 2n ** 250n,
      depth: 20,
      messageHash: messageOf(b.digest, 1n, caseId),
      scopeHash: scopeOf(caseId),
    });

    const rejected = await verifyBundleOffline(b, { verifyProof: async () => false });
    expect(rejected.l2.status).toBe("failed");
    expect(rejected.ok).toBe(false);

    const threw = await verifyBundleOffline(b, { verifyProof: () => { throw new Error("vkey missing"); } });
    expect(threw.l2).toEqual({ status: "failed", reason: "vkey missing" });
  });
});
