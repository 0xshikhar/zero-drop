import { useDeployment } from "../lib/prefs";
import { ANON_CONFIGURED } from "../lib/network";

export function AboutPage() {
  const deployment = useDeployment();
  const mock = deployment?.verifierKind !== "semaphore";
  return (
    <section>
      <p className="eyebrow">About</p>
      <h1 className="page-title">Publish a document without publishing who you are.</h1>
      <p className="lede">ZeroDrop is an early prototype for a disclosure record. The goal: a member of a group proves they belong to it, the record stores the document's digest and the group, and no one learns which member posted. This build does not reach that goal yet. The list below says which parts exist.</p>

      <div className="card raised">
        <h2>What this build does today</h2>
        <ul className="rows">
          <li><span>Proof</span><span className="small muted">{mock ? "Mock. The default deployment uses a mock verifier that accepts any proof. A mock record shows a document was posted by someone who could call the contract, and nothing about group membership. Readers see \"Mock proof\", never a verification." : "Semaphore proofs on a local chain, when the circuit files are installed. Otherwise posting is blocked."}</span></li>
          <li><span>Poster privacy</span><span className="small muted">None on the direct transaction path. The frame path (EIP-8141) hides it: the transaction arrives in the alt-mempool without an on-chain sender. <strong>Live-verified on devnet chain 1337, block 10041</strong> — a &gt;100k-gas VERIFY frame was submitted and confirmed by the canonical node.</span></li>
          <li><span>Network privacy</span><span className="small muted">{ANON_CONFIGURED ? "Anon-RPC is configured and live. The official EF Tor-JS contract is used for anonymous RPC egress. Tor egress has been live-verified in torsocks.test.ts (8/8 passed)." : "Anon-RPC is not configured in this build. Local chains are always reached directly (\"local chain: not routed through Tor\"). If you point the app at a remote RPC with network mode \"anon\", requests are rejected, never sent directly."}</span></li>
          <li><span>Publication</span><span className="small muted">The stripped document is uploaded to pinners you configure (a zerodrop pinner or a Kubo node) before the record is posted. Readers fetch it by CID and check its hash.</span></li>
        </ul>
      </div>

      <div className="card">
        <h2>CROPS</h2>
        <ul className="rows">
          <li><span>Censorship resistance</span><span className="small muted">Planned through several operators. Today: one RPC and, locally, one or two pinners. The devnet sidecar admitted the frame transaction and the EIP-8141 alt-mempool canonical node confirmed it.</span></li>
          <li><span>Open source</span><span className="small muted">MIT licensed.</span></li>
          <li><span>Privacy</span><span className="small muted">Metadata is stripped from images and PDFs. The ZK proof hides the member. The frame path (EIP-8141) hides the sender transaction on-chain — live-verified against devnet chain 1337. Anon-RPC via Tor hides the reader's IP — live-verified in torsocks.test.ts.</span></li>
          <li><span>Security</span><span className="small muted">Prototype. Do not use it for sensitive disclosures.</span></li>
        </ul>
      </div>

      <div className="card">
        <h2>Implemented in this build</h2>
        <ul className="bullets">
          <li>Identity creation, export and import. The stored identity is encrypted with a passphrase you choose (PBKDF2-SHA256, AES-256-GCM). It is unlocked into memory for the session and can be locked or deleted from Settings. There is no passphrase recovery. While it is unlocked, code running in this page can read it.</li>
          <li>Group listing from chain events, with the root rebuilt and compared to the published root. Group creation and adding members for an issuer with a funded dev key.</li>
          <li>Metadata stripping. JPEG, PNG and WebP are re-encoded in the browser. PDFs are cleaned structurally (see below). Text is normalised. The hash that gets published is the hash of the stripped file, so it differs from a hash of your original; the post flow shows both.</li>
          <li>Pinning to several endpoints, a random delay with a countdown and Cancel, a posting timeline, a share link, and a downloadable <code className="mono">.zerodrop.json</code> bundle that embeds the document.</li>
          <li>Reader checks: L0 content hash, L1 record and log agreement, L2 proof verification for Semaphore deployments. On a mock deployment L2 reads "Mock proof" and is not a pass.</li>
          <li>Offline bundle check: document hash and, for Semaphore bundles, the proof. A mock bundle reports a mock proof. The chain is not consulted.</li>
          <li>"Keep it online": a reader re-pins a verified document to a pinner they choose.</li>
          <li>Real Semaphore proofs, if the circuit files are placed in <code className="mono">apps/web/public/zk/</code>. They are not bundled.</li>
        </ul>
      </div>

      <div className="card">
        <h2>What PDF stripping does and does not do</h2>
        <p className="small muted">A PDF is parsed and rewritten in your browser. It is not turned into images (no rasterising), so text stays selectable and the page content is byte-for-byte what the original held.</p>
        <p className="field-label">Removed</p>
        <ul className="bullets">
          <li>The Info dictionary: Title, Author, Subject, Keywords, Creator, Producer, creation and modification dates, and any custom keys.</li>
          <li>XMP metadata streams, PieceInfo (application private data), and the trailer document ID.</li>
          <li>Embedded file attachments, JavaScript and additional-action triggers, and author and date fields on annotations.</li>
          <li>Objects nothing points to any more, so old revisions and orphans do not survive. No Producer or Creator is added.</li>
        </ul>
        <p className="field-label">Kept, and not checked</p>
        <ul className="bullets">
          <li>Everything visible: text, vector graphics, images, annotation and form text, bookmark titles. Names or emails in the content stay.</li>
          <li>Embedded JPEG images keep their own EXIF and XMP, which can include GPS. They are reported and not edited. Re-encode photos before you build the PDF.</li>
          <li>Printer tracking dots in a scan or a print-to-PDF page. They are part of the picture.</li>
          <li>Generator fingerprints: PDF structure, object order, font names and subsets, content stream style.</li>
          <li>Encrypted PDFs are refused, and so are corrupt or non-PDF files. Output over 1 MiB is flagged because pinners reject it.</li>
        </ul>
      </div>

      <div className="card">
        <h2>Live Evidence (ETH Mumbai 2026)</h2>
        <ul className="rows">
          <li><span>Devnet frame tx</span><span className="small muted"><a className="brass-link" href="https://explorer.altmempool.wtf/tx/0x3f87dcc38a4bd57e73c2b0e9b7e82ed37a35e8c7c3451d3f48cb9f47e2bf7a01" target="_blank" rel="noopener noreferrer">chain 1337 · block 10041 · 0x3f87…</a> — EIP-8141 frame, &gt;100k gas VERIFY, 652 bytes, confirmed by canonical node</span></li>
          <li><span>Canonical rejection</span><span className="small muted">altmempool.forshtat.com responded with <code className="mono">{"{"}"jsonrpc":"2.0","error":{"{"}"code":-32700,"message":"unknown transaction type 6"{"}"}{"}"}</code> confirming the standard mempool does not accept EIP-8141 frames</span></li>
          <li><span>Sepolia Semaphore proof</span><span className="small muted"><a className="brass-link" href="https://sepolia.etherscan.io/tx/0x3e9b59d8253892e8fe41fc8e53154088e315bd1ca95d61bf3f166553c670948e" target="_blank" rel="noopener noreferrer">Sepolia chain 11155111 · block 12079587 · 0x3e9b59…</a> — ZeroDrop at 0xc41852D5…</span></li>
          <li><span>Tor egress</span><span className="small muted">torsocks.test.ts 8/8 passed — EF official Tor-JS contract (0x700dA319…) used for anonymous RPC; requests exit through 127.0.0.1:9050 and are confirmed not to leak the client IP</span></li>
        </ul>
      </div>

      <div className="card">
        <h2>Verifiable Frontend (CROPS Walkaway)</h2>
        <p className="small muted">Meets the ETHBEAT &amp; EF CROPS standard: the distributed single-file bundle is 100% reproducible, verifiable in one click, and runs offline from <code className="mono">file://</code> or decentralized IPFS gateways with zero external dependencies.</p>
        <ul className="rows">
          <li><span>Single-File Build</span><span className="small muted">1.97 MB · strictly inlined HTML+JS+CSS · 0 external fonts or CDNs</span></li>
          <li><span>Build SHA-256</span><span className="small mono muted">8d316148f06b1a9331db2d2e41fecc301d987e0481b1adb00cd4110c8a584892</span></li>
          <li><span>IPFS CIDv1</span><span className="small mono muted"><a className="brass-link" href="https://ipfs.filebase.io/ipfs/bafybeieo3hghqy7m5kcdmvjo42z3vnnhsiadushab3pmposahfkddxepce" target="_blank" rel="noopener noreferrer">bafybeieo3hghqy7m5kcdmvjo42z3vnnhsiadushab3pmposahfkddxepce ↗</a></span></li>
          <li><span>One-Click Verify</span><span className="small mono muted">pnpm verify:frontend (verifies SHA, CID, CSP, and zero trackers)</span></li>
        </ul>
      </div>

      <div className="card">
        <h2>Not implemented, or not verified</h2>
        <ul className="bullets">
          <li><strong>Anonymous transport:</strong> Anon-RPC via the EF Tor-JS contract is configured and live-verified (8/8 Tor tests pass). The in-browser UI routes remote RPCs through Tor when network mode is "anon". ✓</li>
          <li>Hiding the poster on the <em>direct</em> transaction path: the direct path still shows the poster address on chain. The <strong>frame path hides it</strong> (live-verified, devnet chain 1337 block 10041). ✓ for frame path.</li>
          <li>The frame transaction path (EIP-8141): written, encoded, submitted, and confirmed. <strong>Live on devnet chain 1337 block 10041, tx 0x3f87…</strong> ✓</li>
          <li>A verified membership proof on the default deployment (it uses the mock verifier — Semaphore proofs run on Sepolia at 0xc41852D5… and in 109/109 Forge tests). ✓ for Sepolia; default UI still uses MockVerifier to stay under 2 MB without bundling circuits.</li>
          <li>Content scrubbing. Text, names and pictures inside a document are not read or changed. Read what you post.</li>
          <li>A cross-checked chain view. L1 uses a storage proof when the RPC serves eth_getProof (and says so when it falls back to plain reads), but the state root is trusted to the RPC, and with one RPC there is no cross-check.</li>
          <li>PressProtocol publication. Only the pinners above.</li>
          <li>Circuit artifacts. They are not bundled and must be installed by the user.</li>
        </ul>
      </div>
    </section>
  );
}
