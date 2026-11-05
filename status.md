# ZeroDrop: implementation status

Updated 2026-11-06 (UTC 21:41 on 2026-11-05 by the machine clock), at commit `62a6805` on `main`. Percentages are estimates against `docs/phases.md`, weighted toward what the demo and submission need. They are judgement calls, not measurements.

**Direction:** ZK/Semaphore proving is a placeholder for now. Everything else is built to work as a usable product in **mock proof mode**. The real Semaphore path is built and was verified in node and on a local chain, but the circuit files are not bundled in the app.

## 1. Summary

A person can run the product locally today, with one flow: create an identity, choose a group and a case, drop a file, see the metadata removed, publish it to at least two pinners, post a record on chain, share a link, and let a reader verify it. The reader gets a content-hash check (L0), an inclusion check with a real storage proof (L1), and a membership-proof check (L2) that honestly reads **"Mock proof"** in mock mode.

What is **not** shown yet, and is the core hackathon claim: an **anonymous frame transaction admitted by the alt-mempool devnet**, and a **real Tor circuit**. In the current path the poster's address is visible on chain.

| Area | Estimate | One-line state |
|---|---|---|
| Contracts and tests (local) | 90% | 109 forge tests. VERIFY fallback written, tested against mocked frame opcodes only |
| Core library | 90% | 209 tests passing, 13 skipped (live or ZK) |
| Web app, mock mode | 85% | Driven end to end in a real browser |
| Content: pin, resolve, bundle, keep-online | 90% | Verified against a real Kubo node and a public gateway read |
| Walk-away (single file, IPFS, reproducible build) | 75% | Verified locally; sidecar launcher written, never run |
| Devnet, frame tx, Anon-RPC (Tor) | 20% | Built; never run against a devnet or Tor |
| ZK / Semaphore in the app | placeholder | Real in node and on chain; mock in the app by design |
| Submission material (video, pitch, evidence) | 35% | Evidence files and README exist; no video, no devnet evidence |

## 2. Verified (it was run, and the output is in the repo or was observed)

- **Contracts:** `forge test` 109 passing across 6 suites. Includes a real Groth16 proof accepted by the on-chain verifier, and rejected for another CID or after a one-bit change.
- **Core:** `pnpm test:core` 209 passed, 13 skipped. Skipped tests need the circuit files, a live Kubo, or a live gateway.
- **Real Kubo:** pin, resolve through its gateway and re-pin all verified (4 live tests). Our CID equals Kubo's single-block CID.
- **Public gateway read:** a known CID resolved through `gateway.pinata.cloud` and hash-checked. `ipfs.io` and `dweb.link` failed that run (HTTP 429).
- **L1 storage proof:** `eth_getProof` verified locally against the state root, with the block hash re-derived from the header; checked live on anvil (4 live tests) and against tampered proofs (35 tests).
- **Browser run, mock mode** (anvil, Kubo, a pinner): identity, post, pin to two pinners, delay countdown and cancel, reader L0/L1, L2 "Mock proof", keep-it-online, bundle download and offline verify, tamper detection, issuer panel (create group, add members), settings, phone width without horizontal scroll.
- **Single file:** the build is one HTML file, 1.9 MB, no external script, link, image or font. It loads from `file://` in headless Chrome with no console error or CSP violation. Two clean builds were byte-identical on this machine.
- **IPFS:** pinned into an offline local Kubo node and read back byte for byte. Nothing was published to the public network.
- **Real-proof disclosure on a local chain:** `scripts/demo.ts` recorded a disclosure with a real Semaphore proof, with L0, L1 and L2 passing (`evidence/txs.md`).

## 3. Phase by phase (against `docs/phases.md`)

### Phase 0: de-risk (about 40%)
| Task | State |
|---|---|
| G1(a): a >100k VERIFY frame tx mined on the devnet | **Not done.** Devnet TLS certificate is "not yet valid" from this machine (valid from 2026-11-06 05:31:33 GMT, about 8 hours after the machine clock) |
| G1(b) Anon-RPC reaches the devnet | Not done |
| G1(c) is `eth_getProof` served by the devnet? | Not checked. Works on anvil |
| Real Semaphore fixture and local gas | Done. `record` is 403,806 gas direct; 176,731 on the frame path |
| `gas-spike.ts` | Written, `--dry` verified, live path untested |
| Mentor questions | Not done |

### Phase 1: contracts and frame tx (about 80%)
| Task | State |
|---|---|
| `ZeroDrop.sol` groups, roots, records, nullifiers, verifier lock, float | Done |
| VERIFY fallback with every check | **Written**, 32+ tests with scripted frame opcodes. Real opcode behaviour, gas and admission are unverified |
| `stake()` for the devnet registry | Written (interface from upstream docs), tested against a mock registry only |
| `IssuerSigGate` | Not done (optional) |
| `deploy.ts`, `seed-group.ts`, mock and semaphore modes | Done on a local chain; never run on the devnet |
| `frametx.ts` build, encode, simulate, submit, status poll | Built; encoding round-trips offline; **never sent to a node** |
| Milestone M1 on the devnet | Not reached. Local equivalent only |

