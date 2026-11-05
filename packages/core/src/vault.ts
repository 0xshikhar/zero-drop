import type { Identity } from "@semaphore-protocol/identity";
import {
  IDENTITY_DB_NAME,
  IDENTITY_PLAIN_KEY,
  IDENTITY_STORE,
  commitment,
  deserializeIdentity,
  exportIdentity,
  importIdentity,
  IDENTITY_KDF_ITERATIONS,
} from "./identity";

/**
 * Identity vault: the Semaphore identity encrypted at rest under a passphrase.
 *
 * The record is the same PBKDF2-SHA256 / AES-256-GCM envelope that exportIdentity produces, stored as a
 * JSON string under its own key. The legacy plain record (saveIdentity in identity.ts) is a different
 * key; migrateToEncrypted converts one into the other and deletes the plain key.
 *
 * Limits: the passphrase is the only protection. While the vault is unlocked the identity lives in memory
 * as plain JS values, and an attacker with the passphrase or with code running in this origin gets it.
 */

/** IndexedDB key of the encrypted envelope (JSON string). */
export const IDENTITY_ENCRYPTED_KEY = "current.enc";

export type StoredIdentityKind = "encrypted" | "plain" | "none";

/** The smallest key-value surface the vault needs. IndexedDB is the default; tests inject a memory one. */
export interface IdentityKeyValueStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export type VaultOptions = {
  /** Storage backend. Defaults to IndexedDB with an in-memory fallback when IndexedDB is unavailable or fails. */
  store?: IdentityKeyValueStore;
  /** PBKDF2 iterations for new encrypted records. Defaults to IDENTITY_KDF_ITERATIONS. */
  iterations?: number;
};

/** Thrown when the passphrase does not decrypt the stored identity. */
export class WrongPassphraseError extends Error {
  override name = "WrongPassphraseError";
  constructor() {
    super("Wrong passphrase");
  }
}

/** Thrown when a stored record exists but cannot be parsed as an identity record. */
export class CorruptVaultError extends Error {
  override name = "CorruptVaultError";
}

/** A plain in-memory store. Used as the fallback and in tests. */
export function createMemoryStore(): IdentityKeyValueStore & { dump(): Record<string, unknown> } {
  const map = new Map<string, unknown>();
  return {
    async get(key) {
      return map.get(key);
    },
    async set(key, value) {
      map.set(key, value);
    },
    async delete(key) {
      map.delete(key);
    },
    dump() {
      return Object.fromEntries(map);
    },
  };
}

const fallbackMemory = createMemoryStore();

/**
 * The default store: IndexedDB when it works, otherwise the in-memory fallback (lost on reload).
 * Reads check IndexedDB first and then memory; deletes hit both so no copy lingers.
 */
export function createDefaultStore(): IdentityKeyValueStore {
  return {
    async get(key) {
      try {
        const value = await idbGet(key);
        if (value !== undefined) return value;
      } catch {
        // fall through to memory
      }
      return fallbackMemory.get(key);
    },
    async set(key, value) {
      try {
        await idbSet(key, value);
        return;
      } catch {
        // IndexedDB unavailable or write failed: keep in memory for this session only.
      }
      await fallbackMemory.set(key, value);
    },
    async delete(key) {
      try {
        await idbDelete(key);
      } catch {
        // ignore; still clear memory
      }
      await fallbackMemory.delete(key);
    },
  };
}

function resolveStore(options?: VaultOptions): IdentityKeyValueStore {
  return options?.store ?? createDefaultStore();
}

/** Which kind of identity record is stored: 'encrypted' wins when both exist. */
export async function storedIdentityKind(options?: VaultOptions): Promise<StoredIdentityKind> {
  const store = resolveStore(options);
  if (typeof (await safeGet(store, IDENTITY_ENCRYPTED_KEY)) === "string") return "encrypted";
  if (typeof (await safeGet(store, IDENTITY_PLAIN_KEY)) === "string") return "plain";
  return "none";
}

/** True when any identity record (encrypted or plain) is stored. */
export async function hasStoredIdentity(options?: VaultOptions): Promise<boolean> {
  return (await storedIdentityKind(options)) !== "none";
}

/**
 * Encrypts the identity under the passphrase and stores it. Any plain record is removed afterwards, so
 * a successful call leaves no plaintext key behind. Throws on a short passphrase (see MIN_PASSPHRASE_LENGTH).
 */
