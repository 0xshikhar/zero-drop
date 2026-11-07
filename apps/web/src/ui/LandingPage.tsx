import { useState, type ReactNode } from "react";
import { toHref } from "../lib/router";

export function LandingPage() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [activeSimTab, setActiveSimTab] = useState<"reader" | "frame" | "sanitizer">("reader");
  const [isVerifying, setIsVerifying] = useState(false);
  const [verifiedStep, setVerifiedStep] = useState(3);

  const simulateVerification = () => {
    setIsVerifying(true);
    setVerifiedStep(0);
    setTimeout(() => setVerifiedStep(1), 350);
    setTimeout(() => setVerifiedStep(2), 700);
    setTimeout(() => {
      setVerifiedStep(3);
      setIsVerifying(false);
    }, 1050);
  };

  const scrollTo = (id: string) => (e: React.MouseEvent) => {
    e.preventDefault();
    const el = document.getElementById(id);
    if (el) {
      el.scrollIntoView({ behavior: "smooth" });
      setMobileMenuOpen(false);
    }
  };

  return (
    <div className="lp">
      <a className="lp-skip" href="#main">Skip to content</a>

      {/* Navigation Header */}
      <header className="lp-header">
        <div className="lp-wrap lp-header-row">
          <a className="lp-wordmark" href={toHref("/")}>
            <div className="lp-wordmark-mark">ZD</div>
            ZeroDrop
          </a>

          <nav className="lp-nav" aria-label="Main Navigation">
            <div className="lp-nav-links">
              <a href="#how-it-works" onClick={scrollTo("how-it-works")}>How It Works</a>
              <a href="#live-evidence" onClick={scrollTo("live-evidence")}>Live Evidence</a>
              <a href="#crops" onClick={scrollTo("crops")}>CROPS</a>
              <a href="#comparison" onClick={scrollTo("comparison")}>Comparison</a>
              <a href="#faq" onClick={scrollTo("faq")}>FAQ</a>
              <a href={toHref("/about")}>About</a>
              <a href={toHref("/app")}>App</a>
            </div>

            <div className="lp-header-actions">
              <a className="lp-btn lp-btn-outline" href={toHref("/d/")}>Verify Leak</a>
              <a className="lp-btn lp-btn-primary" href={toHref("/app")}>Launch App</a>
            </div>
          </nav>

          <button
            type="button"
            className="lp-menu-button"
            aria-expanded={mobileMenuOpen}
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
          >
            {mobileMenuOpen ? "✕ Close" : "☰ Menu"}
          </button>
        </div>

        {mobileMenuOpen && (
          <div className="lp-wrap lp-mobile-menu">
            <a href="#how-it-works" onClick={scrollTo("how-it-works")}>How It Works</a>
            <a href="#live-evidence" onClick={scrollTo("live-evidence")}>Live Evidence</a>
            <a href="#crops" onClick={scrollTo("crops")}>CROPS</a>
            <a href="#comparison" onClick={scrollTo("comparison")}>Comparison</a>
            <a href="#faq" onClick={scrollTo("faq")}>FAQ</a>
            <a href={toHref("/about")}>About Protocol</a>
            <a href={toHref("/app")}>Open App</a>
            <div style={{ display: "flex", gap: "12px", marginTop: "12px" }}>
              <a className="lp-btn lp-btn-outline" style={{ flex: 1 }} href={toHref("/d/")}>Verify Leak</a>
              <a className="lp-btn lp-btn-primary" style={{ flex: 1 }} href={toHref("/app")}>Launch App</a>
            </div>
          </div>
        )}
      </header>

      <main id="main">
        {/* Hero Section */}
        <section className="lp-hero">
          <div className="lp-wrap lp-hero-grid">
            <div>
              <div className="lp-eyebrow">
                <span className="lp-pulse-dot" />
                <span>Alt-Mempool (EIP-8141) & Anon-RPC</span>
              </div>

              <h1 className="lp-h1">Leak the document, not yourself.</h1>

              <p className="lp-hero-lede">
                The first <strong>relayerless, zero-knowledge disclosure protocol</strong>.
                Publish authentic disclosures cryptographically proven from verified groups — with <strong>0 ETH, 0 servers, and 0 IP leaks</strong>.
              </p>

              <div className="lp-hero-actions">
                <a className="lp-btn lp-btn-ivory" href={toHref("/app")}>
                  <span>📄 Open App / Post</span>
                </a>
                <a className="lp-btn lp-btn-outline" href={toHref("/d/")}>
                  <span>🔍 Verify a Disclosure</span>
                </a>
              </div>

              <div className="lp-hero-guarantees">
                <span>0 ETH Required (Contract Pays Gas)</span>
                <span>Zero Relayer Trust</span>
                <span>Tor / Anon-RPC Native</span>
                <span>Runs from file://</span>
              </div>
            </div>

            {/* Interactive Simulator Card */}
            <div className="lp-sim-card">
              <div className="lp-sim-topbar">
                <div className="lp-sim-dots">
                  <div className="lp-sim-dot" />
                  <div className="lp-sim-dot" />
                  <div className="lp-sim-dot" />
                </div>
                <div className="lp-sim-title">zerodrop-verification-engine v0.1.0</div>
                <div className="lp-sim-live-tag">
                  <span className="lp-pulse-dot" style={{ width: "5px", height: "5px" }} />
                  <span>ON-CHAIN</span>
                </div>
              </div>

              <div className="lp-sim-tabs">
                <button
                  type="button"
                  className={`lp-sim-tab ${activeSimTab === "reader" ? "active" : ""}`}
                  onClick={() => setActiveSimTab("reader")}
                >
                  Reader Verification
                </button>
                <button
                  type="button"
                  className={`lp-sim-tab ${activeSimTab === "frame" ? "active" : ""}`}
                  onClick={() => setActiveSimTab("frame")}
                >
                  EIP-8141 Frame Tx
                </button>
                <button
                  type="button"
                  className={`lp-sim-tab ${activeSimTab === "sanitizer" ? "active" : ""}`}
                  onClick={() => setActiveSimTab("sanitizer")}
                >
                  Device Sanitizer
                </button>
              </div>

              <div className="lp-sim-body">
                {activeSimTab === "reader" && (
                  <div>
                    <div className="lp-sim-checks">
                      <div className={`lp-sim-row ${verifiedStep >= 1 ? "is-active" : ""}`}>
                        <div className="lp-sim-badge-check verified">✓</div>
                        <div className="lp-sim-row-content">
                          <strong>L0 Content Authenticity</strong>
                          <span>CIDv1 raw-sha256 matches payload byte-for-byte</span>
                        </div>
                        <div className="lp-sim-row-status verified">
                          {verifiedStep >= 1 ? "VERIFIED" : "CHECKING..."}
                        </div>
                      </div>

                      <div className={`lp-sim-row ${verifiedStep >= 2 ? "is-active" : ""}`}>
                        <div className="lp-sim-badge-check verified">✓</div>
                        <div className="lp-sim-row-content">
                          <strong>L1 Cryptographic State Proof</strong>
                          <span>eth_getProof verified against execution state root</span>
                        </div>
                        <div className="lp-sim-row-status verified">
                          {verifiedStep >= 2 ? "PROVEN" : "PENDING..."}
                        </div>
                      </div>

                      <div className={`lp-sim-row ${verifiedStep >= 3 ? "is-active" : ""}`}>
                        <div className="lp-sim-badge-check mock">◇</div>
                        <div className="lp-sim-row-content">
                          <strong>L2 Semaphore Zero-Knowledge Proof</strong>
                          <span>Groth16 member of group G · Nullifier keyed to case C</span>
                        </div>
                        <div className="lp-sim-row-status mock">
                          {verifiedStep >= 3 ? "MOCK VALID" : "PROVING..."}
                        </div>
                      </div>
                    </div>

                    <div className="lp-sim-footer">
                      <span>Network Egress: Tor SOCKS5h / Anon-RPC</span>
                      <button
                        type="button"
                        className="lp-sim-action-btn"
                        onClick={simulateVerification}
                        disabled={isVerifying}
                      >
                        {isVerifying ? "Verifying Proof..." : "Re-Verify Proof ↺"}
                      </button>
                    </div>
                  </div>
                )}

                {activeSimTab === "frame" && (
                  <div>
                    <div className="lp-code-preview">
                      <div><span className="kw">struct</span> <span className="fn">EIP8141FrameTransaction</span> &#123;</div>
                      <div>&nbsp;&nbsp;sender: <span className="str">0xZeroDropContract</span>, <span className="kw">// Contract is sender</span></div>
                      <div>&nbsp;&nbsp;paymaster: <span className="str">0xContractFloat</span>, <span className="kw">// 0 ETH needed from poster</span></div>
                      <div>&nbsp;&nbsp;bodyGasFloor: <span className="num">250_000</span>, <span className="kw">// &gt;100k verify budget</span></div>
                      <div>&nbsp;&nbsp;nullifierKey: <span className="str">0x9f3b...12a4</span>, <span className="kw">// Prevents replay</span></div>
                      <div>&nbsp;&nbsp;transport: <span className="str">"ERC-8421 Alt-Mempool"</span> <span className="kw">// No central relayer</span></div>
                      <div>&#125;</div>
                    </div>
                    <div className="lp-sim-footer">
                      <span>Bypasses canonical mempool 100k validation cap</span>
                      <a href={toHref("/app")} className="lp-sim-action-btn">Open Post Flow →</a>
                    </div>
                  </div>
                )}

                {activeSimTab === "sanitizer" && (
                  <div>
                    <div className="lp-code-preview">
                      <div><span className="kw">[Client-Side PDF & Image Sanitization]</span></div>
                      <div>• Stripped Info.Author, Title, Subject: <span className="str">REDACTED</span></div>
                      <div>• Dropped XMP Stream & Metadata Tree: <span className="str">REMOVED</span></div>
                      <div>• Stripped DocumentID & InstanceID: <span className="str">PURGED</span></div>
                      <div>• Removed Embedded JavaScript & Actions: <span className="str">CLEARED</span></div>
                      <div>• Canvas Image Normalization: <span className="str">EXIF/GPS STRIPPED</span></div>
                    </div>
                    <div className="lp-sim-footer">
                      <span>Processed 100% in local memory before pinning</span>
                      <a href={toHref("/app")} className="lp-sim-action-btn">Test a File →</a>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </section>

        {/* Protocol Metrics Bar */}
        <section className="lp-metrics">
          <div className="lp-wrap">
            <div className="lp-metrics-grid">
              <div className="lp-metric-card">
                <div className="lp-metric-val">0 <span>ETH</span></div>
                <div className="lp-metric-label">Relayerless Gas Float</div>
                <div className="lp-metric-desc">Contract pays execution gas directly on chain; zero funding trail required.</div>
              </div>

              <div className="lp-metric-card">
                <div className="lp-metric-val">100% <span>Client</span></div>
                <div className="lp-metric-label">Zero Backend Infrastructure</div>
                <div className="lp-metric-desc">No central server, no database, no IP logging, and no analytics trackers.</div>
              </div>

              <div className="lp-metric-card">
                <div className="lp-metric-val">&gt;100k <span>Gas</span></div>
                <div className="lp-metric-label">ERC-8421 Alt-Mempool</div>
                <div className="lp-metric-desc">Allows heavy ZK membership verifications rejected by standard mempools.</div>
              </div>

              <div className="lp-metric-card">
                <div className="lp-metric-val">1.97 <span>MB</span></div>
                <div className="lp-metric-label">Single-File Walkaway</div>
                <div className="lp-metric-desc">Loads directly from file:// or IPFS; zero external CDNs or font dependencies.</div>
              </div>
            </div>
          </div>
        </section>

        {/* Live Evidence Section */}
        <section id="live-evidence" className="lp-section lp-evidence-section">
          <div className="lp-wrap">
            <div className="lp-section-header">
              <span className="lp-section-tag lp-evidence-tag">⛓ Live On-Chain Evidence</span>
              <h2 className="lp-h2">Every claim, verifiable on chain.</h2>
              <p className="lp-section-desc">
                ZeroDrop is not a whitepaper. These transactions exist on-chain right now — explore them yourself.
              </p>
            </div>

            <div className="lp-evidence-grid">
              <div className="lp-evidence-card lp-evidence-card--primary">
                <div className="lp-evidence-chain">Chain 1337 · Devnet</div>
                <div className="lp-evidence-title">EIP-8141 Frame Transaction</div>
                <div className="lp-evidence-detail">Block 10041 · 652 bytes · &gt;100k gas VERIFY frame submitted to alt-mempool and confirmed by canonical node</div>
                <div className="lp-evidence-hash">0x3f87e18e…9bbc9aa</div>
                <a
                  className="lp-evidence-link"
                  href="https://explorer.altmempool.wtf/tx/0x3f87e18e0d571b3a6f84f185367342022d7fa8a0ef3f91828dee76e3a9bbc9aa"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  View on alt-mempool explorer ↗
                </a>
              </div>

              <div className="lp-evidence-card">
                <div className="lp-evidence-chain">Chain 1337 · Canonical Rejection</div>
                <div className="lp-evidence-title">Standard Mempool Rejects Frame</div>
                <div className="lp-evidence-detail">The canonical node at altmempool.forshtat.com returned verbatim:</div>
                <code className="lp-evidence-code">{"{"}"error":{"{"}"code":-32700,"message":"unknown transaction type 6"{"}"}{"}"}</code>
                <div className="lp-evidence-detail" style={{ marginTop: "8px" }}>Proof that EIP-8141 frames are invisible to standard Ethereum infrastructure.</div>
              </div>

              <div className="lp-evidence-card">
                <div className="lp-evidence-chain">Chain 11155111 · Sepolia</div>
                <div className="lp-evidence-title">ZeroDrop + Semaphore Proof</div>
                <div className="lp-evidence-detail">Block 12079587 · ZeroDrop at 0xc41852D5… · ZK group membership verifier deployed and called</div>
                <div className="lp-evidence-hash">0x3e9b59d8…670948e</div>
                <a
                  className="lp-evidence-link"
                  href="https://sepolia.etherscan.io/tx/0x3e9b59d8253892e8fe41fc8e53154088e315bd1ca95d61bf3f166553c670948e"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  View on Sepolia Etherscan ↗
                </a>
              </div>

              <div className="lp-evidence-card">
                <div className="lp-evidence-chain">Tor Egress · torsocks.test.ts</div>
                <div className="lp-evidence-title">Anonymous RPC via Tor</div>
                <div className="lp-evidence-detail">8/8 Tor egress tests passed. Official EF Tor-JS contract (0x700dA319…) used. Requests verified not to leak client IP. SOCKS5h proxy on 127.0.0.1:9050.</div>
                <div className="lp-evidence-hash" style={{ color: "var(--lp-bottle)" }}>✓ 8/8 passed</div>
              </div>
            </div>
          </div>
        </section>

        {/* How It Works Section */}
        <section id="how-it-works" className="lp-section">
          <div className="lp-wrap">
            <div className="lp-section-header">
              <span className="lp-section-tag">Architecture</span>
              <h2 className="lp-h2">How ZeroDrop Works End-to-End</h2>
              <p className="lp-section-desc">
                From on-device file sanitization to trustless reader verification without relying on trusted intermediaries.
              </p>
            </div>

            <div className="lp-pipeline">
              <div className="lp-pipe-card">
                <div className="lp-pipe-num">
                  <span>STEP 01</span>
                  <span className="lp-pipe-tag">LOCAL MEMORY</span>
                </div>
                <h3>Sanitize & Fingerprint</h3>
                <p>
                  Your browser parses PDFs and images, stripping author tags, XMP dictionaries, GPS data, and internal IDs before computing an immutable raw SHA-256 CIDv1.
                </p>
              </div>

              <div className="lp-pipe-card">
                <div className="lp-pipe-num">
                  <span>STEP 02</span>
                  <span className="lp-pipe-tag">SEMAPHORE V4</span>
                </div>
                <h3>Prove in Zero-Knowledge</h3>
                <p>
                  You generate a Groth16 zk-SNARK proving membership in a known group (e.g. newsroom, union, staff) with a unique nullifier per case to prevent flood attacks.
                </p>
              </div>

              <div className="lp-pipe-card">
                <div className="lp-pipe-num">
                  <span>STEP 03</span>
                  <span className="lp-pipe-tag">EIP-8141 ALT-MEMPOOL</span>
                </div>
                <h3>Relayerless Frame Broadcast</h3>
                <p>
                  The transaction is broadcast over Tor to an alternative mempool. ZeroDrop’s contract serves as both sender and payer, eliminating centralized relayers.
                </p>
              </div>

              <div className="lp-pipe-card">
                <div className="lp-pipe-num">
                  <span>STEP 04</span>
                  <span className="lp-pipe-tag">TRUSTLESS READER</span>
                </div>
                <h3>Multi-Layer Verification</h3>
                <p>
                  Readers inspect disclosures through Anon-RPC, verifying the content hash (L0), storage inclusion proof against block headers (L1), and ZK membership (L2).
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* CROPS Walkaway Test Section */}
        <section id="crops" className="lp-section" style={{ background: "rgba(18, 24, 19, 0.4)" }}>
          <div className="lp-wrap">
            <div className="lp-section-header">
              <span className="lp-section-tag">EF Mandate & ETHBEAT</span>
              <h2 className="lp-h2">Built for the CROPS "Walkaway Test"</h2>
              <p className="lp-section-desc">
                If the creators disappear, the domain is seized, and the RPC goes offline tomorrow — does the product still work?
              </p>
            </div>

            <div className="lp-crops-grid">
              <div className="lp-crop-card">
                <div className="lp-crop-badge">[ C ] CENSORSHIP RESISTANT</div>
                <h3>Zero Server & Domain Dependency</h3>
                <p>
                  No backend, no centralized database, and no mandatory domain. ZeroDrop builds into a single 1.95 MB HTML file that opens from <code>file://</code> in any browser or pins directly to IPFS.
                </p>
                <div className="lp-crop-highlight">
                  <span>✓ Verified loading from file:// with zero CSP violations</span>
                </div>
              </div>

              <div className="lp-crop-card">
                <div className="lp-crop-badge">[ R / O ] OPEN & REPRODUCIBLE</div>
                <h3>Bit-for-Bit Deterministic Builds</h3>
                <p>
                  Released under MIT. Clean builds produce byte-identical SHA-256 hashes. Anyone can independently verify that the shipped single-file HTML matches the public repository.
                </p>
                <div className="lp-crop-highlight">
                  <span>✓ scripts/build-ipfs.sh --repro verified</span>
                </div>
              </div>

              <div className="lp-crop-card">
                <div className="lp-crop-badge">[ P ] PRIVACY FIRST</div>
                <h3>Tor & Anon-RPC Single Egress</h3>
                <p>
                  Every network read leaves through a unified transport that routes over Tor/Anon-RPC. Schedulable submission delays prevent timing correlation between joining and posting.
                </p>
                <div className="lp-crop-highlight">
                  <span>✓ Built-in real-time session traffic meter</span>
                </div>
              </div>

              <div className="lp-crop-card">
                <div className="lp-crop-badge">[ S ] CRYPTOGRAPHICALLY SECURE</div>
                <h3>Encrypted Vault & ZK Boundaries</h3>
                <p>
                  Semaphore identity secrets never leave your device. Identities stored in IndexedDB are encrypted with AES-256-GCM using PBKDF2-SHA256 passphrase-derived keys.
                </p>
                <div className="lp-crop-highlight">
                  <span>✓ Groth16 ZK SNARKs & storage-proof verification</span>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Comparison Table Section */}
        <section id="comparison" className="lp-section">
          <div className="lp-wrap">
            <div className="lp-section-header">
              <span className="lp-section-tag">Comparison</span>
              <h2 className="lp-h2">Why Existing Leaks Fail</h2>
              <p className="lp-section-desc">
                Centralized servers log IP addresses, public blockchains create funding trails, and standard relayers can censor.
              </p>
            </div>

            <div className="lp-table-wrap">
              <table className="lp-table">
                <thead>
                  <tr>
                    <th>Design Property</th>
                    <th>SecureDrop / Email</th>
                    <th>Standard dApps</th>
                    <th className="col-highlight">ZeroDrop</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td className="lp-table-feat">Relayer Dependency</td>
                    <td><span className="lp-badge-cross">✕</span> Vendor server</td>
                    <td><span className="lp-badge-cross">✕</span> Centralized relayer</td>
                    <td className="col-highlight"><span className="lp-badge-check">✓</span> Relayerless (EIP-8141)</td>
                  </tr>
                  <tr>
                    <td className="lp-table-feat">Gas & Funding Trail</td>
                    <td><span className="lp-badge-cross">✕</span> N/A</td>
                    <td><span className="lp-badge-cross">✕</span> Funded wallet doxes source</td>
                    <td className="col-highlight"><span className="lp-badge-check">✓</span> 0 ETH (Contract Pays)</td>
                  </tr>
                  <tr>
                    <td className="lp-table-feat">Reader IP Logging</td>
                    <td><span className="lp-badge-cross">✕</span> Server logs IPs</td>
                    <td><span className="lp-badge-cross">✕</span> Infura/Alchemy logs RPC</td>
                    <td className="col-highlight"><span className="lp-badge-check">✓</span> Anon-RPC Tor Egress</td>
                  </tr>
                  <tr>
                    <td className="lp-table-feat">Walkaway Survivability</td>
                    <td><span className="lp-badge-cross">✕</span> Fails on server death</td>
                    <td><span className="lp-badge-cross">✕</span> Fails on domain takedown</td>
                    <td className="col-highlight"><span className="lp-badge-check">✓</span> 1-file HTML / file://</td>
                  </tr>
                  <tr>
                    <td className="lp-table-feat">Membership Proof</td>
                    <td><span className="lp-badge-cross">✕</span> Trust the reporter</td>
                    <td><span className="lp-badge-cross">✕</span> Hard cap (&lt;100k gas)</td>
                    <td className="col-highlight"><span className="lp-badge-check">✓</span> Semaphore v4 ZK Proof</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </section>

        {/* FAQ Section */}
        <section id="faq" className="lp-section" style={{ background: "rgba(18, 24, 19, 0.4)" }}>
          <div className="lp-wrap">
            <div className="lp-section-header">
              <span className="lp-section-tag">Questions & Answers</span>
              <h2 className="lp-h2">Frequently Asked Questions</h2>
              <p className="lp-section-desc">Clear, honest answers about architecture, security, and current prototype status.</p>
            </div>

            <div className="lp-faq-list">
              <details className="lp-faq-item">
                <summary className="lp-faq-summary">
                  <span>How does 0-ETH posting work without a centralized relayer?</span>
                  <span className="lp-faq-arrow">▼</span>
                </summary>
                <div className="lp-faq-content">
                  ZeroDrop utilizes <strong>EIP-8141 Frame Transactions</strong> on the ERC-8421 alternative mempool. The ZeroDrop smart contract itself acts as the transaction sender and paymaster, pulling execution gas from a community-funded contract float. Because verification happens in an on-chain <code>VERIFY</code> frame (&gt;100k gas), no off-chain relayer sees or signs the transaction.
                </div>
              </details>

              <details className="lp-faq-item">
                <summary className="lp-faq-summary">
                  <span>How does reader verification work without trusting the RPC?</span>
                  <span className="lp-faq-arrow">▼</span>
                </summary>
                <div className="lp-faq-content">
                  When a reader opens a disclosure, ZeroDrop requests an Ethereum storage proof (<code>eth_getProof</code>) for the record's storage slot and verifies the Merkle-Patricia Trie proof directly against the execution block header's state root. An RPC cannot forge a record without breaking Keccak-256 state commitments.
                </div>
              </details>

              <details className="lp-faq-item">
                <summary className="lp-faq-summary">
                  <span>What is the difference between Mock Proof and Real Proof?</span>
                  <span className="lp-faq-arrow">▼</span>
                </summary>
                <div className="lp-faq-content">
                  Real Semaphore v4 Groth16 proofs have been verified in Node and on local anvil chains (109 passing Forge tests). For the in-browser demo build, proof verification defaults to a gas-burning <code>MockVerifier</code> so the prototype remains under 2 MB without bundling heavy multi-megabyte zk-SNARK circuits into the single file.
                </div>
              </details>

              <details className="lp-faq-item">
                <summary className="lp-faq-summary">
                  <span>How does ZeroDrop survive a domain takedown?</span>
                  <span className="lp-faq-arrow">▼</span>
                </summary>
                <div className="lp-faq-content">
                  The entire web application builds into a single portable <code>index.html</code> file with zero external script, font, or image dependencies. You can download the file, store it on an air-gapped machine or USB stick, and double-click to open it via <code>file://</code> or load it from any local Kubo IPFS node.
                </div>
              </details>
            </div>
          </div>
        </section>

        {/* Final CTA */}
        <section className="lp-cta">
          <div className="lp-wrap lp-cta-box">
            <h2 className="lp-h2">Experience Anonymous Provenance</h2>
            <p className="lp-section-desc" style={{ marginTop: "12px" }}>
              Explore the live prototype, test client-side metadata stripping, and inspect cryptographic storage proofs on chain.
            </p>
            <div className="lp-cta-actions">
              <a className="lp-btn lp-btn-ivory" href={toHref("/app")}>
                <span>📄 Open App / Post</span>
              </a>
              <a className="lp-btn lp-btn-outline" href={toHref("/d/")}>
                <span>🔍 Lookup Disclosure</span>
              </a>
              <a className="lp-btn lp-btn-ghost" href={toHref("/groups")}>
                <span>👥 View Issuer Groups</span>
              </a>
            </div>
          </div>
        </section>
      </main>

      {/* Footer */}
      <footer className="lp-footer">
        <div className="lp-wrap lp-footer-row">
          <div>
            <strong>ZeroDrop</strong> · ETH Mumbai 2026 Prototype · Released under MIT License
          </div>
          <div className="lp-footer-nav">
            <a href={toHref("/")}>Home</a>
            <a href={toHref("/app")}>App</a>
            <a href={toHref("/d/")}>Read</a>
            <a href={toHref("/groups")}>Groups</a>
            <a href={toHref("/settings")}>Settings</a>
            <a href={toHref("/about")}>About</a>
          </div>
        </div>
      </footer>
    </div>
  );
}
