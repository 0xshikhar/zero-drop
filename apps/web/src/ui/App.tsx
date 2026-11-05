import { useState } from "react";
import type { PreparedDocument } from "@zerodrop/core";
import { prepareDocument, sha256 } from "@zerodrop/core";

type Props = { proof: { label: string; verified: boolean } };

export function App({ proof }: Props) {
  const [file, setFile] = useState<File>();
  const [prepared, setPrepared] = useState<PreparedDocument>();
  const [digest, setDigest] = useState<string>();
  const [working, setWorking] = useState(false);

  async function inspect(next?: File) {
    setFile(next);
    setPrepared(undefined);
    setDigest(undefined);
    if (!next) return;
    setWorking(true);
    try {
      const result = await prepareDocument(next);
      setPrepared(result);
      setDigest(await sha256(result.bytes));
    } finally {
      setWorking(false);
    }
  }

  return (
    <main className="shell">
      <header className="topbar"><a className="wordmark" href="#">ZeroDrop<span> / </span>disclosures</a><span className="network-label">LOCAL PROTOTYPE</span></header>
      <section className="hero">
        <p className="eyebrow">A safer way to speak up</p>
        <h1>Leak the document,<br /><em>not yourself.</em></h1>
        <div className="hairline" />
        <p className="lede">ZeroDrop is being built for people who need to share evidence without attaching a wallet or identity to the act of publishing.</p>
        <div className="callout"><span className="callout-mark">i</span><p><strong>Early prototype.</strong> This build prepares a local file fingerprint. Anonymous publishing, onchain verification, and Tor transport are not connected yet.</p></div>
      </section>

      <section className="workbench" aria-labelledby="drop-title">
        <div className="section-heading"><div><p className="eyebrow">Source workspace</p><h2 id="drop-title">Prepare a document</h2></div><span className="step">01 <span>/ 04</span></span></div>
        <div className="panel">
          <label className="dropzone">
            <input type="file" onChange={(event) => void inspect(event.target.files?.[0])} />
            <span className="file-icon">＋</span>
            <span className="drop-title">{file ? file.name : "Choose a document"}</span>
            <span className="drop-hint">Text, Markdown, PDF, or image · stays in this browser</span>
          </label>
          {working && <p className="muted">Preparing a local fingerprint…</p>}
          {prepared && <div className="result">
            <div className="result-head"><span>File review</span><span className="mock-badge">No upload performed</span></div>
            <p className="filename">{file?.name} <span>{formatBytes(prepared.bytes.byteLength)}</span></p>
            <p className="field-label">SHA-256 fingerprint</p><code className="digest">{digest}</code>
            <ul className="warnings">{prepared.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
            <button className="primary" disabled>Continue to group selection <span>→</span></button>
            <p className="disabled-note">Posting is not available in this prototype.</p>
          </div>}
        </div>
      </section>

      <aside className="prototype-note"><span className="status-dot" /><div><strong>{proof.label}</strong><p>{proof.verified ? "Membership verification is enabled." : "Membership proofs are not enabled. This build never marks a disclosure as verified."}</p></div></aside>
      <footer><span>ZeroDrop</span><span>Alt-mempool devnet · chain 1337 target</span></footer>
    </main>
  );
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}
