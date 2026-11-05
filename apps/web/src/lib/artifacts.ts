import type { SemaphoreArtifacts } from "@zerodrop/core";

/**
 * Semaphore circuit artifacts. They are not bundled or downloaded by the build. If the files are placed in
 * apps/web/public/zk/ (semaphore-<depth>.wasm and semaphore-<depth>.zkey), the glob below finds them.
 * With no files present the glob is empty and posting stays blocked.
 */
const zkUrls = import.meta.glob<string>("/public/zk/semaphore-*.{wasm,zkey}", {
  eager: false,
  query: "?url",
  import: "default",
});

/** True when both files for a depth exist in the build inputs. */
export function hasArtifacts(depth: number): boolean {
  return `/public/zk/semaphore-${depth}.wasm` in zkUrls && `/public/zk/semaphore-${depth}.zkey` in zkUrls;
}

/** Resolves the bundled wasm and zkey URLs for a depth, or undefined when they are not installed. */
export async function loadBundledArtifacts(depth: number): Promise<SemaphoreArtifacts | undefined> {
  if (!hasArtifacts(depth)) return undefined;
  const wasm = zkUrls[`/public/zk/semaphore-${depth}.wasm`];
  const zkey = zkUrls[`/public/zk/semaphore-${depth}.zkey`];
  if (!wasm || !zkey) return undefined;
  const [wasmUrl, zkeyUrl] = await Promise.all([wasm(), zkey()]);
  return { wasm: wasmUrl, zkey: zkeyUrl };
}

export const ARTIFACTS_MISSING_MESSAGE = "Circuit artifacts not installed. See the README";
