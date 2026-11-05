import { useSyncExternalStore } from "react";
import {
  IDENTITY_DB_NAME,
  IDENTITY_ENCRYPTED_KEY,
  IDENTITY_STORE,
  clearStoredIdentity,
  createIdentity,
  importIdentity,
  loadIdentityEncrypted,
  migrateToEncrypted,
  saveIdentityEncrypted,
  storedIdentityKind,
  type StoredIdentityKind,
} from "@zerodrop/core";

export type Identity = ReturnType<typeof createIdentity>;

/**
 * Session state for the Semaphore identity.
 *
 * - checking:  looking at what is stored.
 * - none:      nothing is stored. `draft` holds a freshly created identity that has NOT been saved yet; it is only
 *              saved once the user chooses a passphrase.
 * - locked:    an encrypted record is stored; the identity is not in memory until the passphrase is given.
 * - legacy:    a plain (unencrypted) record from an earlier version is stored; it is NOT loaded into memory until the
 *              user protects it with a passphrase.
 * - unlocked:  `identity` is in memory. `ephemeral` means it was never written to the vault (dev demo identity).
 *
 * The identity lives only in this module's state. `lock()` drops it. Nothing here ever writes the plain record.
 */
export type SessionStatus = "checking" | "none" | "locked" | "legacy" | "unlocked";

export type SessionState = {
  status: SessionStatus;
  identity?: Identity;
  draft?: Identity;
  stored: StoredIdentityKind;
  /** The identity in memory was never saved to the vault (dev demo). */
  ephemeral: boolean;
  /** The encrypted record could only be kept in memory: this browser refused IndexedDB. Lost on reload. */
  volatile: boolean;
};

let state: SessionState = { status: "checking", stored: "none", ephemeral: false, volatile: false };
const listeners = new Set<() => void>();
let started = false;

function set(patch: Partial<SessionState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!started) {
    started = true;
    void refresh();
  }
  return () => listeners.delete(listener);
}

/** Re-reads what is stored and moves to the matching locked state. Never loads an identity into memory. */
async function refresh(): Promise<void> {
  let kind: StoredIdentityKind = "none";
  try {
    kind = await storedIdentityKind();
  } catch {
    kind = "none";
  }
  set({
    stored: kind,
    status: kind === "encrypted" ? "locked" : kind === "plain" ? "legacy" : "none",
    identity: undefined,
    draft: undefined,
    ephemeral: false,
  });
}

/** True when the encrypted record is really in IndexedDB (the vault silently falls back to memory otherwise). */
async function encryptedRecordInIndexedDb(): Promise<boolean> {
  try {
    if (typeof indexedDB === "undefined") return false;
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(IDENTITY_DB_NAME, 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("blocked"));
    });
    try {
      if (!db.objectStoreNames.contains(IDENTITY_STORE)) return false;
      return await new Promise<boolean>((resolve) => {
        const request = db.transaction(IDENTITY_STORE, "readonly").objectStore(IDENTITY_STORE).get(IDENTITY_ENCRYPTED_KEY);
        request.onsuccess = () => resolve(typeof request.result === "string");
        request.onerror = () => resolve(false);
      });
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}

async function saveAndUnlock(identity: Identity, passphrase: string, ephemeral = false): Promise<void> {
  await saveIdentityEncrypted(identity, passphrase);
  const persisted = await encryptedRecordInIndexedDb();
  set({ status: "unlocked", identity, draft: undefined, stored: "encrypted", ephemeral, volatile: !persisted });
}

export const session = {
  /** Creates a new identity in memory only. Nothing is saved until `protectDraft`. */
  startDraft(): void {
    set({ draft: createIdentity() });
  },

  discardDraft(): void {
    set({ draft: undefined });
  },

  /** First visit: encrypt the draft under the passphrase, save it, and unlock. Throws on a short passphrase. */
  async protectDraft(passphrase: string): Promise<void> {
    const draft = state.draft;
    if (!draft) throw new Error("There is no new identity to save.");
    await saveAndUnlock(draft, passphrase);
  },

  /** Return visit: decrypt the stored identity. Throws WrongPassphraseError for a bad passphrase. */
  async unlock(passphrase: string): Promise<void> {
    const identity = await loadIdentityEncrypted(passphrase);
    if (!identity) {
      await refresh();
      throw new Error("No encrypted identity is stored in this browser.");
    }
    set({ status: "unlocked", identity, draft: undefined, stored: "encrypted", ephemeral: false });
  },

  /** Legacy plain record: encrypt it under the passphrase (the plain key is deleted) and unlock. */
  async protectLegacy(passphrase: string): Promise<void> {
    const migrated = await migrateToEncrypted(passphrase);
    if (!migrated) {
      await refresh();
      throw new Error("There is no unencrypted identity to protect.");
    }
    await session.unlock(passphrase);
    set({ volatile: !(await encryptedRecordInIndexedDb()) });
  },

  /** Drops the identity from memory. The encrypted record stays stored. */
  async lock(): Promise<void> {
    await refresh();
  },

  /** Decrypts a backup file and stores it as this browser's identity, encrypted under the same passphrase. */
  async importBackup(envelopeJson: string, passphrase: string): Promise<void> {
    const identity = await importIdentity(envelopeJson, passphrase);
    await saveAndUnlock(identity, passphrase);
  },

  /** Deletes every stored identity record and forgets the in-memory one. */
  async deleteStored(): Promise<void> {
    await clearStoredIdentity();
    set({ status: "none", stored: "none", identity: undefined, draft: undefined, ephemeral: false, volatile: false });
  },

  /**
   * DEV only: use an identity in memory without storing anything. It is never written to the vault; saving it needs
   * `protectEphemeral` with a passphrase the user chooses.
   */
  useEphemeral(identity: Identity): void {
    set({ status: "unlocked", identity, draft: undefined, ephemeral: true, volatile: false });
  },

  /** Saves an ephemeral (demo) identity under a user-chosen passphrase. Replaces any stored identity. */
  async protectEphemeral(passphrase: string): Promise<void> {
    const identity = state.identity;
    if (!identity || !state.ephemeral) throw new Error("There is no unsaved identity to protect.");
    await saveAndUnlock(identity, passphrase);
  },
};

export function useSession(): SessionState & { actions: typeof session } {
  const snapshot = useSyncExternalStore(subscribe, () => state, () => state);
  return { ...snapshot, actions: session };
}
