import { useEffect, useState, type FormEvent } from "react";
import { prepareDocument, UnsupportedMediaError, type InclusionResult } from "@zerodrop/core";
import { parseCidDigest } from "../lib/adapter";
import { LOCAL } from "../lib/config";
import { anonymitySetFor, checkContent, checkInclusion, checkProof, type DisclosureReading, type Layer } from "../lib/verify";
import { Tick, short } from "./Shell";

type Props = { reference: string };

type Reading = {
  phase: "loading" | "done";
  l1?: InclusionResult;
  l2?: Layer;
  anonymity?: DisclosureReading["anonymity"];
  error?: string;
};

export function ReaderPage({ reference }: Props) {
  const parsed = parseCidDigest(reference);
  const digest = parsed.digest;
  const [reading, setReading] = useState<Reading>({ phase: "loading" });
  const [draft, setDraft] = useState(reference);
  const [l0, setL0] = useState<Layer>();
  const [l0Note, setL0Note] = useState<string>();

  useEffect(() => {
    if (!digest) return;
    let cancelled = false;
    setReading({ phase: "loading" });
    (async () => {
      try {
        const l1 = await checkInclusion(digest);
        if (cancelled) return;
        if (!l1.ok) return setReading({ phase: "done", l1 });
        const l2 = await checkProof(digest, l1);
        const anonymity =
          l1.groupId !== undefined && l1.root !== undefined ? await anonymitySetFor(l1.groupId, l1.root) : undefined;
        if (!cancelled) setReading({ phase: "done", l1, l2, anonymity });
      } catch (error) {
        if (!cancelled) setReading({ phase: "done", error: error instanceof Error ? error.message : String(error) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [digest]);

  async function checkFile(file?: File) {
    setL0(undefined);
    setL0Note(undefined);
    if (!file || !digest) return;
    try {
      const prepared = await prepareDocument(file);
      setL0(checkContent(prepared.bytes, digest));
      setL0Note("Compares the prepared bytes (line endings, metadata stripped). Image re-encoding depends on the browser, so a file re-encoded elsewhere may not match.");
    } catch (error) {
      setL0({ ok: false, reason: error instanceof UnsupportedMediaError ? error.message : String(error) });
    }
  }

  function open(event: FormEvent) {
    event.preventDefault();
    window.location.hash = `#/d/${draft.trim()}`;
  }

  if (!digest) {
    return (
      <section className="reader">
        <p className="eyebrow">Reader</p>
        <h1 className="page-title">Open a disclosure</h1>
        <p className="lede">{parsed.reason}</p>
        <form className="lookup" onSubmit={open}>
          <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="CIDv1 (b…) or 0x digest" aria-label="CID or digest" />
          <button className="primary" type="submit">Open</button>
        </form>
      </section>
    );
  }

  const l1 = reading.l1;
  const l2 = reading.l2;
  const size = reading.anonymity && "size" in reading.anonymity ? reading.anonymity.size : undefined;
  const minSize = reading.anonymity && "minSize" in reading.anonymity ? reading.anonymity.minSize : undefined;

  return (
    <section className="reader">
      <p className="eyebrow">Reader</p>
      <h1 className="page-title">Disclosure</h1>
      <p className="mono small muted reader-ref">{digest}</p>

      <div className="verify card raised">
        <h2>Verification</h2>
        <p className="small muted card-sub">Three checks, in order. A tick means that check passed in this browser.</p>

        <ol className="ticks">
          <li className={`tick ${l0?.ok ? "ok" : l0 ? "bad" : "pending"}`}>
            <span className="tick-num mono">1</span>
            <div>
              <strong>L0 Content</strong>
              <p className="small">{l0 ? (l0.ok ? <Tick>{l0.reason}</Tick> : <span className="error-text">{l0.reason}</span>) : "Pending. Choose the document to check it against the digest."}</p>
              <input className="file-input" type="file" onChange={(e) => void checkFile(e.target.files?.[0])} aria-label="Document to check" />
              {l0Note && <p className="small muted">{l0Note}</p>}
            </div>
          </li>
          <li className={`tick ${l1 ? (l1.ok ? "ok" : "bad") : "pending"}`}>
            <span className="tick-num mono">2</span>
            <div>
              <strong>L1 Inclusion</strong>
              <p className="small">{reading.phase === "loading" ? "Reading the chain…" : l1?.ok ? <Tick>{`Recorded in block ${l1.blockNumber?.toString()}`}</Tick> : <span className="error-text">{l1?.reason ?? reading.error}</span>}</p>
              {l1?.ok && <p className="small muted">{l1.reason}</p>}
              <p className="small muted">Trust: agreement of RPC endpoints, not eth_getProof. The app reads the record, the Disclosed log and the block hash from {LOCAL.rpcUrl} only, so the trust is one endpoint with no cross-check.</p>
            </div>
          </li>
          <li className={`tick ${l2 ? (l2.ok ? "ok" : "bad") : "pending"}`}>
            <span className="tick-num mono">3</span>
            <div>
              <strong>L2 Membership proof</strong>
              <p className="small">
                {!l1?.ok ? "Not checked. Needs L1." : !l2 ? "Checking…" : l2.ok ? <Tick>{l2.reason}</Tick> : <span className="error-text">{l2.reason}</span>}
              </p>
              {l2?.ok && <p className="small muted">Checked offline with the verification key bundled in the app. The proof is bound to this digest, group and case.</p>}
            </div>
          </li>
        </ol>
      </div>

      {l1?.ok && (
        <div className="card">
          <h2>Record</h2>
          <ul className="rows">
            <li><span>Group</span><code className="mono">{l1.groupId?.toString()}</code></li>
            <li><span>Case</span><code className="mono">{short(l1.caseId ?? "", 14, 8)}</code></li>
            <li><span>Root</span><code className="mono">{short(`0x${(l1.root ?? 0n).toString(16)}`, 14, 8)}</code></li>
            <li><span>Block</span><code className="mono">{l1.blockNumber?.toString()}</code></li>
            <li><span>Block hash</span><code className="mono">{short(l1.blockHash ?? "", 14, 8)}</code></li>
            <li><span>Explorer</span><span className="muted small">None configured for chain {LOCAL.chainId}</span></li>
          </ul>
          <p className="anon-line">
            {size !== undefined ? <><strong>Posted by 1 of {size}</strong> members of group {l1.groupId?.toString()}</> : reading.anonymity && "error" in reading.anonymity ? <span className="warning-text">{reading.anonymity.error}</span> : "Counting members…"}
          </p>
          {size !== undefined && minSize !== undefined && size < minSize && (
            <div className="warn"><span className="warn-dot" aria-hidden="true" />The group had {size} members at this root, below its minimum of {minSize}. Treat the anonymity as weak.</div>
          )}
          <p className="small muted">Nullifier <code className="mono">{short(`0x${(l1.nullifier ?? 0n).toString(16)}`, 12, 6)}</code>. It is not an identity.</p>
        </div>
      )}

      <div className="card">
        <h2>Content</h2>
        <p className="small muted">The document itself is not fetched in this build. Publication through PressProtocol and other pinners is not integrated, so choose the file to run L0.</p>
      </div>
    </section>
  );
}
