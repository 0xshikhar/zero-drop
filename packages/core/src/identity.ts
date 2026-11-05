import { Identity } from "@semaphore-protocol/identity";

/** PBKDF2 iteration count used for new exports. Stored in the envelope, so imports follow the file. */
export const IDENTITY_KDF_ITERATIONS = 600_000;
/** Lower bound enforced on import, so a crafted file cannot downgrade the key derivation. */
export const MIN_KDF_ITERATIONS = 100_000;
/** Upper bound enforced on import, so a crafted file cannot stall the browser. */
export const MAX_KDF_ITERATIONS = 10_000_000;
export const MIN_PASSPHRASE_LENGTH = 8;

const ENVELOPE_FORMAT = "zerodrop-identity";
const ENVELOPE_VERSION = 1;
const AAD = new TextEncoder().encode(`${ENVELOPE_FORMAT}/v${ENVELOPE_VERSION}`);

export type EncryptedIdentityEnvelope = {
  format: typeof ENVELOPE_FORMAT;
  version: typeof ENVELOPE_VERSION;
  kdf: { name: "PBKDF2"; hash: "SHA-256"; iterations: number; salt: string };
  cipher: { name: "AES-GCM"; iv: string };
  ciphertext: string;
};

/** Creates a new Semaphore identity with a random EdDSA private key. */
export function createIdentity(): Identity {
  return new Identity();
}

/** Returns the identity private key as base64. This is the secret; treat the output as a credential. */
export function serializeIdentity(identity: Identity): string {
  return identity.export();
}

/** Inverse of serializeIdentity. Throws on malformed input. */
export function deserializeIdentity(serialized: string): Identity {
  if (typeof serialized !== "string" || serialized.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(serialized)) {
    throw new Error("Identity is not valid base64");
  }
  return Identity.import(serialized);
}

/** Semaphore commitment (public identity value) as a bigint. */
export function commitment(identity: Identity): bigint {
  return identity.commitment;
}

/** Semaphore commitment as a 0x-prefixed 32-byte hex string, for QR codes and files. */
export function commitmentHex(identity: Identity): `0x${string}` {
  return `0x${identity.commitment.toString(16).padStart(64, "0")}`;
}

/**
 * Encrypts the identity under a passphrase: PBKDF2-SHA256 derives an AES-256-GCM key.
 * The envelope is JSON, and the format/version string is bound as additional data.
 */
export async function exportIdentity(
  identity: Identity,
  passphrase: string,
  iterations: number = IDENTITY_KDF_ITERATIONS,
): Promise<string> {
  assertPassphrase(passphrase);
  assertIterations(iterations);
  const subtle = getSubtle();
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await deriveKey(passphrase, salt, iterations, ["encrypt"]);
  const plaintext = new TextEncoder().encode(serializeIdentity(identity));
  const ciphertext = new Uint8Array(
    await subtle.encrypt({ name: "AES-GCM", iv, additionalData: AAD }, key, plaintext),
  );
  const envelope: EncryptedIdentityEnvelope = {
    format: ENVELOPE_FORMAT,
    version: ENVELOPE_VERSION,
    kdf: { name: "PBKDF2", hash: "SHA-256", iterations, salt: toBase64(salt) },
    cipher: { name: "AES-GCM", iv: toBase64(iv) },
    ciphertext: toBase64(ciphertext),
  };
  return JSON.stringify(envelope);
}

/**
 * Decrypts an envelope produced by exportIdentity. A wrong passphrase, or any change to the
 * envelope, fails the AES-GCM tag check and throws "Wrong passphrase or corrupted identity file".
 */
