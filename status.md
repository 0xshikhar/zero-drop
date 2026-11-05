# ZeroDrop: implementation status

As of commit `2143f28` on `main`. Percentages are rough estimates of each phase in `docs/phases.md`, weighted toward what the demo and submission need. They are judgement calls, not measurements.

## Summary

The product works end to end on a **local anvil chain** with a **direct transaction**: strip, fingerprint, real Semaphore proof, `ZeroDrop.record`, then reader checks L0 and L2 (L1 is single-endpoint). The part that makes the project a submission for this hackathon, an **anonymous frame transaction admitted by the alt-mempool devnet**, has **not** been shown. The posting source is visible on chain in the current path.

| Area | Overall |
|---|---|
| Contracts and tests (local) | 80% |
| Core library | 65% |
| Web app (built, never driven in a browser by us) | 60% |
| Devnet / frame transaction / Anon-RPC | 15% |
| Content distribution (publish, pin, resolve) | 0% |
| Walk-away hardening | 10% |
| Submission material | 20% |

## Verified evidence

- `forge test`: 61 passing (ZeroDrop 37, frame checks 10, Semaphore adapter 14, including a real Groth16 proof).
- Core vitest: 63 passing, 3 skipped (the prove-and-verify round trip skips unless `SEMAPHORE_ARTIFACTS_DIR` is set).
- `scripts/demo.ts` on anvil: real proof generated and verified locally, recorded in block 12, L0, L1 and L2 pass. `record` uses about 400k gas.
- Web: `pnpm --filter @zerodrop/web build` and `tsc --noEmit` pass. Output is one 1.2 MB HTML file.

## Phase by phase

### Phase 0: de-risk (about 25%)
| Task | State |
|---|---|
| Devnet gate G1(a): a >100k VERIFY frame tx mined | **Not done.** Devnet TLS fails from this machine ("certificate is not yet valid") |
| G1(b) Anon-RPC worker reaches the devnet | Not done |
| G1(c) `eth_getProof` served? | Not checked |
| `make-fixture.ts` real Semaphore proof | Done (`contracts/test/fixtures/semaphore-proof.json`) |
| Semaphore verifier gas measured | Done locally (about 395k for `record` with depth 2). Not measured on the devnet |
| Workshop steps, `gas-spike.ts`, mentor questions | Not done |

### Phase 1: contracts and frame tx with MockVerifier (about 65%)
| Task | State |
|---|---|
| `ZeroDrop.sol` groups, roots, records, nullifiers, verifier lock, donate | Done |
| VERIFY fallback with every check | **Not done.** `DisclosureFrameChecks` library is written and tested, but no `fallback()` using the frame opcodes |
| `stake()` for the devnet registry | Not done |
| `IssuerSigGate` | Not done |
| `MockVerifier` | Done |
| `deploy.ts`, `seed-group.ts` | Done for the local chain. Not run on the devnet |
| `core/frametx.ts` | Built and round-trip tested offline. **Not verified against the devnet** |
| `demo.ts` | Done, direct-transaction path only |
| Milestone M1 (first disclosure mined on the devnet) | Not reached. Local equivalent only |

### Phase 2: networking and content (about 40%)
| Task | State |
|---|---|
| `net.ts` request counters, roles, isolation keys | Done. **No Anon-RPC worker**: all traffic is direct |
| `chain.ts` viem over `net.fetch`, quorum helper | Done |
| `content.ts` metadata strip | Text and images only. PDFs rejected. CID is computed |
| Publish and resolve through PressProtocol and a pinner | **Not done.** The PressProtocol packages are not on npm. A reader must supply the file themselves |
| Writes through Tor | Not done |
| Gate G2 | Not met |

### Phase 3: app UI (about 60%)
| Task | State |
|---|---|
| Tokens, layout shell, traffic counter | Done. `TorBoot` not applicable yet |
| `#/drop` 7-step flow | Built. Not exercised in a real browser |
| `#/d/<cid>` reader with L0, L1, L2 and "1 of N" | Built; read path checked against anvil by script |
| `#/groups`, `#/settings`, `#/about` | Built. Issuer add-members UI not built |
| `.zerodrop.json` export and offline verify (F9) | Not done |
| Multi-sidecar fan-out UI (F11) | Core code only |
| "Keep it online" re-pin (F19) | Not done |
| Gate G3 and backup video | Not met |

