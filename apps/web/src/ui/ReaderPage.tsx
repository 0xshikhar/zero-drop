import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  base64ToBytes,
  BundleError,
  keepOnline,
  parseBundle,
  prepareDocument,
  UnsupportedMediaError,
  verifyBundleOffline,
  verifyDisclosureProof,
  type BundleVerification,
  type InclusionResult,
  type PinnerEndpoint,
  type ProofBundle,
} from "@zerodrop/core";
import { parseCidDigest } from "../lib/adapter";
import { activeDeployment, useDeployment, useSettings } from "../lib/prefs";
import { networkGate, useBootState, useNetworkPlan } from "../lib/network";
import { describeEndpoint, effectivePinners, probeHolders, type HolderProbe } from "../lib/pinners";
import { anonymitySetFor, checkContent, checkInclusion, checkProof, l1Endpoints, type DisclosureReading, type Layer } from "../lib/verify";
import { cidFromDigest, download, errorMessage, short, sniff } from "../lib/util";
import { navigate, readerHref } from "../lib/router";
import { Card, MockMark, Tick, Warn } from "./common";

type Props = { reference: string };

type Reading = {
  phase: "loading" | "done";
  l1?: InclusionResult;
  l2?: Layer;
  anonymity?: DisclosureReading["anonymity"];
  error?: string;
};

type Doc = { bytes: Uint8Array; source: "pinner" | "file" | "bundle"; sourceLabel: string };

