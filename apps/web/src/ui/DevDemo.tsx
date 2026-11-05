import { useState } from "react";
import { session } from "../lib/session";
import { useDeployment } from "../lib/prefs";

/**
 * Dev server only (import.meta.env.DEV). Loads a demo group member for the active deployment into MEMORY.
 * The demo key is never written to the vault; saving it needs a passphrase the user chooses (see EphemeralNotice).
 */
export function DevDemoButton() {
  const deployment = useDeployment();
  const [message, setMessage] = useState<string>();
  if (!import.meta.env.DEV) return null;
  async function load() {
    try {
      const { loadDemoIdentity } = await import("../lib/devdemo");
      session.useEphemeral(loadDemoIdentity(deployment?.id ?? "local-mock"));
      setMessage(`Loaded demo member 1 for ${deployment?.id}, in memory only.`);
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