### Phase 2: networking and content (about 85%)
| Task | State |
|---|---|
| `net.ts` with Anon-RPC transport, boot states, no silent fallback | Built; booted only with a fake worker in headless Chrome; **never run against Tor** |
| `chain.ts` quorum reads | Done |
| `content.ts` metadata stripping | Text, images (browser canvas), PDFs (structural, see limits) |
| Publish, resolve, bundle, keep-online | Done and verified (see section 2). PressProtocol was evaluated and not used (below) |
| Gate G2 | Met locally, without Tor |

### Phase 3: app UI (about 85%)
Routes `#/drop`, `#/d/<cid>`, `#/groups`, `#/settings`, `#/about` are built. The drop flow is 8 steps (identity, group and case, file, metadata, anonymity set, publish, post, timeline). Reader, bundle verify, keep-it-online, issuer panel, live trade-off toggles, Tor boot panel and traffic meter are built and were driven in a browser. Multi-sidecar fan-out is wired but disabled without a devnet deployment. Recorded backup video: not done.

### Phase 4: ZK integration (placeholder by decision)
| Task | State |
|---|---|
| `SemaphoreVerifierAdapter` | Done, verified on chain |
| `prove.ts` real proofs | Done and verified in node; browser untested |
| Bundle circuit files for the browser | **Not done** (deliberately deferred) |
| L2 real check | Done in core; the app shows it only for non-mock deployments |
| `lint_bytecode.py` for the gas()-patched verifier | Not done |
| Milestone M2 on the devnet | Not reached |

### Phase 5: walk-away and hardening (about 65%)
Done: single-file build and check, `file://` load, reproducible-build check, offline Kubo pin, CSP (hash-based, no `unsafe-inline` in the build), random delay, trade-off toggles. Written but not run: `sidecar/run.sh`. Not done: a pinned public IPFS copy, CI for the reproducible build, a real take-the-hosted-site-offline rehearsal.

### Phase 6: submission (about 35%)
Done: README with status and CROPS section, `evidence/` (local chain data, IPFS pin, devnet status, canonical-rejection procedure), `SECURITY.md`. Not done: devnet transaction evidence, canonical-mempool rejection capture, 3-minute video, pitch rehearsal, public repo and secrets scan of full history.

## 4. In progress at the time of writing

A follow-up agent is finishing: PDF support in the drop flow (file picker, diff view, About text), the encrypted identity vault in the UI (passphrase set, unlock, migrate, lock, delete), and a one-command local stack (`pnpm stack:up`, `stack:down`, `stack:status`). None of these is committed yet; check `git log` for the commit that lands them.

## 5. Pending, in priority order

### P0: blocked by time, access or your decision
1. **Devnet frame transaction.** The certificate becomes valid around 05:31 GMT on 2026-11-06. Then run, in order: `pnpm tsx scripts/check-devnet.ts`; deploy with `--mock --direct=false --stake ... --fund ...`; `scripts/gas-spike.ts`. Capture the admitted-transaction links in `evidence/txs.md` and the canonical-mempool rejection per `evidence/canonical-rejection.md`. Expect to fix at least some of the unverified assumptions: simulate parameters, the cost estimate, `TXPARAM 0x06`, whether the VERIFY frame arrives with empty calldata, and APPROVE behaviour.
2. **BUDGET-010 admission.** The sidecar must admit a >100k VERIFY. We do not have the patched branch or a precompile allowlist. Ask the alt-mempool team; the fallback is to demo on the local mock path and state the gap.
3. **Real Tor circuit.** Needs the Anon-RPC specifier and bootstrap RPC (`VITE_ANON_SPECIFIER`, `VITE_ANON_BOOTSTRAP_RPC`) and a run on a machine with Tor-capable network access.
4. **Decisions needed from you:**
   - Lower `MIN_BODY_GAS` from 450k to about 250k (measured 177k on the frame path; mirrored in six files).
   - A monitored contact address for `SECURITY.md` (a visible TODO).
   - Whether to flip the app to real proofs later (bundle the circuit files).

### P1: needed for a convincing submission
5. 3-minute video and a backup recording (follow `docs/pitch.md`, include the take-the-hosted-site-offline moment).
6. Pitch rehearsal and the Q&A drill.
7. Secrets scan of the whole git history; make the repo public.
8. Fix stale text: the README row on PDFs, `pin.ts` header claiming PressProtocol is unpublished (it is published, 1.0.7).
9. Run the sidecar launcher for real once Docker or a cargo checkout is available; run the "remove the hosted sidecar" rehearsal.

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
