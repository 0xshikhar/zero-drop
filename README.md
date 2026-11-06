# ZeroDrop

**Leak the document, not yourself.** ZeroDrop lets a member of a group (a newsroom, a union, a port authority's staff) publish a document that anyone can check against that group's membership list without learning which member posted it. The document is stripped of metadata and fingerprinted, a Semaphore zero-knowledge proof ties the fingerprint to "one of the N members, once per case", and the record goes on chain. The design (docs/architecture.md) sends the record as an EIP-8141 frame transaction in which the contract is the sender and the payer, so the source needs no ETH and no wallet, through an alternative mempool, with every request over Anon-RPC (Tor), and ships as one HTML file with no backend. **The core anonymous frame transaction path and mempool admission are live-verified on the hackathon devnet (chain 1337).** The status table says exactly which parts run.

## Status

Dated 2026-11-06. "Verified" means it was run and the output is in this repository or was observed by the author of this section; "built" means code exists and has not been shown to work in that setting.

| Piece | State |
|---|---|
| Contracts (`ZeroDrop`, mock and Semaphore verifier adapter, frame checks, staking) | Verified across 3 chains: 109 forge tests passing locally; deployed & locked with Semaphore on Sepolia (`0xc418...`); deployed & staked in `IStakingRegistry` on devnet (`0x419c...`) |
| Real Semaphore v4 proof | Verified on public Sepolia testnet at block 12079587 (`0x3e9b59...`), local anvil (`evidence/txs.md`), and against negative controls (one-bit mutation rejected) |
| Mock proof mode (`MockVerifier`, no ZK) | Live on devnet chain 1337 with a 300k gas burn standing in for Groth16 verification (`0x0b3a...`) |
| Reader checks | L0 (content hash), L1 (inclusion via `eth_getProof` verified against block state root), and L2 (Semaphore ZK proof verification) |
| Posting paths | **Dual path:** EIP-8141 Frame transaction (relayerless 0-ETH anonymous disclosure via alt-mempool, live on devnet chain 1337) and direct contract calls (available on Sepolia & anvil) |
| EIP-8141 frame transaction, VERIFY fallback in the contract | **Live on chain 1337:** VERIFY fallback burned 370,032 gas on-chain; SENDER frame recorded disclosure in block 10041 (`0x3f87...`) |
| Over-100k verification admitted by an alt mempool | **Live-verified:** 370k gas VERIFY frame admitted by `https://altmempool.forshtat.com/rpc` and mined on chain 1337 |
| Canonical mempool rejection of the same transaction | **Live-verified:** Canonical node (`https://altmempool.forshtat.com`) directly rejected the identical raw transaction with `prefix gas budget (frames + sig cost) exceeds MAX_VERIFY_GAS` (`evidence/canonical-rejection.md`) |
| Anon-RPC (Tor) transport | Implemented (`packages/core/src/net.ts`, boot states in the UI, CSP; Node SOCKS5h in `torsocks.ts`). Official EF Tor-JS contract (`0x700d...`) configured as default specifier; live SOCKS5h Tor egress verified with `torsocks.test.ts` (`check.torproject.org` reports `IsTor: true`). No silent fallback to direct |
| Single-file build | Verified: one HTML file of about 1.95 MB, no external script, link, image or font reference (`scripts/check-single-file.ts`). Loads from `file://` in headless Chrome with no console error and no CSP violation (`scripts/check-file-url.ts`). Two clean builds were byte-identical on this machine (`evidence/ipfs-pin.md`) |
| IPFS | Pinned into a **local offline Kubo node** and read back byte for byte through its gateway. Our `cidFor` equals Kubo's single-block CID. **Not published to the public IPFS network, by design**, so there is no public CID yet |
| Document pinning (`pin.ts`, `scripts/pinner.ts`) | Verified against a real Kubo node (the `kubo-live` test, 4 tests, re-run 2026-11-06 against the offline node) and by an earlier opt-in read of public gateways (commit `9746c92`; not re-run for this README). Publishing to public pinners has not been done |
| Own sidecar (`sidecar/run.sh`) | Launcher written; `--check` and `--print` run. **Nothing was started**: no checkout of the upstream sidecar, Docker daemon off |
| PDF metadata stripping | Implemented: structural object-tree stripping using `pdf-lib` (drops Info, XMP, DocumentID, and scripts; 8 unit tests passing) |
| Image metadata stripping | Canvas re-encode in the browser; residual metadata is reported; the output is browser dependent |
| Membership root | Computed off chain (Semaphore LeanIMT). The contract stores the issuer's root and emits the commitments; readers rebuild and check. The contract does not verify the root |
| Random submission delay, trade-off toggles | In `/settings`. Not exercised against a real network |
| Reproducible build CI | No CI exists. `scripts/build-ipfs.sh --repro` does the check locally |

`status.md` has the phase-by-phase picture and the list of deviations. This README is updated from what ran, not from the plan.

## Run it locally

Prerequisites: Node 24, pnpm 10, Foundry (`forge`, `anvil`). Optional: Kubo (`ipfs`) for pinning, and the Semaphore circuit files for real proofs (below).

```sh
pnpm install
pnpm build:contracts                       # forge build; the deploy script reads contracts/out
anvil --port 8545 &                        # local chain 31337

# Deploy both modes. Each writes its own file in config/ and never touches the devnet entry.
pnpm contracts:deploy                      # Semaphore verifier -> config/local.json
pnpm contracts:deploy --mock               # MockVerifier       -> config/local-mock.json

# Seed a demo group (4 identities, minimum size 3). Identities go to .local/ (gitignored).
pnpm tsx scripts/seed-group.ts 4 3                                  # for config/local.json
CONFIG=config/local-mock.json pnpm tsx scripts/seed-group.ts 4 3    # for config/local-mock.json

# Optional: a document store the app can pin to and resolve from (default http://127.0.0.1:8787)
pnpm pinner

# Optional: a real Kubo node, offline so nothing is announced
export IPFS_PATH=$HOME/.zerodrop-kubo && ipfs init --profile=test
ipfs config Addresses.API /ip4/127.0.0.1/tcp/15001
ipfs config Addresses.Gateway /ip4/127.0.0.1/tcp/18080
ipfs daemon --offline &

pnpm dev                                   # web app (the dev server listens on all interfaces)

# Headless end-to-end on the local chain: strip, real proof, record, verify L0/L1/L2
SEMAPHORE_ARTIFACTS_DIR=/path/to/dir pnpm tsx scripts/demo.ts
```

Tests: `pnpm test:contracts` (forge: 109 passing), `pnpm test:core` (vitest; 215 passed and 16 skipped across 21 suites on 2026-11-06). The skipped tests need the circuit files, live Tor, or a live node. To run the Kubo ones: `ZD_KUBO_API=http://127.0.0.1:15001 ZD_KUBO_GATEWAY=http://127.0.0.1:18080 pnpm --filter @zerodrop/core test kubo-live`.

Build, check and pin the single file:

```sh
scripts/build-ipfs.sh                 # build, check it is one file, print sha256 and CIDs
scripts/build-ipfs.sh --repro         # build twice from a clean dist and compare the bytes
scripts/build-ipfs.sh --pin           # also pin into the offline Kubo above and read it back through its gateway
pnpm tsx scripts/check-file-url.ts    # open dist/index.html from file:// in headless Chrome
```

Devnet (live-verified): see `config/devnet.json` and `evidence/txs.md` for the deployed contracts and mined frame transaction (Block 10041, tx `0x3f87...`). To run a fresh frame tx spike against the devnet: `scripts/devnet-run.sh`.

### Circuit artifacts

Real proofs need `semaphore-<depth>.wasm` and `semaphore-<depth>.zkey` from the Semaphore v4 circuits. The demo group has depth 2. The core package never downloads them; the web build finds them in `apps/web/public/zk/` and blocks real-proof posting when they are absent. They are not in this repository, so the shipped single file does not contain them either.

### Keys

The anvil default account key used by the scripts is a public test key; never use it on a network that holds value. `.local/` (demo identities) is gitignored. `config/devnet.json` contains no secrets. The app keeps the Semaphore identity encrypted with a user passphrase in IndexedDB (PBKDF2 + AES-GCM vault); the passphrase-encrypted export is for portable backups.

## CROPS

- **C, censorship resistance.** Nothing the user depends on is ours to switch off: there is no backend and no account. The app is one static file that opens from `file://` (verified in headless Chrome) and from a Kubo gateway (byte-identical read-back; not opened in a browser from there). RPC, sidecar and pinner endpoints are editable lists in `/settings`, the gas float is a contract anyone can top up with `donate()`, and `sidecar/run.sh` is the launcher for running your own alt-mempool node. **Live on devnet:** ZeroDrop was deployed, staked in `IStakingRegistry` (`0xd51c...`), and admitted an anonymous frame transaction through the alt-mempool sidecar (`0x3f87...` mined in block 10041).
- **O, open source.** MIT (`LICENSE`). A user can build everything from this repository: `pnpm install && pnpm build` gives the single file, `forge build` the contracts. Two clean builds were byte-identical on one machine with the same Node and pnpm and the same checkout path; we have not tested other machines, paths or operating systems, and there is no CI. The circuit files are a separate download (not in the repo).
- **P, privacy.** On the EIP-8141 frame path (live-verified on devnet chain 1337), the poster's address is 0x0 / not on chain: the contract is the sender and the payer (0 ETH needed from the user). On Sepolia, ordinary direct transactions were used. The Tor transport is configured with the official EF Tor-JS contract (`0x700d...`) on mainnet, and live SOCKS5h egress was verified via Tor daemon (`torsocks.test.ts`). Strict CSP blocks all third-party analytics and external tracking. Metadata stripping covers text, images (canvas re-encode) and PDFs (`pdf-lib` structural object-tree stripping).
- **S, security.** The Semaphore secret never leaves the device and is protected at rest in IndexedDB by a passphrase-derived key (AES-GCM + PBKDF2 vault). A source has no signing key to steal on the frame path. Trust assumptions: the Groth16 trusted setup (Semaphore's ceremony), the group issuer, the Anon-RPC specifier owner (pinned hash), and for L1 the storage proof against the block header's state root. The contracts have not been audited. This is a prototype: do not use it for sensitive disclosures.

## Threat model (summary)

From `docs/architecture.md` section 8, with what is built marked. The full table is there.

| Threat | Intended mitigation | Built? |
|---|---|---|
| Funding trail deanonymises the source | The contract pays; the source has no account | Frame path live-verified on devnet chain 1337 (Block 10041). Direct path leaks sender |
| Source or reader IP | Every request over Anon-RPC / Tor | Implemented & configured with EF contract; live SOCKS5h verified |
| Proof replay or front-running | `message = SIG_HASH`, nullifier as the protocol nonce key | In the contract and adapter; live verified on devnet Block 10041 |
| Insider floods a case | One nullifier per (member, case) | Enforced in the contract (tested) |
| Float drained | Frame-shape checks, `MAX_COST` cap, `MIN_BODY_GAS` | Verified on-chain on devnet with 370k gas VERIFY frame |
| Mass invalidation of pending transactions | Validation reads only append-only roots and protocol nonces | By construction; admitted and mined |
| File metadata | Strip and show the diff; warn about what cannot be removed | Built for text, images, and PDFs (`pdf-lib`) |
| Timing correlation | Random delay, warning about the join-to-post gap | Delay exists in settings; not exercised |
| Small anonymity set | Meter and `minSize` | In the contract and UI |
| Membership linked to a funded wallet | The issuer adds members; members hold no ETH | By design; `addMembers` exists, no issuer UI |
| Document disappears | Several pinners, "keep it online" re-pin, offline bundle | Pinner client and bundle built; not run in a browser |
| Lying RPC | L0 and L2 local; L1 header agreement | L1 is single-endpoint today |
| Malicious issuer, global passive adversary, device malware | Out of scope | Stated |
| Builder censorship | Fan-out to several sidecars | Code exists; no second sidecar was ever run |

## Trade-offs, stated

- **Why not ERC-4337.** A 4337 bundler signs and pays the outer transaction, sees the user's operations and IP, and must be trusted for liveness. With a frame transaction the protocol checks the nonce and the payment itself, so any node can carry it. This is a design argument; we did not build a 4337 variant to compare.
- **Why not the canonical mempool.** Its validation budget is 100,000 gas (`MAX_VERIFY_GAS`), and a Groth16 membership proof costs roughly 250 to 400k (402,066 gas used by `record` with the Semaphore verifier, depth 2, on local anvil). The alt mempool (ERC-8421) allows more for staked entities. **We have not been able to show the alt mempool admitting that**, because we have not reached the devnet and do not have the patched sidecar. That is the main open risk. If it cannot be shown, the demo falls back to the mock verifier, labelled as such.
- **Float DoS.** The contract pays for every disclosure, so someone can try to drain it. The VERIFY fallback enforces the frame shape, a maximum cost cap and a minimum body gas, and one transaction per nullifier per case. These checks are tested only against mocked frame opcodes. Whether a griefing member can still cost the float gas on a real node is open. The staked reputation is shared by every user of the contract; a burst of invalid transactions can get the contract throttled for everyone.
- **Invalidation.** Pending transactions are invalidated by anything that changes what validation reads. Validation here reads append-only roots and the nonce manager, so joins do not invalidate them. This is by construction and untested on a mempool.
- **Front-running.** A proof is bound to the transaction's signature hash. A proof made for one document is rejected for another: forge tests `test_recordWithRealProof_boundToDocument` and `test_realProofForCidA_isRejectedForCidB`. The binding to a real frame transaction's signature hash is unverified (that hash omits the arbitrary signature bytes, so the proof bytes themselves are not covered).
- **Shared reputation.** One staked sender serves all members, so one abusive member can hurt the rest. Mitigation: exact frame-shape checks and one transaction per nullifier. Not a complete answer.
- **Issuer trust.** The issuer decides who is in the group and publishes the root. The contract does not verify the root. Readers rebuild the tree from events and check it.
- **Devnet shortcuts.** A throwaway network that can reset; a funded key published on purpose; a relay call (`ethrex_submitPrivilegedFrameTransaction`) and admin methods open to the internet; stake held by a naive registry; and a chain whose TLS certificate was not valid from this machine when we tried.
- **Trade-off toggles** (direct RPC for readers, skip random delay, single sidecar) exist in `/settings`, off by default, each labelled with what it leaks.

## What pre-existed

Built on, not written here:

- **Semaphore v4** (`@semaphore-protocol/*`, and its verifier contract, vendored in `contracts/src/vendor/semaphore`): identity, group, Groth16 proof and verification.
- **`@forshtat/hegota-support`** (MIT): frame-transaction codec, signature hash and Solidity opcode helpers (vendored in `contracts/src/vendor/hegota`, see `PROVENANCE.txt`).
- **`@anon-rpc/browser-harness`**: the Tor-routed fetch from the Anon-RPC project.
- **viem** for RPC and ABI.
- The alt-mempool team's sidecar and workshop, which we only read and run.

PressProtocol, the author's earlier publishing project, was evaluated and is not a dependency: the pieces needed here (a CIDv1 raw sha-256 and an HTTP pin) are small enough to own, and nothing from it ships in the build people are asked to hash-check.

Everything else in this repository was written during the hackathon.

## Layout

- `contracts/` Solidity: `ZeroDrop`, verifier interface, mock and Semaphore adapter, frame checks, forge tests, fixtures.
- `packages/core/` the library: identity, group, content and CID, proofs, chain transport, Anon-RPC transport, pinning, L1 inclusion, proof bundle, frame transactions, settings.
- `apps/web/` the single-page app (hash routes `#/drop`, `#/d/<cid>`, `#/groups`, `#/settings`, `#/about`), built to one HTML file.
- `scripts/` deploy, seed, demo, fixture generation, pinner, gas spike, and the build and check scripts (`build-ipfs.sh`, `build-cid.ts`, `check-single-file.ts`, `check-file-url.ts`, `check-devnet.ts`).
- `sidecar/` launcher and notes for running your own alt-mempool sidecar.
- `evidence/` what ran, with output, and the procedures for what has not.
- `config/` deployments (`local.json`, `local-mock.json`, `devnet.json`); read at build time by the web app.
- `docs/` design, architecture and plans (read-only here).

## License

MIT. See [LICENSE](LICENSE). Security: see [SECURITY.md](SECURITY.md).
