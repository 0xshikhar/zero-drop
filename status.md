# ZeroDrop: implementation status

Updated 2026-11-06 (UTC 22:15 on 2026-11-05 by the machine clock), at commit `83ce746` on `main` (with uncommitted Landing Page work in the working tree). Percentages are estimates against `docs/phases.md`, weighted toward what the demo and submission need. They are judgement calls, not measurements.

**Direction:** ZK/Semaphore proving is a placeholder in the browser for now. Everything else is built to work as a usable product in **mock proof mode**. The real Semaphore path is built and was verified in node and on a local chain, but the circuit files are not bundled in the app.

## 1. Summary

A person can run the product locally today, with one command (`pnpm stack:up`), through a complete end-to-end flow: visit the front door, create or unlock an encrypted identity vault, choose a group and a case, drop a text, image, or PDF file, inspect and strip metadata, publish it across pinners, post a record on chain, share a link, and let a reader verify it. The reader gets a content-hash check (L0), an inclusion check with a real cryptographic storage proof against state roots (L1), and a membership-proof check (L2) that honestly reads **"Mock proof"** in mock mode.

What is **not** shown yet, and remains the primary hackathon gate: an **anonymous frame transaction admitted by the alt-mempool devnet**, and a **real Tor circuit in the browser harness**. In the local direct path the poster's address is visible on chain.

| Area | Estimate | One-line state |
|---|---|---|
| Contracts and tests (local) | 90% | 109 forge tests passing across 6 suites. VERIFY fallback written, tested against mocked frame opcodes |
| Core library | 95% | 215 tests passing, 16 skipped (live or ZK). Added PDF stripper, SOCKS5h Tor client, encrypted vault |
| Web app, mock mode | 90% | Driven end to end in browser; Landing Page, encrypted identity vault, and PDF drop/reader flow added |
| Content: pin, resolve, bundle, keep-online | 95% | Text, images, and structural PDF stripping (`pdf-lib`); verified with Kubo and Zerodrop pinner |
| Walk-away (single file, IPFS, reproducible build) | 80% | 1.95 MB single-file HTML, `file://` verified; one-command stack script (`stack.ts`) orchestrates local stack |
| Devnet, frame tx, Anon-RPC (Tor) | 25% | SOCKS5h Node Tor transport built & tested; devnet blocked by TLS cert window (~05:31 GMT); contracts ready |
| ZK / Semaphore in the app | placeholder | Real in node and on chain; mock in the app by design |
| Submission material (video, pitch, evidence) | 40% | Evidence files, README, and SECURITY.md exist; pending 3-minute video and live devnet evidence |

## 2. Verified (it was run, and the output is in the repo or was observed)

- **Contracts:** `forge test` 109 passing across 6 suites in 18 ms. Includes a real Groth16 proof accepted by the on-chain verifier, and rejected for another CID or after a one-bit change.
- **Core:** `pnpm test:core` 215 passed, 16 skipped across 21 test suites. Skipped tests require circuit files or live network daemons (Kubo, public gateway, or Tor daemon).
- **PDF metadata stripping:** 8 unit tests passing (`pdf.test.ts`). Strips Info dicts, XMP streams, PieceInfo, DocumentID, EmbeddedFiles, JavaScript, AdditionalActions, and AnnotationAuthor without rasterising.
- **Encrypted Identity Vault:** 9 unit tests passing (`vault.test.ts`). Passphrase-derived AES-GCM + PBKDF2 encryption in IndexedDB, with migration from unencrypted sessions, lock/unlock, and backup export/import.
- **Tor egress for Node:** 9 tests (6 passing, 3 live skipped) in `torsocks.test.ts`. Verified SOCKS5h proxy transport for Node scripts, ensuring remote DNS resolution over Tor.
- **One-command stack:** `scripts/stack.ts` (`pnpm stack:up`, `stack:status`, `stack:down`) orchestrates anvil, contract compilation, mock deployment, group seeding, pinner service, optional offline Kubo, and Vite dev server.
- **Real Kubo:** pin, resolve through its gateway and re-pin all verified (4 live tests). Our CID equals Kubo's single-block CID.
- **Public gateway read:** a known CID resolved through `gateway.pinata.cloud` and hash-checked.
- **L1 storage proof:** `eth_getProof` verified locally against the state root, with the block hash re-derived from the header; checked live on anvil (4 live tests) and against tampered proofs (35 tests).
- **Browser run, mock mode:** identity vault, post flow (text, image, PDF), pin to two pinners, delay countdown and cancel, reader L0/L1, L2 "Mock proof", keep-it-online, bundle download and offline verify, tamper detection, issuer panel (create group, add members), settings, responsive layout down to mobile width.
- **Single file build:** one self-contained HTML file, 1.95 MB, no external scripts, links, images or font references. Loads from `file://` in headless Chrome with zero console errors and zero CSP violations. Clean builds are byte-identical.
- **IPFS:** pinned into an offline local Kubo node and read back byte for byte.
- **Real-proof disclosure on a local chain:** `scripts/demo.ts` recorded a disclosure with a real Semaphore proof, with L0, L1 and L2 passing (`evidence/txs.md`).

