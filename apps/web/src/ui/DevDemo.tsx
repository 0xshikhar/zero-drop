import { useState } from "react";
import { persistIdentity, type Identity } from "../lib/session";
import { useDeployment } from "../lib/prefs";

/** Dev server only (import.meta.env.DEV). Loads a demo group member for the active deployment. */
export function DevDemoButton({ setIdentity }: { setIdentity: (identity: Identity) => void }) {
  const deployment = useDeployment();
  const [message, setMessage] = useState<string>();
  if (!import.meta.env.DEV) return null;
  async function load() {
    try {
      const { loadDemoIdentity } = await import("../lib/devdemo");
      const identity = loadDemoIdentity(deployment?.id ?? "local-mock");
      setIdentity(identity);
      await persistIdentity(identity);
      setMessage(`Loaded demo member 1 for ${deployment?.id}.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }
  return (
    <div className="devbox">
      <button className="secondary" onClick={() => void load()}>Load demo identity (dev only)</button>
      {message && <p className="small muted">{message}</p>}
    </div>
  );
}
