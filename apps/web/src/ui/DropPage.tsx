import { useEffect, useRef, useState } from "react";
import {
  cidFor,
  commitmentHex,
  createBundle,
  createIdentity,
  digestOf,
  prepareDocument,
  publishDocument,
  serializeBundle,
  UnsupportedMediaError,
  type PreparedDocument,
  type PublishResult,
} from "@zerodrop/core";
import { keccak256, toHex, type Hex } from "viem";
import { loadGroups, readClient, requireDeployment, type GroupView } from "../lib/chain";
import { networkGate, useBootState, useNetworkPlan } from "../lib/network";
import { describeEndpoint, effectivePinners } from "../lib/pinners";
import { frameAvailability, initialSteps, proofBlocker, runPost, PostCancelled, type TimelineStep } from "../lib/post";
import { updatePrefs, useDeployment, usePrefs, useSettings } from "../lib/prefs";
import { persistIdentity, type Identity } from "../lib/session";
import { download, errorMessage, formatBytes, mediaTypeOf, shareLink, short } from "../lib/util";
import { Card, CopyButton, Tick, Warn } from "./common";
import { DevDemoButton } from "./DevDemo";
import { TxTimeline } from "./TxTimeline";

type Props = {
  identity: Identity | undefined;
  setIdentity: (identity: Identity) => void;
  identityChecked: boolean;
};

const STEPS = ["Identity", "Group and case", "File", "Metadata", "Anonymity set", "Publish", "Post", "Timeline"] as const;
const PRIVATE_KEY = /^0x[0-9a-fA-F]{64}$/;

type Done = { txHash: Hex; blockNumber: bigint; digest: Hex; cid: string; bundleJson: string; mock: boolean; transport: "direct" | "frame" };