export async function importIdentity(envelopeJson: string, passphrase: string): Promise<Identity> {
  assertPassphrase(passphrase);
  const envelope = parseEnvelope(envelopeJson);
  const salt = fromBase64(envelope.kdf.salt);
  const iv = fromBase64(envelope.cipher.iv);
  const ciphertext = fromBase64(envelope.ciphertext);
  if (salt.length !== 16 || iv.length !== 12) throw new Error("Identity file has invalid parameters");

  const key = await deriveKey(passphrase, salt, envelope.kdf.iterations, ["decrypt"]);
  let plaintext: ArrayBuffer;
  try {
    plaintext = await getSubtle().decrypt({ name: "AES-GCM", iv, additionalData: AAD }, key, ciphertext);
  } catch {
    throw new Error("Wrong passphrase or corrupted identity file");
  }
  return deserializeIdentity(new TextDecoder().decode(plaintext));
}

const DB_NAME = "zerodrop";
const STORE = "identity";
const RECORD_KEY = "current";

/**
 * Persists the identity in IndexedDB for this origin. The stored value is the raw private key,
 * unencrypted, so anyone with access to the browser profile can read it. Use exportIdentity for backups.
 * Returns false when IndexedDB is unavailable or the write fails.
 */
export async function saveIdentity(identity: Identity): Promise<boolean> {
  try {
    const db = await openDb();
    if (!db) return false;
    const value = serializeIdentity(identity);
    return await new Promise<boolean>((resolve) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(value, RECORD_KEY);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
      tx.onabort = () => resolve(false);
    }).finally(() => db.close());
  } catch {
    return false;
  }
}

/** Loads the identity saved by saveIdentity. Returns undefined when nothing is stored or access fails. */
export async function loadIdentity(): Promise<Identity | undefined> {
  try {
    const db = await openDb();
    if (!db) return undefined;
    const value = await new Promise<unknown>((resolve) => {
      const request = db.transaction(STORE, "readonly").objectStore(STORE).get(RECORD_KEY);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(undefined);
    }).finally(() => db.close());
    if (typeof value !== "string") return undefined;
    return deserializeIdentity(value);
  } catch {
    return undefined;
  }
}

function openDb(): Promise<IDBDatabase | undefined> {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === "undefined" || !indexedDB) return resolve(undefined);
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(undefined);
      request.onblocked = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  });
}

function getSubtle(): SubtleCrypto {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("WebCrypto is not available in this environment");
  return subtle;
}

function randomBytes(length: number): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(length));
}

async function deriveKey(passphrase: string, salt: Uint8Array, iterations: number, usages: KeyUsage[]): Promise<CryptoKey> {
  const subtle = getSubtle();
  const material = await subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return subtle.deriveKey(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    usages,
  );
}

function parseEnvelope(json: string): EncryptedIdentityEnvelope {
  let envelope: EncryptedIdentityEnvelope;
  try {
    envelope = JSON.parse(json);
  } catch {
    throw new Error("Identity file is not valid JSON");
  }
  if (
    envelope?.format !== ENVELOPE_FORMAT ||
    envelope.version !== ENVELOPE_VERSION ||
    envelope.kdf?.name !== "PBKDF2" ||
    envelope.kdf.hash !== "SHA-256" ||
    envelope.cipher?.name !== "AES-GCM" ||
    typeof envelope.kdf.salt !== "string" ||
    typeof envelope.cipher.iv !== "string" ||
    typeof envelope.ciphertext !== "string"
  ) {
    throw new Error("Unsupported identity file format");
  }
  assertIterations(envelope.kdf.iterations);
  return envelope;
}

function assertPassphrase(passphrase: string) {
  if (typeof passphrase !== "string" || passphrase.length < MIN_PASSPHRASE_LENGTH) {
    throw new Error(`Passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters`);
  }
}

function assertIterations(iterations: number) {
  if (!Number.isInteger(iterations) || iterations < MIN_KDF_ITERATIONS || iterations > MAX_KDF_ITERATIONS) {
    throw new Error(`KDF iterations must be an integer between ${MIN_KDF_ITERATIONS} and ${MAX_KDF_ITERATIONS}`);
  }
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error("Identity file contains invalid base64");
  return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
}
