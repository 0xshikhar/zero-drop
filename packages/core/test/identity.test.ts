import { describe, expect, it } from "vitest";
import {
  commitment,
  commitmentHex,
  createIdentity,
  deserializeIdentity,
  exportIdentity,
  importIdentity,
  IDENTITY_DB_NAME,
  IDENTITY_PLAIN_KEY,
  IDENTITY_STORE,
  loadIdentity,
  saveIdentity,
  serializeIdentity,
} from "../src/identity";

describe("identity", () => {
  it("serialize/deserialize keeps the commitment", () => {
    const id = createIdentity();
    const copy = deserializeIdentity(serializeIdentity(id));
    expect(commitment(copy)).toBe(commitment(id));
    expect(copy.secretScalar).toBe(id.secretScalar);
  });

  it("rejects malformed serialized identities", () => {
    expect(() => deserializeIdentity("not base64!")).toThrow();
    expect(() => deserializeIdentity("")).toThrow();
  });

  it("encrypted export/import roundtrips with the right passphrase", async () => {
    const id = createIdentity();
    const file = await exportIdentity(id, "correct horse battery");
    expect(file).not.toContain(serializeIdentity(id));
    const back = await importIdentity(file, "correct horse battery");
    expect(commitment(back)).toBe(commitment(id));
  }, 30_000);

  it("wrong passphrase fails", async () => {
    const file = await exportIdentity(createIdentity(), "correct horse battery");
    await expect(importIdentity(file, "wrong horse battery")).rejects.toThrow(/Wrong passphrase/);
  }, 30_000);

  it("tampered envelope fails and bad KDF parameters are refused", async () => {
    const file = await exportIdentity(createIdentity(), "correct horse battery");
    const env = JSON.parse(file);
    env.kdf.iterations = 1000;
    await expect(importIdentity(JSON.stringify(env), "correct horse battery")).rejects.toThrow(/iterations/);
    const flipped = JSON.parse(file);
    flipped.ciphertext = flipped.ciphertext.slice(0, -4) + (flipped.ciphertext.endsWith("AAAA") ? "BBBB" : "AAAA");
    await expect(importIdentity(JSON.stringify(flipped), "correct horse battery")).rejects.toThrow();
  }, 30_000);

  it("refuses short passphrases", async () => {
    await expect(exportIdentity(createIdentity(), "short")).rejects.toThrow(/at least 8/);
  });

  it("commitmentHex is 32 bytes and matches the bigint", () => {
    const id = createIdentity();
    const hex = commitmentHex(id);
    expect(hex).toMatch(/^0x[0-9a-f]{64}$/);
    expect(BigInt(hex)).toBe(commitment(id));
  });

  it("IndexedDB helpers degrade gracefully when indexedDB is absent (node)", async () => {
    expect(typeof indexedDB).toBe("undefined");
    expect(await saveIdentity(createIdentity())).toBe(false);
    expect(await loadIdentity()).toBeUndefined();
  });

  it("legacy plain saveIdentity/loadIdentity stay no-ops without IndexedDB, and the plain-record location is exported for the vault", async () => {
    expect(await saveIdentity(createIdentity())).toBe(false);
    expect(await loadIdentity()).toBeUndefined();
    expect([IDENTITY_DB_NAME, IDENTITY_STORE, IDENTITY_PLAIN_KEY]).toEqual(["zerodrop", "identity", "current"]);
  });
});