export function DropPage({ identity, setIdentity, identityChecked }: Props) {
  const deployment = useDeployment();
  const settings = useSettings();
  const prefs = usePrefs();
  const plan = useNetworkPlan();
  const boot = useBootState();
  const gate = networkGate(plan, boot);

  const [step, setStep] = useState(0);
  const [saved, setSaved] = useState<boolean | undefined>();

  // Group and case
  const [groups, setGroups] = useState<GroupView[]>();
  const [groupError, setGroupError] = useState<string>();
  const [groupId, setGroupId] = useState<bigint>();
  const [caseLabel, setCaseLabel] = useState("");

  // File
  const [file, setFile] = useState<File>();
  const [prepared, setPrepared] = useState<PreparedDocument>();
  const [fileError, setFileError] = useState<string>();
  const [working, setWorking] = useState(false);
  const [reviewed, setReviewed] = useState(false);

  // Publish (pinners)
  const [pinning, setPinning] = useState(false);
  const [pinResult, setPinResult] = useState<PublishResult>();
  const [pinError, setPinError] = useState<string>();
  const [acceptSingle, setAcceptSingle] = useState(false);

  // Post
  const [anvilKey, setAnvilKey] = useState("");
  const [timeline, setTimeline] = useState<TimelineStep[]>();
  const [postError, setPostError] = useState<string>();
  const [posting, setPosting] = useState(false);
  const [done, setDone] = useState<Done>();
  const abortRef = useRef<AbortController | undefined>(undefined);

  const caseId = caseLabel.trim() ? keccak256(toHex(caseLabel.trim())) : undefined;
  const view = groups?.find((g) => g.groupId === groupId);
  const isMember = !!(identity && view && view.commitments.some((c) => c === identity.commitment));
  const digest = prepared ? digestOf(prepared.bytes) : undefined;
  const cid = prepared ? cidFor(prepared.bytes) : undefined;

  const pinners = effectivePinners(settings, deployment);
  const minPins = pinners.endpoints.length >= 2 ? 2 : 1;
  const pinsOk = !!pinResult && pinResult.cid === cid && pinResult.pinned >= minPins;
  const frame = frameAvailability(deployment, settings);
  const transport = prefs.transport === "frame" && frame.ok ? "frame" : "direct";
  const blocker = deployment && view ? proofBlocker(deployment, view.depth) : undefined;
  const mock = deployment?.verifierKind === "mock";

  const rpcKey = settings.rpcUrls.join(",");
  useEffect(() => {
    if (!identity || !deployment) return;
    void refreshGroups();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity, deployment?.id, rpcKey, plan.effective, boot.status]);

  async function refreshGroups() {
    setGroupError(undefined);
    setGroups(undefined);
    setGroupId(undefined);
    try {
      setGroups(await loadGroups(readClient("source")));
    } catch (error) {
      setGroupError(errorMessage(error));
    }
  }

  async function createNewIdentity() {
    const next = createIdentity();
    setIdentity(next);
    setSaved(await persistIdentity(next));
  }

  async function inspect(next?: File) {
    setFile(next);
    setPrepared(undefined);
    setPinResult(undefined);
    setPinError(undefined);
    setFileError(undefined);
    setReviewed(false);
    if (!next) return;
    setWorking(true);
    try {
      setPrepared(await prepareDocument(next));
    } catch (error) {
      setFileError(
        error instanceof UnsupportedMediaError
          ? `${error.message} The file is not stripped and cannot be posted.`
          : errorMessage(error),
      );
    } finally {
      setWorking(false);
    }
  }

  async function pin() {
    if (!prepared || !cid) return;
    setPinning(true);
    setPinError(undefined);
    setPinResult(undefined);
    try {
      setPinResult(await publishDocument({ bytes: prepared.bytes, cid, endpoints: pinners.endpoints, minPins, role: "source", session: "post" }));
    } catch (error) {
      setPinError(errorMessage(error));
    } finally {
      setPinning(false);
    }
  }

  async function post() {
    if (!identity || !view || !caseId || !digest || !prepared || !cid || !pinResult) return;
    let d;
    try {
      d = requireDeployment();
    } catch (error) {
      setPostError(errorMessage(error));
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setPosting(true);
    setPostError(undefined);
    setDone(undefined);
    const pinnedDetail = `${pinResult.pinned} of ${pinners.endpoints.length} pinner${pinners.endpoints.length === 1 ? "" : "s"} ${pinResult.pinned === 1 ? "holds" : "hold"} ${short(cid, 12, 6)}`;
    setTimeline(initialSteps(transport, pinnedDetail));
    setStep(7);
    try {
      const outcome = await runPost({
        deployment: d,
        transport,
        settings,
        identity,
        view,
        caseId,
        cidDigest: digest,
        anvilKey: anvilKey.trim() as Hex,
        pinnedDetail,
        signal: controller.signal,
        onUpdate: setTimeline,
      });
      const bundle = createBundle({
        chainId: d.chainId,
        contract: d.zeroDrop,
        txHash: outcome.txHash,
        blockNumber: outcome.blockNumber,
        groupId: view.groupId,
        caseId,
        root: outcome.proof.root,
        nullifier: outcome.proof.nullifier,
        depth: outcome.proof.depth,
        proofBytes: outcome.proof.proofBytes,
        proofMode: d.verifierKind,
        cid,
        mediaType: mediaTypeOf(prepared.bytes),
        bytes: prepared.bytes,
      });
      setDone({ txHash: outcome.txHash, blockNumber: outcome.blockNumber, digest, cid, bundleJson: serializeBundle(bundle), mock: d.verifierKind === "mock", transport: outcome.transport });
      setAnvilKey("");
    } catch (error) {
      setPostError(error instanceof PostCancelled ? error.message : errorMessage(error));
    } finally {
      setPosting(false);
      abortRef.current = undefined;
    }
  }

  const sizeNow = view?.commitments.length ?? 0;
  const keyValid = PRIVATE_KEY.test(anvilKey.trim());
  const delayActive = timeline?.some((s) => s.id === "delay" && s.status === "active");

  if (!deployment) {
    return (
      <section className="drop">
        <h1 className="page-title">Post a document</h1>
        <Warn>No usable deployment was found in config/. Run <code className="mono">pnpm contracts:deploy</code>, then rebuild.</Warn>
      </section>
    );
  }

  return (
    <section className="drop" aria-labelledby="drop-title">
      <p className="eyebrow">Source</p>
      <h1 id="drop-title" className="page-title">Post a document</h1>
      <p className="lede">Your identity proves you belong to a group. The record shows the document, the group and the case. It never shows which member posted it.</p>
      {!gate.ok && <Warn>{gate.message}</Warn>}

      <ol className="stepper" aria-label="Steps">
        {STEPS.map((label, i) => (
          <li key={label} className={i === step ? "current" : i < step ? "done" : ""}>
            <span className="step-num mono">{i + 1}</span>{label}
          </li>
        ))}
      </ol>

      {step > 0 && step <= 6 && (
        <div className="summary-list">
          {identity && <SummaryRow label="Identity" value={`commitment ${short(commitmentHex(identity), 12, 8)}`} onEdit={() => setStep(0)} />}
          {step > 1 && view && <SummaryRow label="Group and case" value={`Group ${view.groupId} · case "${caseLabel.trim()}"`} onEdit={() => setStep(1)} />}
          {step > 2 && file && <SummaryRow label="File" value={`${file.name} · ${formatBytes(prepared?.bytes.byteLength ?? 0)}`} onEdit={() => setStep(2)} />}
          {step > 3 && <SummaryRow label="Metadata" value={prepared?.metadata?.removed.length ? `Removed ${prepared.metadata.removed.join(", ").toUpperCase()}` : "Reviewed"} onEdit={() => setStep(3)} />}
          {step > 4 && <SummaryRow label="Anonymity set" value={`1 of ${sizeNow} members`} onEdit={() => setStep(4)} />}
          {step > 5 && pinResult && <SummaryRow label="Published" value={`${pinResult.pinned} pin${pinResult.pinned === 1 ? "" : "s"}`} onEdit={() => setStep(5)} />}
        </div>
      )}

      {step === 0 && (
        <Card title="Your identity" subtitle="A Semaphore identity, created in this browser. Its commitment is the public value the issuer adds to a group.">
          {!identityChecked && <p className="muted">Checking for a saved identity…</p>}
          {identityChecked && !identity && (
            <>
              <p>No identity yet.</p>
              <div className="actions tight">
                <button className="primary" onClick={() => void createNewIdentity()}>Create identity</button>
                {import.meta.env.DEV && <DevDemoButton setIdentity={setIdentity} />}
              </div>
            </>
          )}
          {identity && (
            <>
              <p className="field-label">Commitment (give this to the issuer)</p>
              <code className="digest" data-testid="commitment">{commitmentHex(identity)}</code>
              {saved === false && <Warn>This browser refused to save the identity. Export a backup from Settings before you leave the page.</Warn>}
              {saved !== false && <p className="muted small">Saved in this browser's IndexedDB as an unencrypted key. Anyone with access to this browser profile can read it. Export an encrypted backup from Settings.</p>}
              <div className="actions">
                <button className="primary" onClick={() => setStep(1)}>Continue <span>→</span></button>
                {import.meta.env.DEV && <DevDemoButton setIdentity={setIdentity} />}
              </div>
            </>
          )}
        </Card>
      )}

      {step === 1 && (
        <Card title="Group and case" subtitle="Pick a group you belong to. Pick a case label to bind this disclosure to.">
          {groupError && <Warn>{groupError}</Warn>}
          {!groups && !groupError && <p className="muted">Loading groups from chain events…</p>}
          {groups && groups.length === 0 && <p className="muted">No groups on this chain yet. Ask the issuer to create one.</p>}
          <ul className="choice-list">
            {groups?.map((g) => {
              const member = !!identity && g.commitments.some((c) => c === identity.commitment);
              return (
                <li key={g.groupId.toString()}>
                  <button
                    className={`choice ${groupId === g.groupId ? "selected" : ""}`}
                    disabled={!member}
                    onClick={() => setGroupId(g.groupId)}
                    data-group={g.groupId.toString()}
                  >
                    <span>Group {g.groupId.toString()}</span>
                    <span className="mono muted small">{g.commitments.length} members · min {g.minSize}</span>
                    <span className="small">{member ? <Tick>You are a member</Tick> : "Not a member. Hand your commitment to the issuer."}</span>
                  </button>
                </li>
              );
            })}
          </ul>
          <label className="field">
            <span className="field-label">Case label</span>
            <input value={caseLabel} onChange={(e) => setCaseLabel(e.target.value)} placeholder="e.g. Q3 audit annex" maxLength={120} />
          </label>
          {caseId && <p className="small muted">Case id <code className="mono">{short(caseId, 14, 8)}</code>. One disclosure per member per case.</p>}
          <div className="actions">
            <button className="secondary" onClick={() => void refreshGroups()}>Refresh groups</button>
            <button className="primary" disabled={!isMember || !caseLabel.trim()} onClick={() => setStep(2)}>Continue <span>→</span></button>
          </div>
        </Card>
      )}

      {step === 2 && (
        <Card title="The document" subtitle="The file stays in this browser until you publish it in a later step.">
          <label className="dropzone">
            <input type="file" accept=".txt,.md,.markdown,image/jpeg,image/png,image/webp,text/plain,text/markdown" onChange={(e) => void inspect(e.target.files?.[0])} />
            <span className="drop-title">{file ? file.name : "Choose a document"}</span>
            <span className="drop-hint">Text, Markdown, JPEG, PNG or WebP. PDF is not supported yet.</span>
          </label>
          {working && <p className="muted">Preparing the file…</p>}
          {fileError && <Warn>{fileError}</Warn>}
          {prepared && digest && cid && (
            <>
              <p className="field-label">Content digest (what the record stores)</p>
              <code className="digest">{digest}</code>
              <p className="field-label">CID</p>
              <code className="digest" data-testid="cid">{cid}</code>
            </>
          )}
          <div className="actions">
            <button className="primary" disabled={!prepared} onClick={() => setStep(3)}>Continue <span>→</span></button>
          </div>
        </Card>
      )}

      {step === 3 && prepared && (
        <Card title="Metadata review" subtitle="Compare what was in the file with what will be published. Nothing else leaves the browser.">
          <div className="diff">
            <div>
              <p className="field-label">Found in your file</p>
              {prepared.metadata ? (
                <ul className="rows">
                  <li><span>EXIF (may include GPS)</span><code className="mono">{prepared.metadata.found.exif ? "present" : "none"}</code></li>
                  <li><span>XMP</span><code className="mono">{prepared.metadata.found.xmp ? "present" : "none"}</code></li>
                </ul>
              ) : <p className="muted small">Text files are normalised (line endings, Unicode NFC). No metadata fields exist to remove.</p>}
            </div>
            <div>
              <p className="field-label">Published</p>
              {prepared.metadata ? (
                <ul className="rows">
                  <li><span>EXIF</span>{prepared.metadata.removed.includes("exif") ? <span className="redaction" aria-label="removed">removed</span> : <code className="mono">none to remove</code>}</li>
                  <li><span>XMP</span>{prepared.metadata.removed.includes("xmp") ? <span className="redaction" aria-label="removed">removed</span> : <code className="mono">none to remove</code>}</li>
                </ul>
              ) : <p className="muted small">Normalised text</p>}
            </div>
          </div>
          <ul className="warnings">{prepared.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
          <Warn>We can't remove printer dots or details in the content itself. Read the document before you post it.</Warn>
          <label className="check">
            <input type="checkbox" checked={reviewed} onChange={(e) => setReviewed(e.target.checked)} />
            <span>I have read the document and understand what remains in it.</span>
          </label>
          <div className="actions">
            <button className="primary" disabled={!reviewed} onClick={() => setStep(4)}>Continue <span>→</span></button>
          </div>
        </Card>
      )}

      {step === 4 && view && (
        <Card title="Anonymity set" subtitle="A verifier learns that one member of this group posted, not who.">
          <p className="anon-line"><strong>Posted by 1 of {sizeNow}</strong> members of group {view.groupId.toString()}</p>
          {mock && <Warn>This deployment uses a mock verifier, so "1 of {sizeNow}" is the size of the group, not something the record will prove.</Warn>}
          {sizeNow < view.minSize ? (
            <Warn>The group has {sizeNow} members and needs at least {view.minSize}. Posting is blocked until the issuer adds members.</Warn>
          ) : (
            <p className="small muted">Joining and posting close together narrows the set in practice. Wait for more members to join before you post.</p>
          )}
          {view.error && <Warn>{view.error}. This group's root does not match the chain, so posting is blocked.</Warn>}
          {blocker && <Warn>{blocker} Nothing is uploaded until this is resolved.</Warn>}
          <div className="actions">
            <button className="primary" disabled={sizeNow < view.minSize || !view.rootMatches || !!blocker} onClick={() => setStep(5)}>Continue <span>→</span></button>
          </div>
        </Card>
      )}

      {step === 5 && prepared && cid && (
        <Card title="Publish the document" subtitle="The stripped document goes to your pinners now, before the record is posted, so readers can fetch it. Pinners (and anyone watching the network) see the content and your upload.">
          <p className="field-label">Pinners ({pinners.fromDefaults ? "local defaults, not saved" : "from Settings"})</p>
          {pinners.endpoints.length === 0 ? (
            <Warn>No pinner is configured for this deployment. Add at least one in Settings. Posting is blocked until the document is pinned.</Warn>
          ) : (
            <ul className="rows">
              {pinners.endpoints.map((e) => {
                const r = pinResult?.cid === cid ? pinResult.results.find((x) => x.endpointId === e.id) : undefined;
                return (
                  <li key={e.id} data-pinner={e.id}>
                    <span className="small">{describeEndpoint(e)}</span>
                    {pinning ? <span className="muted small">uploading…</span> : r ? r.ok ? <Tick>pinned</Tick> : <span className="error-text small">{r.error}</span> : <span className="muted small">not uploaded</span>}
                  </li>
                );
              })}
            </ul>
          )}
          <p className="small muted">Required: {minPins} pin{minPins === 1 ? "" : "s"}.</p>
          {pinners.endpoints.length === 1 && (
            <>
              <Warn>Only one pinner is configured. If it goes offline, the document is gone for readers; the bundle you download at the end is then the only copy. Add a second pinner in Settings for redundancy.</Warn>
              <label className="check">
                <input type="checkbox" checked={acceptSingle} onChange={(e) => setAcceptSingle(e.target.checked)} />
                <span>I accept posting with a single pin.</span>
              </label>
            </>
          )}
          {pinError && <Warn>{pinError}</Warn>}
          {pinResult && pinResult.cid === cid && !pinsOk && <Warn>Only {pinResult.pinned} of the required {minPins} pins succeeded. Posting is blocked. Fix the failing endpoint (see the message above) and upload again.</Warn>}
          {pinsOk && pinResult && <p className="small"><Tick>{pinResult.pinned} of {pinners.endpoints.length} pinner{pinners.endpoints.length === 1 ? "" : "s"} {pinResult.pinned === 1 ? "holds" : "hold"} the document</Tick></p>}
          <div className="actions">
            <button
              className="secondary"
              disabled={pinning || !gate.ok || pinners.endpoints.length === 0 || (pinners.endpoints.length === 1 && !acceptSingle)}
              onClick={() => void pin()}
            >
              {pinning ? "Uploading…" : pinResult ? "Upload again" : "Upload to pinners"}
            </button>
            <button className="primary" disabled={!pinsOk} onClick={() => setStep(6)}>Continue <span>→</span></button>
          </div>
        </Card>
      )}

      {step === 6 && view && (
        <Card title="Post" subtitle={transport === "frame" ? "Frame transaction path (EIP-8141). Unverified against the devnet." : "This is a direct transaction from the account you enter below."}>
          {mock && <Warn><strong>Mock proof.</strong> This deployment ({deployment.label}) uses a verifier that accepts any proof. The record will not show that a group member posted it, and readers will see "Mock proof", not a verification.</Warn>}
          <fieldset className="radio-group">
            <legend className="field-label">Transaction</legend>
            <label className="check">
              <input type="radio" name="transport" checked={transport === "direct"} onChange={() => updatePrefs({ transport: "direct" })} />
              <span><strong>Direct transaction</strong><br /><span className="small muted">Sent from the key below. The poster address is visible on chain. Use a throwaway dev key.</span></span>
            </label>
            <label className={`check ${frame.ok ? "" : "disabled"}`}>
              <input type="radio" name="transport" disabled={!frame.ok} checked={transport === "frame"} onChange={() => updatePrefs({ transport: "frame" })} />
              <span>
                <strong>Frame transaction (EIP-8141), UNVERIFIED</strong><br />
                <span className="small muted">{frame.ok ? `Fan-out to ${frame.sidecars.length} sidecar${frame.sidecars.length === 1 ? "" : "s"}. Never run against a devnet by this build.` : `Unavailable: ${frame.reason}`}</span>
              </span>
            </label>
          </fieldset>
          <p className="small muted">
            Before sending: a random delay of 0 to {settings.maxDelayMinutes} min{settings.skipRandomDelay ? " (currently skipped in Settings)" : ""}, with a visible countdown and a Cancel button.
          </p>
          {blocker && <Warn>{blocker}</Warn>}
          {transport === "direct" && (
            <label className="field">
              <span className="field-label">Dev account private key (in memory only, never saved)</span>
              <input type="password" autoComplete="off" spellCheck={false} value={anvilKey} onChange={(e) => setAnvilKey(e.target.value)} placeholder="0x…" aria-label="Dev account private key" />
              {anvilKey && !keyValid && <span className="small warning-text">Expected 0x followed by 64 hex characters.</span>}
            </label>
          )}
          {postError && <Warn>{postError}</Warn>}
          <div className="actions">
            <button className="secondary" onClick={() => setStep(5)}>Back</button>
            <button
              className="primary"
              disabled={posting || !gate.ok || !!blocker || (transport === "direct" && !keyValid) || !pinsOk || !caseId || !digest}
              onClick={() => void post()}
            >
              {posting ? "Working…" : "Post"} <span>→</span>
            </button>
          </div>
        </Card>
      )}

      {step === 7 && (
        <Card title="Timeline" subtitle="Each step is a real check. Nothing is marked done before it finishes.">
          {timeline && <TxTimeline steps={timeline} />}
          {delayActive && (
            <div className="actions tight">
              <button className="secondary" onClick={() => abortRef.current?.abort()}>Cancel</button>
              <span className="small muted">Nothing has been sent to the chain yet.</span>
            </div>
          )}
          {postError && <Warn>{postError}</Warn>}
          {done && (
            <div className="result-box" data-testid="result">
              <p className="anon-line"><Tick>Recorded</Tick></p>
              {done.mock && <Warn>This was recorded with a MOCK proof. It shows the document was posted; it does not show that a group member posted it.</Warn>}
              {done.transport === "direct" && <p className="small warning-text">The poster address is visible on chain for this transaction.</p>}
              <p className="field-label">Share link</p>
              <code className="digest" data-testid="share-link">{shareLink(done.cid)}</code>
              <div className="actions tight"><CopyButton text={shareLink(done.cid)} label="Copy link" /><a className="brass-link" href={`#/d/${done.cid}`}>Open the reader view <span>→</span></a></div>
              <p className="field-label">Transaction</p>
              <code className="digest" data-testid="tx-hash">{done.txHash}</code>
              <p className="small mono muted">Block {done.blockNumber.toString()} · {deployment.label}, no explorer configured</p>
              <p className="field-label">Proof bundle</p>
              <p className="small muted">A .zerodrop.json file with the record and the document inside. Anyone can check the document offline with it, even if every pinner is gone.{done.mock ? " Its proof mode is mock." : ""}</p>
              <div className="actions tight">
                <button className="secondary" onClick={() => download(`${done.cid.slice(0, 16)}.zerodrop.json`, done.bundleJson, "application/json")}>Download bundle (.zerodrop.json)</button>
              </div>
            </div>
          )}
          {!posting && (
            <div className="actions">
              {!done && <button className="secondary" onClick={() => setStep(6)}>Back to post</button>}
              {done && <button className="secondary" onClick={() => { setStep(1); setFile(undefined); setPrepared(undefined); setPinResult(undefined); setDone(undefined); setTimeline(undefined); }}>Post another</button>}
            </div>
          )}
        </Card>
      )}
    </section>
  );
}

function SummaryRow({ label, value, onEdit }: { label: string; value: string; onEdit: () => void }) {
  return (
    <div className="summary-row">
      <span className="small muted">{label}</span>
      <span className="summary-value">{value}</span>
      <button className="link-button" onClick={onEdit}>Change</button>
    </div>
  );
}
