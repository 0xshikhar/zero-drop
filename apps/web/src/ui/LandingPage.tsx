import { useId, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";

/**
 * The repository's web address, set at build time (VITE_REPO_URL=https://... npm run build). Until it is set, the
 * repository links show "pending" text instead of a dead link.
 */
const REPO_URL: string = (import.meta.env.VITE_REPO_URL as string | undefined)?.trim() ?? "";

/** Scrolls to a section without writing an anchor into the hash, so the landing route stays #/home. */
function scrollToSection(id: string) {
  const target = document.getElementById(id);
  if (!target) return;
  const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  target.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
}

function RepoLink({ href, children }: { href: string; children: ReactNode }) {
  if (!REPO_URL) return <span className="lp-pending">Repository link pending</span>;
  return (
    <a className="lp-link" href={`${REPO_URL}${href}`} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

export function LandingPage() {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuId = useId();
  const menuButton = useRef<HTMLButtonElement>(null);
  // The mobile menu overlays the page (absolute), so opening or closing it never moves the content under it.
  // That keeps jump targets measured correctly.
  function jumpTo(id: string) {
    return (event: MouseEvent<HTMLAnchorElement>) => {
      if (!document.getElementById(id)) return;
      event.preventDefault();
      setMenuOpen(false);
      scrollToSection(id);
    };
  }

  function onNavKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === "Escape" && menuOpen) {
      setMenuOpen(false);
      menuButton.current?.focus();
    }
  }

  function skipToContent(event: MouseEvent<HTMLAnchorElement>) {
    event.preventDefault();
    const main = document.getElementById("main");
    main?.focus();
  }

  return (
    <div className="lp">
      <a className="lp-skip" href="#main" onClick={skipToContent}>Skip to content</a>

      <header className="lp-header">
        <div className="lp-wrap lp-header-row">
          <a className="lp-wordmark" href="#/home">ZeroDrop</a>
          <button
            ref={menuButton}
            type="button"
            className="lp-menu-button"
            aria-expanded={menuOpen}
            aria-controls={menuId}
            onClick={() => setMenuOpen((open) => !open)}
          >
            {menuOpen ? "Close menu" : "Menu"}
          </button>
          <nav aria-label="Primary" className={menuOpen ? "lp-nav is-open" : "lp-nav"} onKeyDown={onNavKeyDown}>
            <div id={menuId} className="lp-nav-panel">
              <ul className="lp-nav-links">
                <li><a href="#how-it-works" onClick={jumpTo("how-it-works")}>How it works</a></li>
                <li><a href="#security" onClick={jumpTo("security")}>Security</a></li>
                <li><a href="#status" onClick={jumpTo("status")}>Status</a></li>
                <li><a href="#/about" onClick={() => setMenuOpen(false)}>About</a></li>
              </ul>
              <div className="lp-nav-actions">
                <a className="lp-btn lp-btn-secondary" href="#/d/" onClick={() => setMenuOpen(false)}>Read a disclosure</a>
                <a className="lp-btn lp-btn-primary" href="#/drop" onClick={() => setMenuOpen(false)}>Open the app</a>
              </div>
            </div>
          </nav>
        </div>
      </header>

      <main id="main" className="lp-main" tabIndex={-1}>
        {/* Hero: the one large green band on the page. */}
        <section className="lp-hero" aria-labelledby="hero-title">
          <div className="lp-wrap lp-hero-grid">
            <div>
              <h1 id="hero-title" className="lp-h1">Leak the document, not yourself.</h1>
              <span className="lp-flourish" aria-hidden="true" />
              <p className="lp-lede">
                Publish a document that anyone can check came from a group member, without revealing which member.
              </p>
              <div className="lp-actions">
                <a className="lp-btn lp-btn-ivory" href="#/drop">Open the app</a>
                <a className="lp-btn lp-btn-ghost" href="#how-it-works" onClick={jumpTo("how-it-works")}>See how it works</a>
              </div>
              <p className="lp-fine">
                Prototype. Membership proofs are mocked in the app today, and no request in this build is anonymous.
              </p>
            </div>
            <ReaderCard />
          </div>
        </section>

        {/* Problem */}
        <section id="problem" className="lp-section" aria-labelledby="problem-title">
          <div className="lp-wrap lp-split">
            <h2 id="problem-title" className="lp-h2">Proving where a document came from usually means giving up anonymity.</h2>
            <div className="lp-prose">
              <p className="lp-prose-lead">
                A source often needs to show that a document is authentic and came from inside an organisation. Publishing it
                usually ties the act to an identity, a wallet or an account.
              </p>
              <p>
                Once that link exists, anyone who can read the record, and every service that handled it, can connect the
                document to the person.
              </p>
              <p>
                ZeroDrop separates the two. The record shows that a group member posted it, and nothing about which member.
              </p>
            </div>
          </div>
        </section>

        {/* How it works: a real sequence, so it is numbered. */}
        <section id="how-it-works" className="lp-section" aria-labelledby="how-title">
          <div className="lp-wrap">
            <h2 id="how-title" className="lp-h2">How it works</h2>
            <ol className="lp-steps">
              <li className="lp-step">
                <span className="lp-step-n">1</span>
                <h3 className="lp-h3">Strip and fingerprint on your device</h3>
                <p>Your browser removes author, device and location data from images and PDFs, then computes the document's hash. Nothing leaves the device at this step.</p>
              </li>
              <li className="lp-step">
                <span className="lp-step-n">2</span>
                <h3 className="lp-h3">Pin to independent stores</h3>
                <p>The stripped file goes to independent IPFS pinning stores, two or more where you have configured them. Readers fetch it by content ID, not from a ZeroDrop server.</p>
              </li>
              <li className="lp-step">
                <span className="lp-step-n">3</span>
                <h3 className="lp-h3">Prove membership and record it on chain</h3>
                <p>The poster proves, in zero knowledge, that they belong to the group, and the record goes on chain. In this build the proof is a placeholder, and the chain is a local test chain.</p>
              </li>
              <li className="lp-step">
                <span className="lp-step-n">4</span>
                <h3 className="lp-h3">Anyone verifies</h3>
                <p>A reader checks, in their own browser, that the document matches its hash, that the record is on chain, and that the membership proof is valid. A mock proof is labelled as one.</p>
              </li>
            </ol>
          </div>
        </section>

        {/* Trust and design principles */}
        <section id="security" className="lp-section" aria-labelledby="security-title">
          <div className="lp-wrap">
            <h2 id="security-title" className="lp-h2">Trust and design principles</h2>
            <ul className="lp-cards">
              <li className="lp-card">
                <h3 className="lp-h3">Local first</h3>
                <p>Your document is processed in your browser. ZeroDrop runs no backend and needs no account. The file leaves your device only when you pin it, and only to the stores you choose.</p>
              </li>
              <li className="lp-card">
                <h3 className="lp-h3">One egress layer</h3>
                <p>Every network request is meant to leave through one module, so the transport can be changed in one place. Tor transport is in progress. No request in this build is anonymous yet.</p>
              </li>
              <li className="lp-card">
                <h3 className="lp-h3">Open source</h3>
                <p>Released under the MIT license. The public repository waits on a secrets scan of the full git history.</p>
              </li>
              <li className="lp-card">
                <h3 className="lp-h3">Honest trade-offs</h3>
                <p>A small group gives a small anonymity set, and the app shows the number. A record is public, and the timing of a post can still leak. The app shows these limits rather than hiding them.</p>
              </li>
            </ul>
          </div>
        </section>

        {/* Status */}
        <section id="status" className="lp-section" aria-labelledby="status-title">
          <div className="lp-wrap">
            <h2 id="status-title" className="lp-h2">Status</h2>
            <p className="lp-section-lede">What runs today, and what does not. As of 6 November 2026.</p>
            <div className="lp-status">
              <section className="lp-status-col" aria-labelledby="status-working">
                <h3 id="status-working" className="lp-h3">Working today</h3>
                <ul className="lp-list lp-list-done">
                  <li><strong>End-to-end flow on a test chain.</strong> Identity, group, post, pin, record, share and verify, in mock proof mode.</li>
                  <li><strong>Metadata stripping for images and PDFs.</strong> Images are re-encoded in the browser. PDFs are cleaned structurally, so embedded images, printer dots and generator fingerprints can remain.</li>
                  <li><strong>Document pinning.</strong> Verified against a real IPFS node (Kubo), with the file read back byte for byte.</li>
                  <li><strong>Reader verification.</strong> Content hash (L0) and record inclusion (L1) with a storage proof. With a single RPC, the state root is not cross-checked.</li>
                  <li><strong>Downloadable bundle.</strong> Carries the document and its checks, and verifies offline.</li>
                  <li><strong>Passphrase-encrypted identity.</strong> PBKDF2-SHA256 and AES-256-GCM. There is no passphrase recovery.</li>
                </ul>
              </section>
              <section className="lp-status-col" aria-labelledby="status-progress">
                <h3 id="status-progress" className="lp-h3">In progress</h3>
                <ul className="lp-list lp-list-open">
                  <li><strong>Anonymous posting through an alternative mempool.</strong> Built for a devnet. Not yet run against a live devnet.</li>
                  <li><strong>Tor transport in the browser.</strong> Built. Not yet run through Tor.</li>
                  <li><strong>Real zero-knowledge proofs in the app.</strong> Verified in node and on a local chain. The circuit files are not bundled.</li>
                  <li><strong>Public testnet deployment.</strong> Not yet deployed.</li>
                  <li><strong>Independent audit.</strong> Not yet done.</li>
                </ul>
              </section>
            </div>
            <p className="lp-section-lede lp-status-link">
              The detailed status table is in the repository README.{" "}
              <RepoLink href="#readme">Open the README</RepoLink>
            </p>
          </div>
        </section>

        {/* Roadmap: three horizons. No dates are set. */}
        <section id="roadmap" className="lp-section" aria-labelledby="roadmap-title">
          <div className="lp-wrap">
            <h2 id="roadmap-title" className="lp-h2">Roadmap</h2>
            <p className="lp-section-lede">Three horizons. No dates are set.</p>
            <ol className="lp-horizons">
              <li className="lp-horizon">
                <h3 className="lp-h3">Hackathon</h3>
                <p>A working prototype on a local chain, with mock proofs. Next: a posting run on the devnet, a Tor circuit, and real proofs in the app.</p>
              </li>
              <li className="lp-horizon">
                <h3 className="lp-h3">Testnet</h3>
                <p>A public testnet deployment. A light client in place of the header quorum. An independent audit of the contract. A first real group, with a newsroom or union as issuer.</p>
              </li>
              <li className="lp-horizon">
                <h3 className="lp-h3">Mainnet</h3>
                <p>After EIP-8141 activation and alternative-mempool builder support. The float is funded by grants and donations, with no team-held keys.</p>
              </li>
            </ol>
          </div>
        </section>

        {/* FAQ */}
        <section id="faq" className="lp-section" aria-labelledby="faq-title">
          <div className="lp-wrap">
            <h2 id="faq-title" className="lp-h2">Questions</h2>
            <div className="lp-faq">
              <details>
                <summary>Is it anonymous today?</summary>
                <p>Not yet on the public path. The posting transaction is sent from an account whose address appears on chain, and no network request in this build is routed anonymously. The anonymous path is in progress.</p>
              </details>
              <details>
                <summary>Do I need ETH or a wallet to publish?</summary>
                <p>The design says no. A contract pays for the transaction, so the source needs neither. That path has not run on a live devnet yet. The current demo uses a funded test account on a local chain.</p>
              </details>
              <details>
                <summary>Who can see my file?</summary>
                <p>Nobody, until you publish. Publishing uploads the stripped file to the pinning stores you choose, and those stores hold the bytes. Anyone with the content ID can read it, so do not publish what you would not want stored.</p>
              </details>
              <details>
                <summary>What if the pinners drop it?</summary>
                <p>Pin to more than one store. A reader can re-pin a verified document to a store they choose (keep it online). A bundle file carries the document and its checks, so it can be verified offline.</p>
              </details>
              <details>
                <summary>Is the proof real?</summary>
                <p>Not in the app yet. The membership check uses a mock verifier, and the app shows "Mock proof" for it. Real zero-knowledge proofs have been verified in node and on a local chain, but the circuit files are not bundled in the app.</p>
              </details>
              <details>
                <summary>Is it audited?</summary>
                <p>No. There has been no independent audit. An audit is part of the testnet stage.</p>
              </details>
              <details>
                <summary>Where is the code?</summary>
                <p>
                  In the project repository, under the MIT license. Public release waits on a secrets scan of the full git history.{" "}
                  <RepoLink href="">View the repository</RepoLink>
                </p>
              </details>
              <details>
                <summary>Can I use it for sensitive material?</summary>
                <p>No. It is a prototype. Do not use it for sensitive material yet.</p>
              </details>
            </div>
          </div>
        </section>

        {/* Final call to action */}
        <section className="lp-cta" aria-labelledby="cta-title">
          <div className="lp-wrap lp-cta-grid">
            <div>
              <h2 id="cta-title" className="lp-h2">Try the prototype</h2>
              <p className="lp-section-lede lp-cta-text">No account is needed. The app runs in your browser. It is a prototype, so do not use it for sensitive material yet.</p>
            </div>
            <div className="lp-actions lp-actions-cta">
              <a className="lp-btn lp-btn-primary" href="#/drop">Open the app</a>
              <RepoLink href="#readme">Read the docs</RepoLink>
            </div>
          </div>
        </section>
      </main>

      <footer className="lp-footer">
        <div className="lp-wrap lp-footer-grid">
          <div>
            <p className="lp-footer-name">ZeroDrop</p>
            <p className="lp-footer-note">Released under the MIT license.</p>
            <p className="lp-footer-note lp-footer-warn">Prototype. Do not use for sensitive material yet.</p>
          </div>
          <nav aria-label="Footer" className="lp-footer-nav">
            <ul>
              <li><a href="#how-it-works" onClick={jumpTo("how-it-works")}>How it works</a></li>
              <li><a href="#security" onClick={jumpTo("security")}>Security</a></li>
              <li><a href="#status" onClick={jumpTo("status")}>Status</a></li>
              <li><a href="#/about">About</a></li>
              <li><a href="#/d/">Read a disclosure</a></li>
              <li><RepoLink href="">Repository</RepoLink></li>
            </ul>
          </nav>
        </div>
      </footer>
    </div>
  );
}

/** A stylised reader check. An illustration, not a live record: the statuses are the honest state of the build. */
function ReaderCard() {
  return (
    <figure className="lp-verify" aria-label="Illustration of the three reader checks">
      <figcaption className="lp-verify-head">
        <span>Reader checks</span>
        <span className="lp-verify-tag">Illustration</span>
      </figcaption>
      <ol className="lp-verify-list">
        <li className="lp-check">
          <span className="lp-check-mark" aria-hidden="true">✓</span>
          <div>
            <strong>L0 Content</strong>
            <span className="lp-check-sub">The document matches its hash</span>
          </div>
          <span className="lp-check-state verified">Verified</span>
        </li>
        <li className="lp-check">
          <span className="lp-check-mark" aria-hidden="true">✓</span>
          <div>
            <strong>L1 Inclusion</strong>
            <span className="lp-check-sub">The record is on chain</span>
          </div>
          <span className="lp-check-state verified">Verified</span>
        </li>
        <li className="lp-check lp-check-mock">
          <span className="lp-check-mark" aria-hidden="true">◇</span>
          <div>
            <strong>L2 Membership</strong>
            <span className="lp-check-sub">A placeholder proof in this build</span>
          </div>
          <span className="lp-check-state mockmark">Mock proof</span>
        </li>
      </ol>
      <p className="lp-verify-foot">Shows the three checks the app runs. Not a live record.</p>
    </figure>
  );
}