export function ReaderPage({ reference }: Props) {
  const deployment = useDeployment();
  const settings = useSettings();
  const plan = useNetworkPlan();
  const boot = useBootState();
  const gate = networkGate(plan, boot);

  const [bundle, setBundle] = useState<ProofBundle>();
  const [bundleCheck, setBundleCheck] = useState<BundleVerification>();
  const [bundleError, setBundleError] = useState<string>();

  const refText = reference || bundle?.cid || "";
  const parsed = parseCidDigest(refText);
  const digest = parsed.digest;
  const cid = digest ? (refText.startsWith("b") ? refText : cidFromDigest(digest)) : undefined;

  const [reading, setReading] = useState<Reading>({ phase: "loading" });
  const [draft, setDraft] = useState(reference);
  const [doc, setDoc] = useState<Doc>();
  const [probe, setProbe] = useState<HolderProbe>();
  const [resolving, setResolving] = useState(false);
  const [fileLayer, setFileLayer] = useState<Layer>();
  const [fileNote, setFileNote] = useState<string>();

  const pinners = effectivePinners(settings, deployment);
  const pinnerKey = JSON.stringify(pinners.endpoints);
  const rpcKey = settings.rpcUrls.join(",") + String(settings.directRpcForReader) + deployment?.id;

  // Resolve the document from the pinners.
  useEffect(() => {
    if (!cid || !gate.ok) return;
    const controller = new AbortController();
    setResolving(true);
    setProbe(undefined);
    probeHolders(cid, pinners.endpoints, controller.signal)
      .then((p) => {
        if (controller.signal.aborted) return;
        setProbe(p);
        if (p.bytes) setDoc((prev) => prev ?? { bytes: p.bytes!, source: "pinner", sourceLabel: p.source ?? "pinner" });
      })
      .catch(() => undefined)
      .finally(() => {
        if (!controller.signal.aborted) setResolving(false);
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cid, pinnerKey, gate.ok]);

  // L1, L2 and the anonymity set, from the chain.
  useEffect(() => {
    if (!digest || !gate.ok) return;
    let cancelled = false;
    setReading({ phase: "loading" });
    (async () => {
      try {
        const l1 = await checkInclusion(digest);
        if (cancelled) return;
        if (!l1.ok) return setReading({ phase: "done", l1 });
        const l2 = await checkProof(digest, l1);
        const anonymity = l1.groupId !== undefined && l1.root !== undefined ? await anonymitySetFor(l1.groupId, l1.root) : undefined;
        if (!cancelled) setReading({ phase: "done", l1, l2, anonymity });
      } catch (error) {
        if (!cancelled) setReading({ phase: "done", error: errorMessage(error) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [digest, rpcKey, gate.ok]);

  async function checkFile(file?: File) {
    setFileLayer(undefined);
    setFileNote(undefined);
    if (!file || !digest) return;
    try {
      const prepared = await prepareDocument(file);
      const layer = checkContent(prepared.bytes, digest);
      setFileLayer(layer);
      setFileNote("Compares the prepared bytes (line endings, metadata stripped). Image re-encoding depends on the browser, so a file re-encoded elsewhere may not match.");
      if (layer.ok) setDoc({ bytes: prepared.bytes, source: "file", sourceLabel: file.name });
    } catch (error) {
      setFileLayer({ ok: false, reason: error instanceof UnsupportedMediaError ? error.message : errorMessage(error) });
    }
  }

  async function loadBundle(file?: File) {
    setBundle(undefined);
    setBundleCheck(undefined);
    setBundleError(undefined);
    if (!file) return;
    try {
      const parsedBundle = parseBundle(await file.text());
      if (reference && parseCidDigest(reference).digest?.toLowerCase() !== parsedBundle.digest.toLowerCase()) {
        setBundleError(`This bundle is for ${short(parsedBundle.cid, 14, 6)}, not for the document you opened.`);
        return;
      }
      setBundle(parsedBundle);
      setBundleCheck(await verifyBundleOffline(parsedBundle, { verifyProof: verifyDisclosureProof }));
      if (parsedBundle.bytesBase64) {
        setDoc({ bytes: base64ToBytes(parsedBundle.bytesBase64), source: "bundle", sourceLabel: file.name });
      }
    } catch (error) {
      setBundleError(error instanceof BundleError ? error.message : errorMessage(error));
    }
  }

  function open(event: FormEvent) {
    event.preventDefault();
    navigate(readerHref(draft.trim()));
  }

  const bundlePicker = (
    <Card title="Open a proof bundle" subtitle="A .zerodrop.json file. Its document hash and proof are checked on this device, with no network." raised={false}>
      <input className="file-input" type="file" accept=".json,application/json" onChange={(e) => void loadBundle(e.target.files?.[0])} aria-label="Proof bundle (.zerodrop.json)" />
      {bundleError && <p className="small error-text">{bundleError}</p>}
      {bundle && bundleCheck && <BundleResult bundle={bundle} check={bundleCheck} />}
    </Card>
  );

  if (!digest) {
    return (
      <section className="reader">
        <p className="eyebrow">Reader</p>
        <h1 className="page-title">Open a disclosure</h1>
        <p className="lede">{reference ? parsed.reason : "Paste a CID or a digest, or open a proof bundle."}</p>
        <form className="lookup" onSubmit={open}>
          <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="CIDv1 (b…) or 0x digest" aria-label="CID or digest" />
          <button className="primary" type="submit">Open</button>
        </form>
        <div className="spacer" />
        {bundlePicker}
      </section>
    );
  }

  const l1 = reading.l1;
  const l2 = reading.l2;
  const mockL2 = l2?.tone === "mock";
  const size = reading.anonymity && "size" in reading.anonymity ? reading.anonymity.size : undefined;
  const minSize = reading.anonymity && "minSize" in reading.anonymity ? reading.anonymity.minSize : undefined;
  const d = activeDeployment();

  // L0: the document that was actually obtained, hashed here.
  const l0: Layer | undefined = doc ? checkContent(doc.bytes, digest) : fileLayer;
  const endpointCount = l1Endpoints();
  const bundleOnOtherDeployment = !!(bundle && d && d.zeroDrop && (bundle.chainId !== d.chainId || bundle.contract.toLowerCase() !== d.zeroDrop.toLowerCase()));

  return (
    <section className="reader">
      <p className="eyebrow">Reader</p>
      <h1 className="page-title">Disclosure</h1>
      <p className="mono small muted reader-ref">{digest}</p>
      {!gate.ok && <Warn>{gate.message}</Warn>}
      {bundleOnOtherDeployment && <Warn>This bundle is for chain {bundle!.chainId} at {short(bundle!.contract, 10, 6)}, not the active deployment. The chain checks below read the active deployment and will not find it.</Warn>}

      <Card title="Document" subtitle="Fetched by CID from your pinners. Only bytes whose sha256 matches the CID are accepted.">
        {resolving && <p className="muted small">Asking {pinners.endpoints.length} pinner{pinners.endpoints.length === 1 ? "" : "s"}…</p>}
        {!resolving && probe && (
          probe.holders.length > 0 ? (
            <p className="small" data-testid="holders"><Tick>Held by {probe.holders.length} of {pinners.endpoints.length} pinner{pinners.endpoints.length === 1 ? "" : "s"}</Tick> <span className="muted">({probe.holders.join(", ")})</span></p>
          ) : (
            <Warn>
              No pinner returned this document{pinners.endpoints.length === 0 ? " (none is configured: add one in Settings)" : ""}. {probe.failures.map((f) => `${f.id}: ${f.error}`).join("; ")}
              {probe.wrong.length > 0 && ` ${probe.wrong.join(", ")} returned wrong bytes, which were rejected.`} You can still check a local copy or open a bundle below.
            </Warn>
          )
        )}
        {doc && (l0?.ok ? <DocView bytes={doc.bytes} cid={cid!} /> : <Warn>These bytes do not hash to the recorded digest, so they are not shown.</Warn>)}
        {doc && <p className="small muted">Source: {doc.source === "pinner" ? `pinner ${doc.sourceLabel}` : doc.source === "bundle" ? `bundle ${doc.sourceLabel}` : `local file ${doc.sourceLabel}`}</p>}
        {doc && cid && <KeepOnline cid={cid} bytes={doc.bytes} endpoints={pinners.endpoints} holders={probe?.holders ?? []} onKept={(id) => setProbe((p) => (p ? { ...p, holders: [...new Set([...p.holders, id])] } : p))} />}
        <details className="fallback">
          <summary>Use a local file instead</summary>
          <input className="file-input" type="file" onChange={(e) => void checkFile(e.target.files?.[0])} aria-label="Document to check" />
          {fileLayer && !fileLayer.ok && <p className="small error-text">{fileLayer.reason}</p>}
          {fileNote && <p className="small muted">{fileNote}</p>}
        </details>
      </Card>

      <Card title="Verification" subtitle="Three checks, in order. A tick means that check passed in this browser. A diamond means the check could not prove anything.">
        <ol className="ticks">
          <li className={`tick ${l0?.ok ? "ok" : l0 ? "bad" : "pending"}`} data-layer="l0">
            <span className="tick-num mono">1</span>
            <div>
              <strong>L0 Content</strong>
              <p className="small">{l0 ? (l0.ok ? <Tick>{l0.reason}</Tick> : <span className="error-text">{l0.reason}</span>) : resolving ? "Fetching the document…" : "Pending. No document yet: open a bundle or choose a local file."}</p>
            </div>
          </li>
          <li className={`tick ${l1 ? (l1.ok ? "ok" : "bad") : "pending"}`} data-layer="l1">
            <span className="tick-num mono">2</span>
            <div>
              <strong>L1 Inclusion</strong>
              <p className="small">{reading.phase === "loading" ? (gate.ok ? "Reading the chain…" : "Waiting for the network.") : l1?.ok ? <Tick>{`Recorded in block ${l1.blockNumber?.toString()}`}</Tick> : <span className="error-text">{l1?.reason ?? reading.error}</span>}</p>
              {l1?.ok && <p className="small muted">{l1.reason}</p>}
              {l1 && <p className="small muted" data-testid="l1-trust">Read from {endpointCount} RPC endpoint{endpointCount === 1 ? "" : "s"}{endpointCount === 1 ? " (no cross-check)" : ""}{settings.directRpcForReader ? "; Direct RPC for readers is on, so the endpoint sees your IP" : ""}.</p>}
              {l1?.notes.map((n) => <p key={n} className="small muted">{n}</p>)}
            </div>
          </li>
          <li className={`tick ${mockL2 ? "mock" : l2 ? (l2.ok ? "ok" : "bad") : "pending"}`} data-layer="l2">
            <span className="tick-num mono">{mockL2 ? "◇" : "3"}</span>
            <div>
              <strong>L2 Membership proof</strong>
              <p className="small">
                {!l1?.ok ? "Not checked. Needs L1." : !l2 ? "Checking…" : mockL2 ? <MockMark>Mock proof</MockMark> : l2.ok ? <Tick>{l2.reason}</Tick> : <span className="error-text">{l2.reason}</span>}
              </p>
              {mockL2 && <p className="small warning-text">{l2!.reason}</p>}
              {l2?.ok && <p className="small muted">Checked offline with the verification key bundled in the app. The proof is bound to this digest, group and case.</p>}
            </div>
          </li>
        </ol>
      </Card>

      {l1?.ok && (
        <div className="card">
          <h2>Record</h2>
          <ul className="rows">
            <li><span>Group</span><code className="mono">{l1.groupId?.toString()}</code></li>
            <li><span>Case</span><code className="mono">{short(l1.caseId ?? "", 14, 8)}</code></li>
            <li><span>Root</span><code className="mono">{short(`0x${(l1.root ?? 0n).toString(16)}`, 14, 8)}</code></li>
            <li><span>Block</span><code className="mono">{l1.blockNumber?.toString()}</code></li>
            <li><span>Block hash</span><code className="mono">{short(l1.blockHash ?? "", 14, 8)}</code></li>
            <li><span>Deployment</span><span className="muted small">{d?.label}, chain {d?.chainId}. No explorer configured.</span></li>
          </ul>
          <p className="anon-line" data-testid="anon-line">
            {size !== undefined ? <><strong>Posted by 1 of {size}</strong> members of group {l1.groupId?.toString()}</> : reading.anonymity && "error" in reading.anonymity ? <span className="warning-text">{reading.anonymity.error}</span> : "Counting members…"}
          </p>
          {mockL2 && size !== undefined && <p className="small warning-text">That count is the size of the group, not a verified statement: the proof is a mock, so it does not show that a member posted this.</p>}
          {size !== undefined && minSize !== undefined && size < minSize && (
            <Warn>The group had {size} members at this root, below its minimum of {minSize}. Treat the anonymity as weak.</Warn>
          )}
          <p className="small muted">Nullifier <code className="mono">{short(`0x${(l1.nullifier ?? 0n).toString(16)}`, 12, 6)}</code>. It is not an identity.</p>
        </div>
      )}

      {bundlePicker}
    </section>
  );
}

function BundleResult({ bundle, check }: { bundle: ProofBundle; check: BundleVerification }) {
  const l2mock = check.l2.status === "mock";
  return (
    <div className="bundle-result" data-testid="bundle-result">
      <p className="small mono muted">Bundle for {short(bundle.cid, 14, 8)} · chain {bundle.chainId} · block {bundle.blockNumber} · proof mode {bundle.proofMode}</p>
      <ul className="rows">
        <li data-layer="bundle-l0">
          <span>L0 Content</span>
          {check.l0.status === "verified" ? <Tick>{check.l0.reason}</Tick> : check.l0.status === "failed" ? <span className="error-text small">{check.l0.reason}</span> : <span className="muted small">{check.l0.reason}</span>}
        </li>
        <li data-layer="bundle-l2">
          <span>L2 Membership proof</span>
          {l2mock ? <MockMark>Mock proof — not verified</MockMark> : check.l2.status === "verified" ? <Tick>{check.l2.reason}</Tick> : check.l2.status === "failed" ? <span className="error-text small">{check.l2.reason}</span> : <span className="muted small">{check.l2.reason}</span>}
        </li>
      </ul>
      {check.notes.map((n) => <p key={n} className="small muted">{n}</p>)}
    </div>
  );
}

/** An object URL that lives exactly as long as the effect (so React StrictMode's mount/unmount/mount cannot leave it revoked). */
function useBlobUrl(bytes: Uint8Array, type: string | undefined): string | undefined {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!type) return;
    const created = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
    setUrl(created);
    return () => {
      URL.revokeObjectURL(created);
      setUrl(undefined);
    };
  }, [bytes, type]);
  return url;
}

function DocView({ bytes, cid }: { bytes: Uint8Array; cid: string }) {
  const sniffed = useMemo(() => sniff(bytes), [bytes]);
  const url = useBlobUrl(bytes, sniffed.kind === "image" ? sniffed.mediaType : undefined);
  const pdfUrl = useBlobUrl(bytes, sniffed.kind === "pdf" ? "application/pdf" : undefined);
  if (sniffed.kind === "pdf" && pdfUrl) {
    return (
      <div data-testid="doc-pdf">
        <p className="small muted">A PDF document, {bytes.length.toLocaleString("en-US")} bytes. It is not rendered inside this page (the page's security policy blocks embedded documents). Open it in your browser's own viewer or download it. Its content was never inspected here: read it before you trust it.</p>
        <div className="actions tight">
          <a className="secondary small-btn brass-link" href={pdfUrl} target="_blank" rel="noopener noreferrer" data-testid="open-pdf">Open the PDF in a new tab</a>
          <button className="secondary" onClick={() => download(`${cid.slice(0, 16)}.pdf`, bytes as BlobPart, "application/pdf")}>Download PDF</button>
        </div>
      </div>
    );
  }
  if (sniffed.kind === "text") return <pre className="doc-text" data-testid="doc-text">{sniffed.text}</pre>;
  if (sniffed.kind === "image" && url) return <img className="doc-image" src={url} alt="The disclosed document" />;
  return (
    <div>
      <p className="small muted">This file type is not shown in the page. Download it and open it yourself.</p>
      <button className="secondary" onClick={() => download(`${cid.slice(0, 16)}.bin`, bytes as BlobPart, "application/octet-stream")}>Download ({bytes.length} bytes)</button>
    </div>
  );
}

function KeepOnline({ cid, bytes, endpoints, holders, onKept }: { cid: string; bytes: Uint8Array; endpoints: PinnerEndpoint[]; holders: string[]; onKept: (id: string) => void }) {
  const firstFree = endpoints.find((e) => !holders.includes(e.id))?.id ?? endpoints[0]?.id ?? "";
  const [choice, setChoice] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string }>();
  const selected = choice && endpoints.some((e) => e.id === choice) ? choice : firstFree;
  if (endpoints.length === 0) return <p className="small muted">Keep it online needs a pinner. Add one in Settings.</p>;
  async function keep() {
    const endpoint = endpoints.find((e) => e.id === selected);
    if (!endpoint) return;
    setBusy(true);
    setMessage(undefined);
    try {
      const result = await keepOnline({ bytes, cid, endpoint, session: "reader" });
      setMessage(result.ok ? { ok: true, text: `Pinned to ${endpoint.id}.` } : { ok: false, text: result.error ?? "failed" });
      if (result.ok) onKept(endpoint.id);
    } catch (error) {
      setMessage({ ok: false, text: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="keep">
      <p className="field-label">Keep it online</p>
      <p className="small muted">Re-pin the verified document to a pinner you choose, so it stays available. That pinner sees this upload and your network address.</p>
      <div className="actions tight">
        <select value={selected} onChange={(e) => setChoice(e.target.value)} aria-label="Pinner to keep the document on">
          {endpoints.map((e) => (
            <option key={e.id} value={e.id}>{e.id}{holders.includes(e.id) ? " (already holds it)" : ""}</option>
          ))}
        </select>
        <button className="secondary" disabled={busy} onClick={() => void keep()}>{busy ? "Pinning…" : "Keep it online"}</button>
      </div>
      {selected && <p className="small muted mono">{describeEndpoint(endpoints.find((e) => e.id === selected)!)}</p>}
      {message && <p className={message.ok ? "small verified" : "small error-text"} data-testid="keep-result">{message.ok ? <Tick>{message.text}</Tick> : message.text}</p>}
    </div>
  );
}
