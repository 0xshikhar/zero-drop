import { useState } from "react";
import {
  describeTradeoff,
  exportIdentity,
  MAX_DELAY_MINUTES_LIMIT,
  MIN_PASSPHRASE_LENGTH,
  resetSettings,
  updateSettings,
  type PinnerEndpoint,
  type Settings,
  type TradeoffKey,
} from "@zerodrop/core";
import { DEPLOYMENTS } from "../lib/config";
import { planNetwork } from "../lib/network";
import { effectivePinners, urlProblem } from "../lib/pinners";
import { frameAvailability } from "../lib/post";
import { resetPrefs, updatePrefs, useDeployment, usePrefs, useSettings } from "../lib/prefs";
import { useSession } from "../lib/session";
import { download, errorMessage, short } from "../lib/util";
import { Card, Info, Warn } from "./common";
import { IdentityPanel, PassphraseForm } from "./IdentityPanel";

export function SettingsPage() {
  const settings = useSettings();
  const prefs = usePrefs();
  const deployment = useDeployment();
  const plan = planNetwork(settings, deployment);
  const frame = frameAvailability(deployment, settings);

  return (
    <section>
      <p className="eyebrow">Settings</p>
      <h1 className="page-title">Settings</h1>
      <p className="lede">Settings are stored in this browser in clear text, including any API key inside a URL. Each option below says what it leaks.</p>

      <Card title="Deployment" subtitle="Which contract deployment the app reads and posts to. Read from config/*.json at build time." raised={false}>
        <fieldset className="radio-group">
          <legend className="sr-only">Deployment</legend>
          {DEPLOYMENTS.map((d) => (
            <label key={d.id} className={`check ${d.unavailableReason ? "disabled" : ""}`}>
              <input type="radio" name="deployment" disabled={!!d.unavailableReason} checked={deployment?.id === d.id} onChange={() => updatePrefs({ deploymentId: d.id })} />
              <span>
                <strong>{d.label}</strong> <span className="mono small muted">({d.id}, chain {d.chainId})</span><br />
                <span className="small muted">
                  {d.unavailableReason ?? `${d.verifierKind === "mock" ? "Mock verifier: accepts any proof, works without circuit artifacts. " : "Semaphore verifier: needs circuit artifacts to post. "}${d.directRecordEnabled ? "Direct record enabled. " : ""}ZeroDrop ${short(d.zeroDrop ?? "", 10, 6)}, RPC ${d.rpcUrls.join(", ")}`}
                </span>
              </span>
            </label>
          ))}
          {DEPLOYMENTS.length === 0 && <p className="muted">No config/*.json was found at build time.</p>}
        </fieldset>
      </Card>

      <Card title="Trade-offs" subtitle="Each option changes what leaks. The safe default is first." raised={false}>
        <Toggle k="directRpcForReader" checked={settings.directRpcForReader} onChange={(v) => updateSettings({ directRpcForReader: v })} />
        <Toggle k="skipRandomDelay" checked={settings.skipRandomDelay} onChange={(v) => updateSettings({ skipRandomDelay: v })} />
        <Toggle k="singleSidecar" checked={settings.singleSidecar} onChange={(v) => updateSettings({ singleSidecar: v })} />
        <Toggle k="networkMode" checked={settings.networkMode === "direct"} onChange={(v) => updateSettings({ networkMode: v ? "direct" : "anon" })} />
        {plan.note && <Info>{plan.requested === "anon" && plan.effective === "direct" ? <>Network mode "anon" is selected but <strong>{plan.note}</strong>, so requests go directly.</> : plan.note}</Info>}
        {plan.effective === "anon" && <Warn>Anon-RPC is not configured in this build: requests will be rejected, not sent directly. Choose direct network above to proceed (this exposes your IP address).</Warn>}

        <label className="field narrow">
          <span className="field-label">Maximum random delay (minutes)</span>
          <input
            type="number"
            min={0}
            max={MAX_DELAY_MINUTES_LIMIT}
            step={0.5}
            value={settings.maxDelayMinutes}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (Number.isFinite(n)) updateSettings({ maxDelayMinutes: n });
            }}
            aria-label="Maximum random delay in minutes"
          />
          <span className="small muted">Posting waits a random time between 0 and this long, with a visible countdown and a Cancel button. Ignored when the delay is skipped.</span>
        </label>
      </Card>

      <Card title="Posting transaction" subtitle="How the posting transaction is sent." raised={false}>
        <fieldset className="radio-group">
          <legend className="sr-only">Posting transaction</legend>
          <label className="check">
            <input type="radio" name="transport" checked={prefs.transport === "direct" || !frame.ok} onChange={() => updatePrefs({ transport: "direct" })} />
            <span><strong>Direct transaction (default)</strong><br /><span className="small muted">The poster address is visible on chain.</span></span>
          </label>
          <label className={`check ${frame.ok ? "" : "disabled"}`}>
            <input type="radio" name="transport" disabled={!frame.ok} checked={prefs.transport === "frame" && frame.ok} onChange={() => updatePrefs({ transport: "frame" })} />
            <span>
              <strong>Frame transaction, EIP-8141 (unverified)</strong><br />
              <span className="small muted">{frame.ok ? "Fan-out to the sidecars below. Never run against a real devnet by this build." : `Unavailable: ${frame.reason}`}</span>
            </span>
          </label>
        </fieldset>
      </Card>

      <Card title="Endpoints" subtitle="Lists are saved as you edit. http:// and https:// only." raised={false}>
        <UrlList
          label="RPC URLs"
          values={settings.rpcUrls}
          onChange={(rpcUrls) => updateSettings({ rpcUrls })}
          emptyNote={`Empty: using the deployment's RPC (${deployment?.rpcUrls.join(", ") ?? "none"}). Two or more URLs from different operators let readers compare answers.`}
        />
        <UrlList
          label="Sidecar URLs (frame transactions)"
          values={settings.sidecarUrls}
          onChange={(sidecarUrls) => updateSettings({ sidecarUrls })}
          emptyNote={deployment?.sidecarUrls.length ? `Empty: using the deployment's sidecars (${deployment.sidecarUrls.join(", ")}).` : "Empty: none configured, so the frame path is unavailable."}
        />
        <PinnerList settings={settings} />
      </Card>

      <Card title="Identity" subtitle={`The identity is stored in this browser encrypted with your passphrase (PBKDF2 and AES-GCM, minimum ${MIN_PASSPHRASE_LENGTH} characters). There is no recovery if you forget it, so keep an encrypted backup.`} raised={false}>
        <IdentitySettings />
      </Card>

      <Card title="Reset" subtitle="Back to the defaults: settings, deployment choice and transaction type. Your stored identity is not touched." raised={false}>
        <button className="secondary" onClick={() => { resetSettings(); resetPrefs(); }}>Reset to defaults</button>
      </Card>
    </section>
  );
}

function Toggle({ k, checked, onChange }: { k: TradeoffKey; checked: boolean; onChange: (value: boolean) => void }) {
  const t = describeTradeoff(k);
  return (
    <label className="check tradeoff">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} data-setting={k} />
      <span>
        <strong>{t.title}</strong>{" "}
        <span className={checked ? "badge badge-warning" : "badge badge-neutral"}>{checked ? "on: less private" : "off: safe default"}</span><br />
        <span className="small">{t.effect}</span><br />
        <span className="small warning-text">Leaks: {t.leaks}</span>
        {t.speed && <><br /><span className="small muted">Speed: {t.speed}</span></>}
      </span>
    </label>
  );
}

function UrlList({ label, values, onChange, emptyNote }: { label: string; values: string[]; onChange: (values: string[]) => void; emptyNote: string }) {
  const [draft, setDraft] = useState("");
  const [problem, setProblem] = useState<string>();
  function add() {
    const p = urlProblem(draft);
    if (p) return setProblem(p);
    if (values.includes(draft.trim())) return setProblem("Already in the list.");
    onChange([...values, draft.trim()]);
    setDraft("");
    setProblem(undefined);
  }
  return (
    <div className="list-editor">
      <p className="field-label">{label}</p>
      {values.length === 0 && <p className="small muted">{emptyNote}</p>}
      <ul className="rows">
        {values.map((v) => (
          <li key={v}><code className="mono small">{v}</code><button className="link-button" onClick={() => onChange(values.filter((x) => x !== v))}>Remove</button></li>
        ))}
      </ul>
      <div className="inline-form">
        <input value={draft} onChange={(e) => { setDraft(e.target.value); setProblem(undefined); }} placeholder="https://…" aria-label={`Add to ${label}`} onKeyDown={(e) => e.key === "Enter" && add()} />
        <button className="secondary" onClick={add}>Add</button>
      </div>
      {problem && <p className="small error-text" role="alert">{problem}</p>}
    </div>
  );
}

function PinnerList({ settings }: { settings: Settings }) {
  const deployment = useDeployment();
  const eff = effectivePinners(settings, deployment);
  const [kind, setKind] = useState<"zerodrop" | "kubo">("zerodrop");
  const [url, setUrl] = useState("");
  const [gateway, setGateway] = useState("");
  const [problem, setProblem] = useState<string>();

  const commit = (list: PinnerEndpoint[]) => updateSettings({ pinnerEndpoints: list });

  function nextId(): string {
    let n = eff.endpoints.length + 1;
    while (eff.endpoints.some((e) => e.id === `${kind}-${n}`)) n++;
    return `${kind}-${n}`;
  }

  function add() {
    const p = urlProblem(url) ?? (kind === "kubo" && gateway.trim() ? urlProblem(gateway) : undefined);
    if (p) return setProblem(p);
    if (kind === "kubo" && !gateway.trim()) return setProblem("A Kubo pinner needs a gateway URL: Kubo serves reads on a different port than its API.");
    if (eff.endpoints.some((e) => e.url === url.trim())) return setProblem("A pinner with this URL is already in the list.");
    commit([...eff.endpoints, { id: nextId(), kind, url: url.trim(), ...(kind === "kubo" ? { gatewayUrl: gateway.trim() } : {}) }]);
    setUrl("");
    setGateway("");
    setProblem(undefined);
  }

  return (
    <div className="list-editor">
      <p className="field-label">Pinners</p>
      {eff.fromDefaults && <p className="small muted">Showing the local defaults for this deployment (not saved). Editing saves the list you see.</p>}
      {eff.endpoints.length === 0 && <p className="small muted">None configured: posting is blocked until at least one pinner exists. Two give redundancy.</p>}
      <ul className="rows">
        {eff.endpoints.map((e) => (
          <li key={e.id}>
            <span className="small"><strong>{e.id}</strong> · {e.kind}<br /><code className="mono small">{e.url}</code>{e.gatewayUrl && <><br /><code className="mono small">gateway {e.gatewayUrl}</code></>}</span>
            <button className="link-button" onClick={() => commit(eff.endpoints.filter((x) => x.id !== e.id))}>Remove</button>
          </li>
        ))}
      </ul>
      <div className="inline-form wrap">
        <select value={kind} onChange={(e) => setKind(e.target.value as "zerodrop" | "kubo")} aria-label="Pinner type">
          <option value="zerodrop">zerodrop pinner</option>
          <option value="kubo">Kubo node</option>
        </select>
        <input value={url} onChange={(e) => { setUrl(e.target.value); setProblem(undefined); }} placeholder={kind === "kubo" ? "Kubo API URL" : "Pinner URL"} aria-label="Pinner URL" />
        {kind === "kubo" && <input value={gateway} onChange={(e) => { setGateway(e.target.value); setProblem(undefined); }} placeholder="Kubo gateway URL" aria-label="Kubo gateway URL" />}
        <button className="secondary" onClick={add}>Add</button>
      </div>
      {problem && <p className="small error-text" role="alert">{problem}</p>}
    </div>
  );
}

function IdentitySettings() {
  const session = useSession();
  const { actions } = session;
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string }>();

  return (
    <>
      <IdentityPanel
        unlocked={() => (
          <div className="actions tight">
            <button className="secondary" onClick={() => { void actions.lock().then(() => setMessage({ tone: "ok", text: "Locked. The identity was dropped from memory; the encrypted copy is still stored." })); }} data-testid="lock">Lock</button>
          </div>
        )}
      />
      {message && <p className={message.tone === "ok" ? "verified small" : "error-text small"} role="status" data-testid="identity-message">{message.text}</p>}
      <ExportIdentity setMessage={setMessage} />
      <ImportIdentity setMessage={setMessage} />
      <DeleteIdentity setMessage={setMessage} />
    </>
  );
}

type Say = (m: { tone: "ok" | "error"; text: string } | undefined) => void;

function ExportIdentity({ setMessage }: { setMessage: Say }) {
  const { identity } = useSession();
  return (
    <div className="list-editor">
      <p className="field-label">Export (encrypted file)</p>
      {!identity ? (
        <p className="small muted">Unlock the identity above to export it.</p>
      ) : (
        <>
          <p className="small muted">The file is encrypted with the passphrase you type here. It can be the same as your vault passphrase or a different one. It is the only copy outside this browser.</p>
          <PassphraseForm
            id="export"
            confirm
            submitLabel="Export encrypted backup"
            onSubmit={async (p) => {
              download("zerodrop-identity.json", await exportIdentity(identity, p), "application/json");
              setMessage({ tone: "ok", text: "Encrypted backup downloaded. Keep the passphrase somewhere else." });
            }}
          />
        </>
      )}
    </div>
  );
}

function ImportIdentity({ setMessage }: { setMessage: Say }) {
  const { stored } = useSession();
  const { actions } = useSession();
  const [file, setFile] = useState<File>();
  return (
    <div className="list-editor">
      <p className="field-label">Import (encrypted file)</p>
      <p className="small muted">Decrypts a backup with its passphrase, then stores it in this browser encrypted under that same passphrase.{stored !== "none" ? " This replaces the identity stored here now." : ""}</p>
      <label className="field">
        <span className="field-label">Backup file</span>
        <input type="file" accept="application/json,.json" onChange={(e) => setFile(e.target.files?.[0])} data-testid="import-file" />
      </label>
      {file && (
        <PassphraseForm
          id="import"
          submitLabel={stored !== "none" ? "Import and replace" : "Import"}
          busyLabel="Decrypting…"
          onSubmit={async (p) => {
            await actions.importBackup(await file.text(), p);
            setMessage({ tone: "ok", text: "Identity imported and stored encrypted in this browser. It is unlocked for this session." });
            setFile(undefined);
          }}
        />
      )}
    </div>
  );
}

function DeleteIdentity({ setMessage }: { setMessage: Say }) {
  const { stored, identity, actions } = useSession();
  const [confirming, setConfirming] = useState(false);
  if (stored === "none" && !identity) return null;
  return (
    <div className="list-editor">
      <p className="field-label">Delete stored identity</p>
      {!confirming ? (
        <button className="secondary" onClick={() => setConfirming(true)} data-testid="delete-start">Delete stored identity…</button>
      ) : (
        <>
          <Warn>This permanently removes the identity from this browser. Without an exported backup you can no longer post as this group member, and the issuer has to add a new commitment. This cannot be undone.</Warn>
          <div className="actions tight">
            <button className="secondary" onClick={() => setConfirming(false)}>Keep it</button>
            <button
              className="primary"
              data-testid="delete-confirm"
              onClick={() => {
                void actions.deleteStored().then(() => {
                  setConfirming(false);
                  setMessage({ tone: "ok", text: "Stored identity deleted from this browser." });
                });
              }}
            >
              Delete permanently
            </button>
          </div>
        </>
      )}
    </div>
  );
}
