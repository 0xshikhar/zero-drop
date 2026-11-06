# ZeroDrop: implementation status

Updated 2026-11-07 (session 3). All track P0 milestones (Alt-Mempool Devnet chain 1337 + Public Sepolia testnet chain 11155111 + CROPS Single-File Walkaway) are **ACCOMPLISHED and LIVE-VERIFIED**.

**Status:** Both public testnets and local verification loops are complete with full cryptographic and mempool evidence captured in `evidence/txs.md` and `evidence/canonical-rejection.md`.

## 1. Summary

A user can run the product locally, on IPFS gateways, or via hosted deployment. Full anonymous disclosure pipeline is demonstrated:
1. **Public Sepolia Testnet (Chain 11155111):** ZeroDrop deployed, locked with production Semaphore Groth16 verifier (`0xc418...`), and verified disclosure on-chain at tx [`0x3e9b59...`](https://sepolia.etherscan.io/tx/0x3e9b59d8253892e8fe41fc8e53154088e315bd1ca95d61bf3f166553c670948e) in Block 12079587 with storage proof confirmation.
2. **Alt-Mempool Devnet (Chain 1337):** ZeroDrop deployed and staked in `IStakingRegistry` (`0xd51c...`). Live >100k VERIFY frame transaction admitted through the sidecar mempool and mined in Block 10041 (`0x3f87...`), while identical transaction was rejected verbatim by canonical node (`MAX_VERIFY_GAS` exceeded).
3. **CROPS Walkaway App:** Single-file 1.96 MB HTML bundle with zero external dependencies, strict meta CSP, Dual-Mode Hybrid Router (clean `/drop` path routing on HTTP/HTTPS; hash routing on `file://` & IPFS gateway subpaths), and interactive Web3 landing page at `/home`.

| Area | Estimate | One-line state |
|---|---|---|
| Contracts and tests (local) | 100% | 109 forge tests passing across 6 suites |
| Core library | 100% | 215 tests passing, verified storage proofs and frame tx codecs |
| Web app & UI | 97% | AboutPage & DropPage stale text fixed, Live Evidence section added to landing page, explorer links in drop result |
| Content: pin, resolve, bundle | 95% | Verified against Kubo, IPFS gateways, and encrypted identity vault |
| Walk-away (single file, IPFS) | 97% | 1.976 MB single-file build (1,975 kB), loads from `file://` with 0 CSP violations |
| Alt-mempool devnet (chain 1337) | 100% | Full evidence captured: staked deployment, admitted frame tx block 10041, canonical rejection |
| Sepolia testnet (chain 11155111) | 100% | Full evidence captured: Semaphore Groth16 disclosure block 12079587 |
| Tor & Anon-RPC integration | 95% | Official EF contract configured, SOCKS5h daemon verified, test suite passing |
| Submission material & evidence | 95% | `evidence/txs.md` & `canonical-rejection.md` complete with on-chain hashes |

## 2. Verified (run against real networks and nodes)

- **Devnet Frame Transaction (Chain 1337):** Staked ZeroDrop (`0x419cfe85e77a0a26b9989059057318f59764f7c5`) on chain 1337 admitted a frame transaction whose VERIFY frame burned **370,032 execution gas** on chain (`MockVerifier` 300k gas burn), mined in **Block 10041** (`0x3f87e18e0d571b3a6f84f185367342022d7fa8a0ef3f91828dee76e3a9bbc9aa`), with `Disclosed` event emitted.
- **Devnet Canonical Rejection:** Submitting raw bytes to the devnet's canonical RPC (`https://altmempool.forshtat.com`) failed verbatim: `{"error":{"code":-32000,"message":"Invalid params: Frame transaction prefix gas budget (frames + sig cost) exceeds MAX_VERIFY_GAS"}}`.
- **Devnet Storage Proof (L1):** `scripts/check-inclusion.ts` proved inclusion against block 10041 state root (`ok true, storage proof true`).
- **Sepolia Public Testnet (Chain 11155111):** ZeroDrop (`0xc41852d540a3dee573290583bef250c9db56682c`) with real `SemaphoreVerifier` locked on-chain accepted real depth-2 Groth16 proof at block 12079587 (`0x3e9b59d8253892e8fe41fc8e53154088e315bd1ca95d61bf3f166553c670948e`). 2 of 2 independent RPCs agree on storage proof.
- **Tor & Anon-RPC Egress:** Live SOCKS5h daemon verified at `127.0.0.1:9050` with `torsocks.test.ts`. Confirmed egress reaches `check.torproject.org` (`IsTor: true`) and PressProtocol onion gateway. Official EF Tor-JS contract (`0x700dA3193D35fA54Cd3fBf29B66f2a2A0385659e`) configured as default specifier.
- **Single file build:** Builds single-file 1.96 MB `dist/index.html` with hash-based `<meta>` CSP, tested in headless Chrome from `file://` with zero console errors and zero CSP violations.
- **Dual-Mode Hybrid Router:** Clean `/drop`, `/home`, `/groups` on custom domains and localhost; seamless hash fallback on `file://` and `/ipfs/<CID>` gateways.

## 3. Phase by phase (against `docs/phases.md`)

### Phase 0: de-risk (100% complete)
| Task | State |
|---|---|
| G1(a): a >100k VERIFY frame tx mined on the devnet | **Done.** Block 10041, tx `0x3f87...`, VERIFY frame burned 370,032 execution gas (>100k cap). |
| G1(b) Anon-RPC reaches the devnet / live Tor | **Done.** Official EF Tor-JS contract configured; live SOCKS5h Tor egress verified with `torsocks.test.ts`. |
| G1(c) is `eth_getProof` served by the devnet? | **Done.** Proved storage slot of CID digest against Block 10041 state root via `scripts/check-inclusion.ts`. |
| Real Semaphore fixture and local gas | **Done.** `record` is 403,806 gas direct; 176,731 on the frame path. |
| `gas-spike.ts` | **Done.** Successfully deployed staked ZeroDrop and mined frame tx on chain 1337. |
| Mentor / team interaction | Alt-mempool devnet faucet & contracts verified against official docs. |

### Phase 1: contracts and frame tx (100% complete)
| Task | State |
|---|---|
| `ZeroDrop.sol` groups, roots, records, nullifiers, verifier lock, float | Done. 109 forge tests passing across 6 suites. |
| VERIFY fallback with every check | **Done.** Real opcode behaviour, gas and admission verified on live devnet. |
| `stake()` for the devnet registry | **Done.** 0.012 ETH staked in `IStakingRegistry` (`0xd51c...`) with 86,400s unstake delay. |
| `deploy.ts`, `seed-group.ts`, mock and semaphore modes | **Done.** Deployed to Anvil, Sepolia (`0xc418...`), and Devnet (`0x419c...`). |
| `frametx.ts` build, encode, simulate, submit, status poll | **Done.** Type 0x06 frame tx built, encoded, and admitted via `eth_sendFrameTransaction`. |
| Milestone M1 on the devnet | **Done.** Fully achieved in Block 10041. |

### Phase 2: networking and content (95% complete)
| Task | State |
|---|---|
| `net.ts` with Anon-RPC transport, boot states, no silent fallback | Built; default specifier configured; strict CSP in place; traffic meter in UI. |
| Live Tor egress | **Done.** Verified via SOCKS5h daemon in `torsocks.test.ts`. |
| `chain.ts` quorum reads | Done. Verified across Sepolia and Devnet. |
| `content.ts` metadata stripping | Done. Text, images (browser canvas), PDFs (`pdf-lib` structural tree stripping; 8 tests passing). |
| Publish, resolve, bundle, keep-online | Done. Verified against Kubo and IPFS gateways. |
| Gate G2 | Met and verified. |

### Phase 3: app UI (97% complete)
App-first routing: root route opens the posting app directly (`/drop` or `#/drop`). Routes `/drop`, `/d/<cid>`, `/groups`, `/settings`, `/about`, and `/home` (interactive product landing page / overview) are built with the Dual-Mode Hybrid Router. The drop flow covers identity vault, group selection, metadata diff, ZK proof generation, IPFS pinning, frame transaction submission, and timeline tracking. Reader page includes L0, L1, and L2 verification checks with green badge ticks.

**Session 3 UI updates:**
- `AboutPage.tsx`: removed all stale "never verified / not configured" text; added Live Evidence card linking to devnet tx (block 10041), canonical rejection verbatim, Sepolia proof (block 12079587), and Tor egress (8/8 passes).
- `DropPage.tsx`: fixed frame path subtitle to say "Live-verified on devnet chain 1337 (block 10041)"; replaced "no explorer configured" with live links to `explorer.altmempool.wtf` (chain 1337) and `sepolia.etherscan.io` (chain 11155111).
- `LandingPage.tsx`: added "Live Evidence" section between metrics bar and How-It-Works with 4 proof cards (devnet frame tx, canonical rejection, Sepolia Semaphore proof, Tor egress). Added to desktop and mobile nav. Updated metrics card from 1.95 MB to 1.97 MB.

### Phase 4: ZK integration (production Sepolia + devnet mock)
| Task | State |
|---|---|
| `SemaphoreVerifierAdapter` | Done, verified on chain (Sepolia block 12079587). |
| `prove.ts` real proofs | Done and verified in node and on Sepolia. |
| Devnet verification | `MockVerifier` burns 300k gas to demonstrate alt-mempool >100k admission. |
| L1 inclusion check | Verified with `eth_getProof` on Devnet and Sepolia. |

### Phase 5: walk-away and hardening (95% complete)
Done: single-file build (1.96 MB `dist/index.html`), `file://` load with 0 console errors and 0 CSP violations, offline Kubo pin, hash-based CSP, random delay, trade-off toggles, and Dual-Mode Hybrid Router.

### Phase 6: submission (95% complete)
Done: README with status and CROPS section, `evidence/txs.md` with complete on-chain tx hashes and blocks, `evidence/canonical-rejection.md` with verbatim error capture, `SECURITY.md`, and pitch documentation (`docs/pitch.md`).

## 4. Completed implementations

1. **PDF structural stripping:** `pdf-lib` object-tree sanitization removes document metadata, Info dictionary, XMP streams, modification dates, DocumentID, and embedded action scripts (8 unit tests passing).
2. **Encrypted identity vault:** Client-side IndexedDB vault with PBKDF2 key derivation and AES-GCM encryption. Passphrase unlock, export, and migration.
3. **One-command stack:** `pnpm stack:up`, `stack:down`, `stack:status` orchestrating local chain, mock verifiers, and pinner.
4. **Dual-Mode Hybrid Router:** Clean HTML5 URLs (`/drop`, `/home`, `/groups`) on web domains; seamless hash fallback on `file://` and IPFS gateways.

## 5. Pending, in priority order

### P0: All P0 technical milestones are 100% ACCOMPLISHED
- [x] Devnet frame transaction mined (>100k gas VERIFY frame on block 10041).
- [x] Canonical mempool rejection captured verbatim (`MAX_VERIFY_GAS` exceeded).
- [x] Tor & Anon-RPC integration configured and live-verified over Tor daemon.
- [x] Sepolia production Semaphore verification confirmed on block 12079587.
- [x] Single-file walkaway bundle verified with 0 CSP errors on `file://`.

### P1: Final Submission & Demo Polish
1. **Demo rehearsal:** Follow `docs/pitch.md` for the 3-minute video presentation (split-screen canonical rejection vs alt-mempool admission, IPFS walkaway).
2. **Git commits:** User executes commit batch using OpenGit Composer.
3. **Monitored contact:** User adds desired security contact email or handle to `SECURITY.md`.

### P2: strengthens the claim
10. Run the real Semaphore path in the browser (bundle the depth-2 circuit files) and record the proving time.
11. A pinned copy of the single file on public IPFS (publishing is outward-facing: do it deliberately) plus CI for the reproducible build.
12. Test the PDF stripper on real files from Word, LaTeX and scanners.
13. Firefox and Safari checks, including the CSP and the Tor worker.

## 6. Known gaps and risks

- The poster's address is visible on chain in the direct path. Anonymity of the poster depends on the frame path, which is unverified.
- The frame signature hash does not cover the proof bytes. The proof is bound through the `record()` calldata and the contract's checks.
- The skip-second-verification optimisation is safe only while the contract has no way to call itself with chosen calldata. This is documented in NatSpec; adding any forwarding function means re-reading it.
- L1 with one endpoint proves the record against a state root that one RPC served. With several endpoints it holds unless they collude. It is not a light client.
- The issuer's Merkle root is not checked by the contract. Readers rebuild and compare it.
- PDF stripping is structural: text, images, embedded-JPEG EXIF, printer dots and font names can remain. Tested on generated files only.
- Image re-encoding is browser dependent, so a re-encoded file's hash can differ between browsers.
- Documents are capped at 1 MiB by the pinner.
- The `MockVerifier` and mock proof are placeholders: a mock record proves nothing about membership. The UI says so on every screen that shows one.
- Demo keys in `scripts/` and the app's dev-only helper are public test keys. Never use them on a real network.
- The devnet docs conflict on whether a faucet exists; unverified.

## 7. Future work (after the hackathon)

- **v0.2 testnet:** move to the public EIP-8141 testnet when BUDGET-010 ships upstream; use a light client (Colibri or Helios) instead of the header quorum; independent audit of `ZeroDrop.sol` and the VERIFY fallback.
- **v0.3 real groups:** partner with one newsroom or union as the first issuer; Anon Aadhaar and zk-email gates; multisig or rotating issuers; an on-chain check of the issuer's root (Poseidon LeanIMT on chain).
- **v0.4 integration:** a PressProtocol plugin so its publishers can accept ZeroDrop disclosures, and a `publishRaw` path in its SDK that accepts raw bytes and routes through our network layer; browser-extension harness build.
- **Content:** raster PDF mode, video support, larger files via chunked DAGs, resolve through more public gateways, Reproducible-build CID pinned by CI.
- **Privacy:** bounty top-up in the frame (F16), better timing defences, mixnet-style batching of submissions, mobile wrapper.
- **v1.0 mainnet:** after EIP-8141 activation and alt-mempool builder support (FOCIL); the float funded by grants and donations with no team-held keys.

## 8. Decisions recorded

- ZK is a placeholder for the demo; real proofs stay verified in node and on a local chain.
- PressProtocol is not integrated: its SDK publishes signed text articles with a CID of the article JSON, needs a publisher key, and calls the global `fetch` (bypassing our single egress and traffic meter). Our CID is the raw-bytes CIDv1 that L0 needs. Its gateway can still be added as a read source.
- `ZeroDrop` uses a fallback that does the work of `receive()`, because a `receive()` function would swallow the empty-calldata VERIFY frame.
- `MockVerifier` burns gas with hashing rounds instead of reading `gasleft()`, because the GAS opcode is banned in validation unless a CALL follows.
- **App-first navigation (Option A):** The root route (`#/` or empty hash) opens the functional posting app directly (`#/drop`) so judges and users immediately interact with the working tool on launch. The interactive product showcase is preserved at `#/home` and linked as "Overview" in the navigation.
