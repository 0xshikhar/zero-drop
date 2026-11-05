# ZeroDrop

Leak the document, not yourself. ZeroDrop is a prototype for publishing a document that can be checked against a group membership without revealing which member posted it.

## Current state

This repository currently contains a local file fingerprinting UI and an early Solidity foundation for groups and disclosure records. **Anonymous frame transactions, Semaphore proofs, metadata stripping for binary files, Anon-RPC, decentralized pinning, and reader inclusion proofs are not implemented.** The contract's direct `record` function links the caller's address and is for development only. The UI therefore keeps posting disabled and labels the proof as mock.

## Run locally

```sh
pnpm install
pnpm dev
```

Build the static app with `pnpm build`. Build the contracts with `pnpm build:contracts` and run their tests with `pnpm test:contracts`.

## Development notes

- App code lives in `apps/web`; reusable browser logic lives in `packages/core`.
- Contract work lives in `contracts` and currently uses a temporary hash accumulator for group roots. Replace it with the specified LeanIMT before integrating Semaphore.
- No real keys, contract addresses, or RPC endpoints are included.
- PressProtocol packages are planned dependencies; this initial implementation does not import them yet.

## CROPS

- **Censorship resistance:** planned through multiple independently operated sidecars; not implemented yet.
- **Open source:** MIT licensed.
- **Privacy:** the current UI processes selected files locally, but publishing privacy is not yet implemented.
- **Security:** mock verification only; do not use this prototype for sensitive disclosures.

## License

MIT. See [LICENSE](LICENSE).