## 3. Phase by phase (against `docs/phases.md`)

### Phase 0: de-risk (about 45%)
| Task | State |
|---|---|
| G1(a): a >100k VERIFY frame tx mined on the devnet | **Not done.** Devnet TLS certificate is "not yet valid" from this machine (valid from 2026-11-06 05:31:33 GMT) |
| G1(b) Anon-RPC reaches the devnet | Not done |
| G1(c) is `eth_getProof` served by the devnet? | Not checked on devnet. Verified on anvil |
| Real Semaphore fixture and local gas | Done. `record` is 403,806 gas direct; 176,731 on the frame path |
| `gas-spike.ts` | Written, `--dry` verified, live path awaiting devnet cert |
| Mentor questions | In progress |

### Phase 1: contracts and frame tx (about 85%)
| Task | State |
|---|---|
| `ZeroDrop.sol` groups, roots, records, nullifiers, verifier lock, float | Done |
| VERIFY fallback with every check | **Written**, 40 tests in `ZeroDropFrameTest` with scripted frame opcodes. Real opcode behaviour, gas and admission are unverified |
| `stake()` for the devnet registry | Written (interface from upstream docs), tested against a mock registry |
| `deploy.ts`, `seed-group.ts`, mock and semaphore modes | Done on a local chain; ready for devnet |
| `frametx.ts` build, encode, simulate, submit, status poll | Built; encoding round-trips offline; **never sent to a live node** |
| Milestone M1 on the devnet | Awaiting devnet TLS cert window |

### Phase 2: networking and content (about 95%)
| Task | State |
|---|---|
| `net.ts` with Anon-RPC transport, boot states, no silent fallback | Built; booted with worker harness in headless Chrome; **never run against Tor live** |
| `torsocks.ts` Node Tor SOCKS5h client | Built, unit tested, 6 tests passing |
| `chain.ts` quorum reads and L1 storage proof verification | Done |
| `content.ts` and `pdf.ts` metadata stripping | Text, images (browser canvas), and PDFs (structural `pdf-lib` stripping) |
| Publish, resolve, bundle, keep-online | Done and verified (see section 2) |
| Gate G2 | Met locally |

### Phase 3: app UI (about 90%)
Routes `#/home` (landing page), `#/drop`, `#/d/<cid>`, `#/groups`, `#/settings`, `#/about` are built. The drop flow covers identity vault unlock, 8 drop steps (identity, group and case, file, metadata diff, anonymity set, publish, post, timeline). Encrypted identity vault UI (`IdentityPanel.tsx`) supports passphrase protection, migration, lock/unlock. Responsive Landing Page (`LandingPage.tsx`) built with accessibility skips, feature breakdowns, and direct CTAs.

### Phase 4: ZK integration (placeholder by decision)
| Task | State |
|---|---|
| `SemaphoreVerifierAdapter` | Done, verified on chain |
| `prove.ts` real proofs | Done and verified in node; browser deferred |
| Bundle circuit files for the browser | **Not done** (deliberately deferred to keep single-file build under 2 MB) |
| L2 real check | Done in core; the app shows it for non-mock deployments |
| Milestone M2 on the devnet | Not reached |

### Phase 5: walk-away and hardening (about 80%)
Done: single-file build and check, `file://` load, reproducible-build check, offline Kubo pin, CSP (hash-based, zero `unsafe-inline` in the build), random delay, trade-off toggles, one-command stack orchestration script (`scripts/stack.ts`). Written but not run: `sidecar/run.sh`. Not done: a pinned public IPFS copy, CI for reproducible builds.

### Phase 6: submission (about 40%)
Done: README with status and CROPS section, `evidence/` (local chain data, IPFS pin, devnet status, canonical-rejection procedure), `SECURITY.md`. Not done: devnet transaction evidence link, canonical-mempool rejection capture, 3-minute video, pitch rehearsal, public repo and secrets scan.

## 4. In progress and recently landed

1. **Landed in commit `83ce746`:**
   - Full PDF support in core and web UI: `packages/core/src/pdf.ts`, PDF drop/reader flow in `DropPage.tsx` and `ReaderPage.tsx`, PDF bundle verification.
   - Encrypted Identity Vault: `packages/core/src/vault.ts`, `apps/web/src/ui/IdentityPanel.tsx`, `session.ts` with passphrase encryption, unlock/lock states, session migration.
   - Node Tor egress: `packages/core/src/torsocks.ts` via SOCKS5h.
   - One-command local stack automation: `scripts/stack.ts` (`pnpm stack:up`, `pnpm stack:down`, `pnpm stack:status`).
2. **Currently in working tree (uncommitted):**
   - High-impact Landing Page (`apps/web/src/ui/LandingPage.tsx`, `apps/web/src/styles/landing.css`).
   - Router support for `#/home` front door in `apps/web/src/lib/router.ts`.
   - Route-specific meta titles and descriptions in `apps/web/src/ui/App.tsx`.
   - Topbar navigation updates in `apps/web/src/ui/Shell.tsx`.

## 5. Pending, in priority order

