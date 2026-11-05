export function AboutPage() {
  return (
    <section>
      <p className="eyebrow">About</p>
      <h1 className="page-title">Publish a document without publishing who you are.</h1>
      <p className="lede">ZeroDrop is an early prototype for a disclosure record. A member of a group proves they belong to it, the record stores the document's digest and the group, and no one learns which member posted.</p>

      <div className="card">
        <h2>CROPS</h2>
        <ul className="rows">
          <li><span>Censorship resistance</span><span className="small muted">Planned through several operators. Not implemented: one local RPC.</span></li>
          <li><span>Open source</span><span className="small muted">MIT licensed.</span></li>
          <li><span>Privacy</span><span className="small muted">Partly. The proof hides the member. The transaction and the network do not hide the poster or the reader.</span></li>
          <li><span>Security</span><span className="small muted">Prototype. Do not use it for sensitive disclosures.</span></li>
        </ul>
      </div>

      <div className="card">
        <h2>Implemented in this build</h2>
        <ul className="bullets">
          <li>Identity creation, export and import. The stored identity key is unencrypted in the browser.</li>
          <li>Group listing from chain events, with the root rebuilt and compared to the published root.</li>
          <li>Metadata stripping for JPEG, PNG and WebP by re-encoding in the browser. Text is normalised.</li>
          <li>Semaphore membership proof, generated in the browser when the circuit files are installed.</li>
          <li>Reader checks: L0 content hash, L1 record and log agreement, L2 offline proof verification.</li>
        </ul>
      </div>

      <div className="card">
        <h2>Not implemented</h2>
        <ul className="bullets">
          <li>Anonymous transport. Anon-RPC and Tor are not integrated. Every request leaves this machine directly.</li>
          <li>Hiding the poster. The direct transaction shows the poster address on chain.</li>
          <li>PDF metadata stripping. PDFs are rejected, not stripped.</li>
          <li>Storage proof (eth_getProof) for the record. L1 trusts RPC agreement.</li>
          <li>Publication of document bytes through PressProtocol or other pinners.</li>
          <li>Frame transactions (EIP-8141) on the devnet. Unverified.</li>
          <li>Circuit artifacts. They are not bundled and must be installed by the user.</li>
        </ul>
      </div>
    </section>
  );
}
