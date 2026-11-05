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
          <li><span>Poster privacy</span><span className="small muted">None on the direct path. The transaction comes from an account whose address is on chain. The frame path (EIP-8141) is meant to hide it and has never run against a real devnet.</span></li>
          <li><span>Network privacy</span><span className="small muted">{ANON_CONFIGURED ? "Anon-RPC is configured at build time but has not been tested here." : "Anon-RPC is not configured in this build. Local chains are always reached directly (\"local chain: not routed through Tor\"). If you point the app at a remote RPC with network mode \"anon\", requests are rejected, never sent directly."}</span></li>
          <li><span>Publication</span><span className="small muted">The stripped document is uploaded to pinners you configure (a zerodrop pinner or a Kubo node) before the record is posted. Readers fetch it by CID and check its hash.</span></li>
        </ul>
      </div>

      <div className="card">
        <h2>CROPS</h2>
        <ul className="rows">
          <li><span>Censorship resistance</span><span className="small muted">Planned through several operators. Today: one RPC and, locally, one or two pinners.</span></li>
          <li><span>Open source</span><span className="small muted">MIT licensed.</span></li>
          <li><span>Privacy</span><span className="small muted">Partly. Metadata is stripped from images and PDFs, and the design hides the member. The transaction and the network do not hide the poster or the reader in this build.</span></li>
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
        <h2>Not implemented, or not verified</h2>
        <ul className="bullets">
          <li>Anonymous transport. Anon-RPC and Tor are not configured; no request in this build has been anonymous.</li>
          <li>Hiding the poster. The direct transaction shows the poster address on chain.</li>
          <li>The frame transaction path (EIP-8141): written and encoded, tested offline only, never simulated or submitted against a devnet. Disabled unless a devnet deployment and sidecars are configured.</li>
          <li>A verified membership proof on the default deployment (it uses the mock verifier).</li>
          <li>Content scrubbing. Text, names and pictures inside a document are not read or changed. Read what you post.</li>
          <li>A cross-checked chain view. L1 uses a storage proof when the RPC serves eth_getProof (and says so when it falls back to plain reads), but the state root is trusted to the RPC, and with one RPC there is no cross-check.</li>
          <li>PressProtocol publication. Only the pinners above.</li>
          <li>Circuit artifacts. They are not bundled and must be installed by the user.</li>
        </ul>
      </div>
    </section>
  );
}
