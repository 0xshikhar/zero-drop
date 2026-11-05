import { useState } from "react";
import { exportIdentity, importIdentity, MIN_PASSPHRASE_LENGTH } from "@zerodrop/core";
import { LOCAL } from "../lib/config";
import { persistIdentity, type Identity } from "../lib/session";
import type { TransportChoice } from "./DropPage";
import { short } from "./Shell";

type Props = {
  identity: Identity | undefined;
  setIdentity: (identity: Identity) => void;
  transport: TransportChoice;
  setTransport: (choice: TransportChoice) => void;
};

const TRADE_OFFS = [
  { label: "Direct RPC for readers", detail: "Reads go straight to the RPC from this machine. This is the only mode in this build.", on: true },
  { label: "Random submission delay", detail: "Not built. Delaying a post would need a cancellable timer.", on: false },
  { label: "Single sidecar", detail: "Not applicable. Posting uses the one local RPC; there is no sidecar fan-out yet.", on: false },
];

export function SettingsPage({ identity, setIdentity, transport, setTransport }: Props) {
  const [passphrase, setPassphrase] = useState("");
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string }>();
  const [importFile, setImportFile] = useState<File>();

  async function exportBackup() {
    if (!identity) return setMessage({ tone: "error", text: "No identity to export yet." });
    try {
      const envelope = await exportIdentity(identity, passphrase);
      const url = URL.createObjectURL(new Blob([envelope], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = "zerodrop-identity.json";
      link.click();
      URL.revokeObjectURL(url);
      setMessage({ tone: "ok", text: "Encrypted backup downloaded. Keep the passphrase somewhere else." });
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    }
  }

  async function importBackup() {
    if (!importFile) return setMessage({ tone: "error", text: "Choose a backup file first." });
    try {
      const imported = await importIdentity(await importFile.text(), passphrase);
      setIdentity(imported);
      const saved = await persistIdentity(imported);
      setMessage({ tone: "ok", text: saved ? "Identity imported and saved in this browser." : "Identity imported for this session. This browser would not save it." });
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    }
  }

  return (
    <section>
      <p className="eyebrow">Settings</p>
      <h1 className="page-title">Settings</h1>

      <div className="card">
        <h2>Endpoints</h2>
        <p className="small muted card-sub">Read from config/local.json at build time. The list is not editable in this build.</p>
        <ul className="rows">
          <li><span>RPC</span><code className="mono">{LOCAL.rpcUrl}</code></li>
          <li><span>Chain</span><code className="mono">{LOCAL.chainId}</code></li>
          <li><span>ZeroDrop</span><code className="mono">{short(LOCAL.contracts.zeroDrop, 12, 8)}</code></li>
          <li><span>Deployed at block</span><code className="mono">{LOCAL.deployedBlock}</code></li>
        </ul>
      </div>

      <div className="card">
        <h2>Posting transaction</h2>
        <fieldset className="radio-group">
          <legend className="small muted">Choose how the posting transaction is sent</legend>
          <label className="check">
            <input type="radio" name="transport" checked={transport === "direct"} onChange={() => setTransport("direct")} />
            <span><strong>Direct transaction (default)</strong><br /><span className="small muted">The poster address is visible on chain. Verified on the local anvil chain.</span></span>
          </label>
          <label className="check">
            <input type="radio" name="transport" checked={transport === "frame"} onChange={() => setTransport("frame")} />
            <span><strong>Frame transaction, EIP-8141 (unverified)</strong><br /><span className="small muted">Not verified against the devnet. Its TLS certificate has failed validation from the development machine, and config/devnet.json has no ZeroDrop address or sidecar URLs, so it cannot submit yet.</span></span>
          </label>
        </fieldset>
      </div>

      <div className="card">
        <h2>Trade-offs</h2>
        <p className="small muted card-sub">Each option changes what leaks. All are shown here, none can be switched on yet.</p>
        <ul className="toggles">
          {TRADE_OFFS.map((t) => (
            <li key={t.label}>
              <label className="check disabled">
                <input type="checkbox" checked={t.on} disabled readOnly />
                <span><strong>{t.label}</strong><br /><span className="small muted">{t.detail}</span></span>
              </label>
            </li>
          ))}
        </ul>
      </div>

      <div className="card">
        <h2>Identity backup</h2>
        <p className="small muted card-sub">The export is encrypted with your passphrase (PBKDF2 and AES-GCM). It is the only copy outside this browser. Passphrase minimum: {MIN_PASSPHRASE_LENGTH} characters.</p>
        <label className="field">
          <span className="field-label">Passphrase</span>
          <input type="password" autoComplete="new-password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />
        </label>
        <div className="actions">
          <button className="secondary" onClick={() => void exportBackup()} disabled={!identity}>Export encrypted backup</button>
        </div>
        <label className="field">
          <span className="field-label">Import a backup file</span>
          <input type="file" accept="application/json" onChange={(e) => setImportFile(e.target.files?.[0])} />
        </label>
        <div className="actions">
          <button className="secondary" onClick={() => void importBackup()}>Import backup</button>
        </div>
        {message && <p className={message.tone === "ok" ? "verified small" : "error-text small"}>{message.text}</p>}
      </div>
    </section>
  );
}
