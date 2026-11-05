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
          <li><span>Privacy</span><span className="small muted">Partly. Metadata is stripped from images, and the design hides the member. The transaction and the network do not hide the poster or the reader in this build.</span></li>
          <li><span>Security</span><span className="small muted">Prototype. Do not use it for sensitive disclosures.</span></li>
        </ul>
      </div>

      <div className="card">
        <h2>Implemented in this build</h2>
        <ul className="bullets">
          <li>Identity creation, export and import. The stored identity key is unencrypted in the browser.</li>
          <li>Group listing from chain events, with the root rebuilt and compared to the published root. Group creation and adding members for an issuer with a funded dev key.</li>
          <li>Metadata stripping for JPEG, PNG and WebP by re-encoding in the browser. Text is normalised.</li>
          <li>Pinning to several endpoints, a random delay with a countdown and Cancel, a posting timeline, a share link, and a downloadable <code className="mono">.zerodrop.json</code> bundle that embeds the document.</li>
          <li>Reader checks: L0 content hash, L1 record and log agreement, L2 proof verification for Semaphore deployments. On a mock deployment L2 reads "Mock proof" and is not a pass.</li>
          <li>Offline bundle check: document hash and, for Semaphore bundles, the proof. A mock bundle reports a mock proof. The chain is not consulted.</li>
          <li>"Keep it online": a reader re-pins a verified document to a pinner they choose.</li>
          <li>Real Semaphore proofs, if the circuit files are placed in <code className="mono">apps/web/public/zk/</code>. They are not bundled.</li>
        </ul>
      </div>

      <div className="card">
        <h2>Not implemented, or not verified</h2>
        <ul className="bullets">
          <li>Anonymous transport. Anon-RPC and Tor are not configured; no request in this build has been anonymous.</li>
          <li>Hiding the poster. The direct transaction shows the poster address on chain.</li>
          <li>The frame transaction path (EIP-8141): written and encoded, tested offline only, never simulated or submitted against a devnet. Disabled unless a devnet deployment and sidecars are configured.</li>
          <li>A verified membership proof on the default deployment (it uses the mock verifier).</li>
          <li>PDF metadata stripping. PDFs are rejected, not stripped.</li>
          <li>A cross-checked chain view. L1 uses a storage proof when the RPC serves eth_getProof (and says so when it falls back to plain reads), but the state root is trusted to the RPC, and with one RPC there is no cross-check.</li>
          <li>PressProtocol publication. Only the pinners above.</li>
          <li>Circuit artifacts. They are not bundled and must be installed by the user.</li>
        </ul>
      </div>
    </section>
  );
}
