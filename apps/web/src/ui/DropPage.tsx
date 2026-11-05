import { useEffect, useState, type ReactNode } from "react";
import { cidFor, commitmentHex, createIdentity, digestOf, prepareDocument, UnsupportedMediaError, type PreparedDocument } from "@zerodrop/core";
import { keccak256, toHex, type Hex } from "viem";
import { hasArtifacts, ARTIFACTS_MISSING_MESSAGE } from "../lib/artifacts";
import { DEVNET } from "../lib/config";
import { loadGroups, readClient, type GroupView } from "../lib/chain";
import { persistIdentity, type Identity } from "../lib/session";
import { DIRECT_STEPS, postDirect, postFrame, type PostStep } from "../lib/post";
import { Tick, short } from "./Shell";

export type TransportChoice = "direct" | "frame";

type Props = {
  identity: Identity | undefined;
  setIdentity: (identity: Identity) => void;
  identityChecked: boolean;
  transport: TransportChoice;
};

const STEPS = ["Identity", "Group and case", "File", "Metadata", "Anonymity set", "Post", "Timeline"] as const;
const PRIVATE_KEY = /^0x[0-9a-fA-F]{64}$/;

export function DropPage({ identity, setIdentity, identityChecked, transport }: Props) {
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

  // Post
  const [anvilKey, setAnvilKey] = useState("");
  const [postSteps, setPostSteps] = useState<PostStep[]>();
  const [postError, setPostError] = useState<string>();
  const [posting, setPosting] = useState(false);
  const [result, setResult] = useState<{ txHash: string; blockNumber: bigint; digest: Hex }>();
  const [frameResult, setFrameResult] = useState<{ accepted: boolean; results: Array<{ url: string; ok: boolean; error?: string }> }>();

  const caseId = caseLabel.trim() ? keccak256(toHex(caseLabel.trim())) : undefined;
  const view = groups?.find((g) => g.groupId === groupId);
  const isMember = !!(identity && view && view.commitments.some((c) => c === identity.commitment));
  const digest = prepared ? digestOf(prepared.bytes) : undefined;
  const cid = prepared ? cidFor(prepared.bytes) : undefined;

  useEffect(() => {
    if (!identity) return;
    void refreshGroups();
  }, [identity]);

  async function refreshGroups() {
    setGroupError(undefined);
    try {
      setGroups(await loadGroups(readClient()));
    } catch (error) {
      setGroupError(error instanceof Error ? error.message : String(error));
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
          : error instanceof Error ? error.message : String(error),
      );
    } finally {
      setWorking(false);
    }
  }

  async function post() {
    if (!identity || !view || !caseId || !digest || !prepared || !cid) return;
    setPosting(true);
    setPostError(undefined);
    setFrameResult(undefined);
    setResult(undefined);
    setPostSteps(DIRECT_STEPS);
    setStep(6);
    try {
      if (transport === "frame") {
        setPostSteps(undefined);
        setFrameResult(await postFrame({ identity, view, caseId, cidDigest: digest }));
      } else {
        const outcome = await postDirect({
          identity,
          view,
          caseId,
          cidDigest: digest,
          anvilKey: anvilKey.trim() as Hex,
          onStep: setPostSteps,
        });
        setResult({ txHash: outcome.txHash, blockNumber: outcome.blockNumber, digest });
        setAnvilKey("");
      }
    } catch (error) {
      setPostError(error instanceof Error ? error.message : String(error));
    } finally {
      setPosting(false);
    }
  }

  const sizeNow = view?.commitments.length ?? 0;
  const artifactsReady = view ? hasArtifacts(view.depth) : false;
  const keyValid = PRIVATE_KEY.test(anvilKey.trim());

  return (
    <section className="drop" aria-labelledby="drop-title">
      <p className="eyebrow">Source</p>
      <h1 id="drop-title" className="page-title">Post a document</h1>
      <p className="lede">Your identity proves you belong to a group. The record shows the document, the group and the case. It never shows which member posted it.</p>

      <ol className="stepper" aria-label="Steps">
        {STEPS.map((label, i) => (
          <li key={label} className={i === step ? "current" : i < step ? "done" : ""}>
            <span className="step-num mono">{i + 1}</span>{label}
          </li>
        ))}
      </ol>

      {step > 0 && step <= 5 && (
        <div className="summary-list">
          {step > 0 && identity && <SummaryRow label="Identity" value={`commitment ${short(commitmentHex(identity), 12, 8)}`} onEdit={() => setStep(0)} />}
          {step > 1 && view && <SummaryRow label="Group and case" value={`Group ${view.groupId} · case "${caseLabel.trim()}"`} onEdit={() => setStep(1)} />}
          {step > 2 && file && <SummaryRow label="File" value={`${file.name} · ${formatBytes(prepared?.bytes.byteLength ?? 0)}`} onEdit={() => setStep(2)} />}
          {step > 3 && <SummaryRow label="Metadata" value={prepared?.metadata?.removed.length ? `Removed ${prepared.metadata.removed.join(", ").toUpperCase()}` : "Reviewed"} onEdit={() => setStep(3)} />}
          {step > 4 && <SummaryRow label="Anonymity set" value={`1 of ${sizeNow} members`} onEdit={() => setStep(4)} />}
        </div>
      )}

      {step === 0 && (
        <Card title="Your identity" subtitle="A Semaphore identity, created in this browser. Its commitment is the public value the issuer adds to a group.">
          {!identityChecked && <p className="muted">Checking for a saved identity…</p>}
          {identityChecked && !identity && (
            <>
              <p>No identity yet.</p>
              <button className="primary" onClick={() => void createNewIdentity()}>Create identity</button>
            </>
          )}
          {identity && (
            <>
              <p className="field-label">Commitment (give this to the issuer)</p>
              <code className="digest">{commitmentHex(identity)}</code>
              {saved === false && <Warn>This browser refused to save the identity. Export a backup from Settings before you leave the page.</Warn>}
              {saved !== false && <p className="muted small">Saved in this browser's IndexedDB as an unencrypted key. Anyone with access to this browser profile can read it. Export an encrypted backup from Settings.</p>}
              <div className="actions"><button className="primary" onClick={() => setStep(1)}>Continue <span>→</span></button></div>
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
        <Card title="The document" subtitle="The file stays in this browser. Nothing is uploaded at this step.">
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
              <code className="digest">{cid}</code>
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
          {sizeNow < view.minSize ? (
            <Warn>The group has {sizeNow} members and needs at least {view.minSize}. Posting is blocked until the issuer adds members.</Warn>
          ) : (
            <p className="small muted">Joining and posting close together narrows the set in practice. Wait for more members to join before you post.</p>
          )}
          {view.error && <Warn>{view.error}. This group's root does not match the chain, so posting is blocked.</Warn>}
          <div className="actions">
            <button className="primary" disabled={sizeNow < view.minSize || !view.rootMatches} onClick={() => setStep(5)}>Continue <span>→</span></button>
          </div>
        </Card>
      )}

      {step === 5 && view && (
        <Card title="Post" subtitle={transport === "frame" ? "Frame transaction path (EIP-8141). Unverified against the devnet." : "This is a direct transaction from the account you enter below."}>
          <Warn>
            {transport === "frame"
              ? "The frame path is not verified against the devnet. It is not the default."
              : "The poster address is visible on chain. Use a throwaway dev key. This build cannot hide it."}
          </Warn>
          {!artifactsReady && <Warn>{ARTIFACTS_MISSING_MESSAGE}. Posting is blocked until the Semaphore depth {view.depth} files are in apps/web/public/zk/.</Warn>}
          {transport === "direct" && (
            <label className="field">
              <span className="field-label">Anvil account private key (in memory only, never saved)</span>
              <input type="password" autoComplete="off" spellCheck={false} value={anvilKey} onChange={(e) => setAnvilKey(e.target.value)} placeholder="0x…" />
              {anvilKey && !keyValid && <span className="small warning-text">Expected 0x followed by 64 hex characters.</span>}
            </label>
          )}
          {postError && <Warn>{postError}</Warn>}
          <div className="actions">
            <button
              className="primary"
              disabled={posting || !artifactsReady || (transport === "direct" && !keyValid) || !prepared || !caseId || !digest}
              onClick={() => void post()}
            >
              {posting ? "Working…" : "Prove and post"} <span>→</span>
            </button>
          </div>
        </Card>
      )}

      {step === 6 && (
        <Card title="Timeline" subtitle="Each step is a real check. Nothing is marked done before it finishes.">
          {postSteps && (
            <ol className="timeline">
              {postSteps.map((s) => (
                <li key={s.id} className={`tl ${s.status}`}>
                  <span className="tl-mark" aria-hidden="true">{s.status === "done" ? "✓" : s.status === "error" ? "!" : s.status === "active" ? "…" : "·"}</span>
                  <div><strong>{s.label}</strong>{s.detail && <p className="small mono muted">{s.detail}</p>}</div>
                </li>
              ))}
            </ol>
          )}
          {postError && <Warn>{postError}</Warn>}
          {result && (
            <div className="result-box">
              <p className="field-label">Transaction</p>
              <code className="digest">{result.txHash}</code>
              <p className="small mono muted">Block {result.blockNumber.toString()} · local anvil, no explorer configured</p>
              <p><a className="brass-link" href={`#/d/${result.digest}`}>Open the reader view <span>→</span></a></p>
            </div>
          )}
          {frameResult && (
            <div className="result-box">
              <p className="field-label">Frame submission (unverified)</p>
              <ul className="rows">
                {frameResult.results.map((r) => (
                  <li key={r.url}><span className="mono small">{r.url}</span><span className={r.ok ? "verified" : "error-text"}>{r.ok ? "accepted" : r.error ?? "rejected"}</span></li>
                ))}
              </ul>
            </div>
          )}
          {!postSteps && !frameResult && !postError && <p className="muted">Nothing sent yet.</p>}
          {!posting && (
            <div className="actions">
              <button className="secondary" onClick={() => setStep(5)}>Back to post</button>
              {DEVNET.sidecarUrls.length === 0 && transport === "frame" && <span className="small muted">No sidecars configured in config/devnet.json.</span>}
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

function Card({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return (
    <div className="card raised">
      <h2>{title}</h2>
      <p className="muted small card-sub">{subtitle}</p>
      {children}
    </div>
  );
}

function Warn({ children }: { children: ReactNode }) {
  return <div className="warn"><span className="warn-dot" aria-hidden="true" />{children}</div>;
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}