### Phase 4: ZK integration (about 60%)
| Task | State |
|---|---|
| `SemaphoreVerifierAdapter` | Done, verifies a real proof on chain |
| `prove.ts` real mode | Done in node. Browser path untested; circuit files not bundled |
| Bundle wasm/zkey, works offline | **Not done** (awaiting your decision) |
| `setVerifier` then `lock` via deploy | Done locally |
| L2 in `verify.ts` | Done, from the `Disclosed` log data (not from a decoded raw frame tx) |
| Negative test: same proof, different CID | Message binding is enforced in the contract and adapter. Confirm there is an explicit test before claiming it |
| `lint_bytecode.py` gas()-patch lint | Not done |
| Milestone M2 on the devnet | Not reached |

### Phase 5: walk-away and hardening (about 10%)
Single-file build works. Not done: IPFS pin and `file://` test, `sidecar/` one-command node, random delay (F12), working trade-off toggles (F13, shown disabled), CSP audit, stretch features.

### Phase 6: submission (about 20%)
README with an honest status and CROPS section exists. Not done: `evidence/txs.md`, admitted-tx links, canonical-mempool rejection evidence, 3-minute video, pitch rehearsal, repo public and secrets audit.

## Known deviations and risks

- Poster address is visible on chain in the current path. The anonymity claim depends on the frame path.
- The frame signature hash does not cover the proof bytes (ARBITRARY signature, empty message). The proof is bound only through `record()` calldata.
- `MIN_BODY_GAS` is 450,000, not 150,000, because a real proof needs about 395k.
- The issuer-published Merkle root is not checked by the contract. Readers rebuild and check it.
- L1 trusts one RPC (or a k-of-n agreement of block hashes). No storage proof.
- The identity key is stored unencrypted in IndexedDB.
- Demo anvil keys in `scripts/` are public test keys.
- Semaphore circuit files were downloaded once from `snark-artifacts.pse.dev` for local testing and are not in the repo.

## Priority plan for the final submission

The hackathon judges look for real alt-mempool usage, so the order below puts the devnet first. Each tier assumes the one above is done or has been explicitly cut.

### P0: without these there is no honest submission

1. **Unblock the devnet.** Check the machine clock and retry the endpoint. If the cert is genuinely not yet valid, try another network, ask the organisers or devnet team, or run a local ethrex devnet from the sidecar repo. Then run a minimal frame tx and `ethrex_simulateFrameTransaction`. This decides everything else. Fallback: keep the direct path and say so in the submission.
2. **Decide the circuit files** (bundle `semaphore-2.wasm`/`.zkey` into `apps/web/public/zk`, about 2-3 MB for depth 2) and **drive the app in a real browser** against anvil. Fix whatever breaks. Prove time in the browser is a number we need.
3. **VERIFY fallback in `ZeroDrop.sol`** using `HegotaSupport`, with the existing `DisclosureFrameChecks` rules, then deploy to the devnet, stake, and fund the float.
4. **First admitted frame tx** (M1), then with the real verifier (M2). Save hashes and explorer links to `evidence/txs.md`. Capture the canonical-mempool rejection.

### P1: needed for a convincing demo

5. **Document availability.** Replace the missing PressProtocol dependency with a concrete pinner (an IPFS pinning HTTP API) plus the `.zerodrop.json` bundle carrying the bytes (F9). Readers should resolve by CID without supplying the file.
6. **Anon-RPC integration** (`@anon-rpc/browser-harness`) behind `net.ts`, with the boot state in the UI. The privacy claim for readers and the source depends on it.
7. **Add-members issuer screen** (or a clear scripted flow) and group seeding on the devnet.
8. **Explicit negative tests**: proof copied to another CID rejected; replayed nullifier rejected; run against the devnet where possible.

### P2: strengthens the pitch

9. `sidecar/` one-command node and the switch-off demonstration (F7).
10. Single-file build pinned to IPFS and opened from `file://`.
11. Random submission delay (F12), working toggles (F13), CSP audit.
12. `eth_getProof` storage-proof verification for L1.
13. `lint_bytecode.py` for the gas()-patched verifier.

### P3: only if time remains

PDF stripping, encrypted identity at rest, Anon Aadhaar gate (F15), reproducible-build CID (F17), issuer rotation (F18).

### Submission checklist (do in parallel from P1 onward)

- [ ] Recorded backup video as soon as the browser flow works end to end; re-record with the devnet path
- [ ] `evidence/txs.md` with addresses, admitted-tx links, rejection evidence
- [ ] README: devnet run steps, trade-offs (why not ERC-4337, canonical mempool, float DoS, front-running, shared reputation), what pre-existed
- [ ] Secrets scan of the full git history; repo public, MIT
- [ ] Pitch rehearsal and Q&A drill

### If the devnet stays blocked

Cut P0.3 and P0.4 and P1.6 to "designed, not verified". Spend the time on P0.2, P1.5, P1.7, P2.10 and the video. State plainly in the submission that anonymity of the posting address is not achieved in the demo path.