### P0: blocked by time, access or your decision
1. **Devnet frame transaction & admission.** The Let's Encrypt certificate for `altmempool.forshtat.com` becomes valid at 2026-11-06 05:31:33 GMT. Once valid:
   - Run `pnpm tsx scripts/check-devnet.ts`.
   - Deploy: `pnpm contracts:deploy --mock --direct=false --stake ... --fund ...`.
   - Run `scripts/gas-spike.ts` to submit an EIP-8141 frame tx.
   - Record the admitted transaction hash on `https://explorer.altmempool.wtf` in `evidence/txs.md`.
2. **Canonical-mempool rejection capture.** Submit the exact same >100k verification frame transaction to a standard execution node and capture the RPC error / rejection log per `evidence/canonical-rejection.md`.
3. **Decisions needed from you:**
   - Confirm maintainer contact address to replace the TODO in `SECURITY.md`.
   - Confirm whether to lower `MIN_BODY_GAS` from 450k to 250k (gas measured at 177k on frame path).
   - Reaffirm keeping circuit files deferred for the demo build (keeps distribution single-file at 1.95 MB).

### P1: needed for a winning hackathon submission
4. **3-Minute Demo Video (Mandatory for CROPS & Access Layer):**
   - Follow `docs/pitch.md`.
   - Include the killer "Walkaway / Pull the plug" demo: switch off the dev server or local node, open `dist/index.html` via `file://`, and verify the disclosure bundle and cryptographic proof offline.
   - Show the Anon-RPC traffic meter reflecting anonymous requests.
5. **Pitch rehearsal and narrative framing:**
   - Position ZeroDrop as the CROPS evolution of PressProtocol directly addressing Devcon 8's ETHBEAT CROPS launch and the EF Access Layer "Zero Option" mandate.
6. **Repository hygiene before public release:**
   - Run a git history secrets scan (`git log -p`).
   - Reconcile stale statements in `README.md` (e.g. update the PDF row and identity vault description which are now implemented).
   - Update `packages/core/src/pin.ts` header note regarding PressProtocol 1.0.7.
7. **Sidecar rehearsal:**
   - Run `sidecar/run.sh` with Docker or cargo if available to demonstrate private builder fallback.

### P2: strengthens the submission
8. **Public IPFS pinning:** Pin `dist/index.html` to a public IPFS gateway and record its CID.
9. **Real Semaphore proving time test:** Benchmark client-side proving time in Node with depth 2 circuits for evidence records.
10. **Cross-browser check:** Verify strict hash-based CSP behavior in Firefox and Safari.

## 6. Known gaps and risks

- **Posting path on local anvil:** Direct transactions show the poster's account on chain. Anonymity requires the frame transaction path on an alt-mempool node.
- **Proof signature binding:** Frame signature hash covers sender, calldata, and nonces, but does not hash the raw proof bytes themselves; binding relies on contract-level verification of `record()` parameters.
- **PDF structural vs visual stripping:** Structural stripping removes metadata objects, document IDs, embedded files, and scripts, but does not rasterise pages; visual markings, printer steganography, or redactions in content streams are out of scope.
- **Devnet certificates:** Alt-mempool devnet TLS certificate start date (05:31 GMT Nov 6) blocked earlier testing.
- **MockVerifier mode:** Active in browser demo builds; clearly flagged as "Mock proof" in reader UI.
- **L1 state root verification:** Proves storage against state root from queried block header. Light client proof verification (Helios/Colibri) is targeted for v0.2.

## 7. Future work (after the hackathon)

- **v0.2 testnet:** Move to public EIP-8141 testnet once BUDGET-010 is activated; integrate Helios/Colibri light client header verification.
- **v0.3 issuer ecosystem:** Real-world newsroom/whistleblower integrations; Anon Aadhaar / zk-email gates for anonymous credential issuance; on-chain Poseidon LeanIMT root verification.
- **v0.4 PressProtocol integration:** Plugin for PressProtocol publishers to accept ZeroDrop disclosures via `publishRaw`.
- **Content scaling:** Raster PDF mode, chunked IPFS DAGs for files >1 MiB.

## 8. Decisions recorded

- **Vite single-file build over Next.js:** ZeroDrop strictly uses Vite with `vite-plugin-singlefile` rather than Next.js. Next.js produces fragmented asset chunks, requires server runtimes or web servers, injects dynamic scripts that break strict CSP, and fails the CROPS "Walkaway Test" (cannot run directly from `file://` or raw IPFS without a server). Vite builds an auditable, deterministic, 1.95 MB single HTML file with strict hash-pinned CSP (zero `unsafe-inline`).
- **Mock proofs in the browser:** ZK circuits (~few MBs) are excluded from the single-file web bundle to ensure instant loading, deterministic single-file portability, and zero-fail demo reliability. Real Semaphore proofs are verified in Node and on-chain.
- **Encrypted identity vault in browser:** Identities in IndexedDB are protected by user passphrase using AES-GCM + PBKDF2 (`vault.ts`), replacing unencrypted session storage.
- **Contract fallback instead of `receive()`:** `ZeroDrop` uses a fallback function to process both Ether transfers and empty-calldata EIP-8141 VERIFY frames without conflicts.
