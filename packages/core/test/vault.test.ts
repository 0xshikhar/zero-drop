import { describe, expect, it } from "vitest";
import { commitment, createIdentity, serializeIdentity } from "../src/identity";
import {
  clearStoredIdentity,
  CorruptVaultError,
  createDefaultStore,
  createMemoryStore,
  hasStoredIdentity,
  IDENTITY_ENCRYPTED_KEY,
  loadIdentityEncrypted,
  migrateToEncrypted,
  saveIdentityEncrypted,
  storedIdentityKind,
  WrongPassphraseError,
} from "../src/vault";

const PASS = "correct horse battery";
const ITER = 100_000; // the minimum the envelope accepts; keeps tests fast

function setup() {
  const store = createMemoryStore();
  return { store, options: { store, iterations: ITER } };
}

describe("identity vault", () => {
  it("roundtrips an identity through the encrypted record", async () => {
    const { options, store } = setup();
    const id = createIdentity();
    expect(await storedIdentityKind(options)).toBe("none");
    expect(await hasStoredIdentity(options)).toBe(false);
    expect(await loadIdentityEncrypted(PASS, options)).toBeUndefined();

    await saveIdentityEncrypted(id, PASS, options);
    expect(await storedIdentityKind(options)).toBe("encrypted");
    expect(await hasStoredIdentity(options)).toBe(true);
    const back = await loadIdentityEncrypted(PASS, options);
    expect(back && commitment(back)).toBe(commitment(id));
    expect(Object.keys(store.dump())).toEqual([IDENTITY_ENCRYPTED_KEY]);
  });

  it("stores no plaintext secret", async () => {
    const { options, store } = setup();
    const id = createIdentity();
    await saveIdentityEncrypted(id, PASS, options);
    const stored = JSON.stringify(store.dump());
    const secret = serializeIdentity(id);
    expect(stored).not.toContain(secret);
    expect(stored).not.toContain(id.secretScalar.toString());
    expect(stored).not.toContain(PASS);
    // Also not as raw bytes of the base64 key decoded.
    expect(stored).not.toContain(Buffer.from(secret, "base64").toString("latin1"));
  });

  it("wrong passphrase throws a clear error and leaves the record intact", async () => {
    const { options } = setup();
    const id = createIdentity();
    await saveIdentityEncrypted(id, PASS, options);
    await expect(loadIdentityEncrypted("wrong horse battery", options)).rejects.toBeInstanceOf(WrongPassphraseError);
    await expect(loadIdentityEncrypted("wrong horse battery", options)).rejects.toThrow("Wrong passphrase");
    const back = await loadIdentityEncrypted(PASS, options);
    expect(back && commitment(back)).toBe(commitment(id));
  });

  it("refuses short passphrases and reports an unreadable record", async () => {
    const { options, store } = setup();
    await expect(saveIdentityEncrypted(createIdentity(), "short", options)).rejects.toThrow(/at least 8/);
    expect(await storedIdentityKind(options)).toBe("none");
    await store.set(IDENTITY_ENCRYPTED_KEY, "{not json");
    await expect(loadIdentityEncrypted(PASS, options)).rejects.toBeInstanceOf(CorruptVaultError);
  });

  it("detects a plain record and migrateToEncrypted re-encrypts it and deletes the plain key", async () => {
    const { options, store } = setup();
    const id = createIdentity();
    await store.set("current", serializeIdentity(id)); // what saveIdentity writes
    expect(await storedIdentityKind(options)).toBe("plain");
    expect(await loadIdentityEncrypted(PASS, options)).toBeUndefined();

    expect(await migrateToEncrypted(PASS, options)).toBe(true);
    expect(await storedIdentityKind(options)).toBe("encrypted");
    expect(await store.get("current")).toBeUndefined();
    expect(JSON.stringify(store.dump())).not.toContain(serializeIdentity(id));
    const back = await loadIdentityEncrypted(PASS, options);
    expect(back && commitment(back)).toBe(commitment(id));

    // Nothing left to migrate.
    expect(await migrateToEncrypted(PASS, options)).toBe(false);
  });

  it("saving encrypted removes a lingering plain record", async () => {
    const { options, store } = setup();
    const id = createIdentity();
    await store.set("current", serializeIdentity(id));
    await saveIdentityEncrypted(id, PASS, options);
    expect(await store.get("current")).toBeUndefined();
    expect(await storedIdentityKind(options)).toBe("encrypted");
  });

  it("migration with an existing encrypted record needs the right passphrase", async () => {
    const { options, store } = setup();
    const id = createIdentity();
    await saveIdentityEncrypted(id, PASS, options);
    await store.set("current", serializeIdentity(id));
    await expect(migrateToEncrypted("wrong horse battery", options)).rejects.toBeInstanceOf(WrongPassphraseError);
    expect(await store.get("current")).toBeDefined();
    expect(await migrateToEncrypted(PASS, options)).toBe(true);
    expect(await store.get("current")).toBeUndefined();
  });

  it("clearStoredIdentity removes both records", async () => {
    const { options, store } = setup();
    await store.set("current", serializeIdentity(createIdentity()));
    await saveIdentityEncrypted(createIdentity(), PASS, options);
    await store.set("current", serializeIdentity(createIdentity()));
    await clearStoredIdentity(options);
    expect(await storedIdentityKind(options)).toBe("none");
    expect(store.dump()).toEqual({});
  });

  it("the default store falls back to memory when IndexedDB is unavailable (node)", async () => {
    const options = { store: createDefaultStore(), iterations: ITER };
    const id = createIdentity();
    await saveIdentityEncrypted(id, PASS, options);
    expect(await storedIdentityKind(options)).toBe("encrypted");
    const back = await loadIdentityEncrypted(PASS, options);
    expect(back && commitment(back)).toBe(commitment(id));
    await clearStoredIdentity(options);
    expect(await hasStoredIdentity(options)).toBe(false);
  });
});
