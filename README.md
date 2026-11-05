# ZeroDrop

Leak the document, not yourself. ZeroDrop publishes a document that can be checked against a group membership without revealing which member posted it.

## Status (honest)

| Piece | State |
|---|---|
| Semaphore v4 membership proof (Groth16), generated in the browser or in node | Real. Verified locally and on chain with the vendored Semaphore verifier |
| `ZeroDrop.sol`: groups, issuer-published roots, nullifiers per case, `record` with proof | Real on a local chain (anvil, 31337). 61 forge tests |
| Reader checks: L0 content hash, L1 inclusion, L2 proof | L0 and L2 real. L1 is single-endpoint: the record and log come from one RPC, and no storage proof (`eth_getProof`) is verified |
| Posting path | **Direct transaction.** The poster's address is on chain. Use a throwaway key |
| EIP-8141 frame transaction (alt-mempool devnet) | Built and unit-tested offline. **Not verified against the devnet**: its TLS certificate fails validation from the build machine, and `config/devnet.json` has no deployment |
| VERIFY frame in the contract | Not implemented. `DisclosureFrameChecks` holds the rule set as a pure library and is tested |
| Anon-RPC / Tor transport | **Not integrated.** All requests are direct. The traffic meter shows this |
| PDF metadata stripping | Not implemented. PDFs are rejected |
| Metadata stripping for images | Canvas re-encode in the browser. Residual metadata is reported, and the output is browser-dependent |
| Membership root | Computed off chain with Semaphore's LeanIMT. The contract stores the issuer's root and emits the commitments. Readers rebuild the group from events and check the root. The contract does not verify the root |

## Run the local demo

Prerequisites: Node 24, pnpm 10, Foundry (`forge`, `anvil`), and the Semaphore circuit files (see below).

```sh
pnpm install
anvil --port 8545 &                 # local chain, chain id 31337
pnpm contracts:deploy               # writes config/local.json
pnpm tsx scripts/seed-group.ts 4 3  # group of 4 identities, minimum size 3; writes .local/demo-members.json
SEMAPHORE_ARTIFACTS_DIR=/path/to/dir pnpm tsx scripts/demo.ts
pnpm dev                            # web app; posting needs the artifacts in apps/web/public/zk
```

`pnpm test:contracts` runs the forge tests. `pnpm test:core` runs the core tests. Three prove-and-verify tests are skipped unless `SEMAPHORE_ARTIFACTS_DIR` points at the depth-2 circuit files.

## Circuit artifacts

The app and the scripts need `semaphore-<depth>.wasm` and `semaphore-<depth>.zkey` from the Semaphore v4 circuits. The demo group has depth 2, so it needs `semaphore-2.wasm` and `semaphore-2.zkey`. The core package never downloads them. The browser build uses them from `apps/web/public/zk/` and blocks posting when they are absent.

## Keys

The anvil default account keys in `scripts/` and in the app are public test keys. Never use them on a real network. `.local/` (demo identities) and `config/devnet.json` secrets are not committed. The app stores the identity unencrypted in IndexedDB. Use the passphrase-encrypted export for backups.

## Layout

- `contracts/` Solidity: ZeroDrop, the Semaphore verifier adapter, frame checks, forge tests and fixtures.
- `packages/core/` the library: identity, group, content and CID, proofs, chain transport, L1 inclusion, frame transactions.
- `apps/web/` the single-page app (hash routes: `#/drop`, `#/d/<cid>`, `#/groups`, `#/settings`, `#/about`).
- `scripts/` deploy, seed, demo, fixture generation, ABI export.
- `docs/` design, architecture and plans (not committed to this repository).

## CROPS

- **Censorship resistance:** not implemented yet. The design calls for several independent sidecars and pinners.
- **Open source:** MIT licensed.
- **Privacy:** the poster's address is visible in the direct path. The frame path is designed to remove that, but it is not verified on the devnet. Metadata handling is partial.
- **Security:** this is a prototype. Do not use it for sensitive disclosures. The contracts have not been audited.

## License

MIT. See [LICENSE](LICENSE).
