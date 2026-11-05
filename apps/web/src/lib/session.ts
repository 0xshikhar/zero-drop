import { loadIdentity, saveIdentity, type createIdentity } from "@zerodrop/core";

export type Identity = ReturnType<typeof createIdentity>;

/** Reads the saved identity from IndexedDB. Any failure means "no identity". */
export async function restoreIdentity(): Promise<Identity | undefined> {
  try {
    return await loadIdentity();
  } catch {
    return undefined;
  }
}

/** Saves the identity to IndexedDB. Returns false when the browser refuses. Never stores the anvil key. */
export async function persistIdentity(identity: Identity): Promise<boolean> {
  try {
    return await saveIdentity(identity);
  } catch {
    return false;
  }
}