export async function saveIdentityEncrypted(identity: Identity, passphrase: string, options?: VaultOptions): Promise<void> {
  const store = resolveStore(options);
  const envelope = await exportIdentity(identity, passphrase, options?.iterations ?? IDENTITY_KDF_ITERATIONS);
  await store.set(IDENTITY_ENCRYPTED_KEY, envelope);
  await safeDelete(store, IDENTITY_PLAIN_KEY);
}

/**
 * Decrypts the stored identity. Returns undefined when no encrypted record exists (check
 * storedIdentityKind: a 'plain' record needs migrateToEncrypted). Throws WrongPassphraseError
 * ("Wrong passphrase") for a bad passphrase and CorruptVaultError for an unreadable record.
 */
export async function loadIdentityEncrypted(passphrase: string, options?: VaultOptions): Promise<Identity | undefined> {
  const store = resolveStore(options);
  const envelope = await safeGet(store, IDENTITY_ENCRYPTED_KEY);
  if (typeof envelope !== "string") return undefined;
  try {
    return await importIdentity(envelope, passphrase);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/^Wrong passphrase/.test(message)) throw new WrongPassphraseError();
    if (/^Passphrase must be/.test(message)) throw error;
    throw new CorruptVaultError(`Stored identity could not be read: ${message}`);
  }
}

/**
 * Re-encrypts an existing plain record under the passphrase and deletes the plain key. The encrypted
 * record is read back and compared before the plain key is removed, so a failed write cannot lose the
 * identity. Returns true when a plain record was migrated, false when there was none.
 * If an encrypted record already exists, the passphrase must open it (WrongPassphraseError otherwise);
 * a leftover plain key is then deleted without rewriting the encrypted record.
 */
export async function migrateToEncrypted(passphrase: string, options?: VaultOptions): Promise<boolean> {
  const store = resolveStore(options);
  const plain = await safeGet(store, IDENTITY_PLAIN_KEY);
  if (typeof plain !== "string") return false;
  const identity = deserializeIdentity(plain);

  const existing = await safeGet(store, IDENTITY_ENCRYPTED_KEY);
  if (typeof existing === "string") {
    const opened = await loadIdentityEncrypted(passphrase, options);
    if (!opened) throw new CorruptVaultError("Stored identity could not be read");
    await store.delete(IDENTITY_PLAIN_KEY);
    return true;
  }

  await saveIdentityEncrypted(identity, passphrase, { ...options, store });
  // saveIdentityEncrypted already removed the plain key; verify the encrypted copy before trusting that.
  const back = await loadIdentityEncrypted(passphrase, { ...options, store });
  if (!back || commitment(back) !== commitment(identity)) {
    await store.set(IDENTITY_PLAIN_KEY, plain);
    await safeDelete(store, IDENTITY_ENCRYPTED_KEY);
    throw new CorruptVaultError("Encrypted copy did not verify; the plain identity was kept.");
  }
  return true;
}

/** Deletes every stored identity record, encrypted and plain. */
export async function clearStoredIdentity(options?: VaultOptions): Promise<void> {
  const store = resolveStore(options);
  await safeDelete(store, IDENTITY_ENCRYPTED_KEY);
  await safeDelete(store, IDENTITY_PLAIN_KEY);
}

async function safeGet(store: IdentityKeyValueStore, key: string): Promise<unknown> {
  try {
    return await store.get(key);
  } catch {
    return undefined;
  }
}

async function safeDelete(store: IdentityKeyValueStore, key: string): Promise<void> {
  try {
    await store.delete(key);
  } catch {
    // Best effort; a store that cannot delete also cannot have been written to.
  }
}

// --- IndexedDB adapter (same database and object store as saveIdentity) ----------------------

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    try {
      if (typeof indexedDB === "undefined" || !indexedDB) return reject(new Error("IndexedDB is not available"));
      const request = indexedDB.open(IDENTITY_DB_NAME, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(IDENTITY_STORE)) request.result.createObjectStore(IDENTITY_STORE);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
      request.onblocked = () => reject(new Error("IndexedDB open blocked"));
    } catch (error) {
      reject(error);
    }
  });
}

async function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(IDENTITY_STORE, mode);
      const request = run(tx.objectStore(IDENTITY_STORE));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
      tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
    });
  } finally {
    db.close();
  }
}

const idbGet = (key: string) => withStore<unknown>("readonly", (s) => s.get(key));
const idbSet = (key: string, value: string) => withStore<IDBValidKey>("readwrite", (s) => s.put(value, key)).then(() => undefined);
const idbDelete = (key: string) => withStore<undefined>("readwrite", (s) => s.delete(key));
