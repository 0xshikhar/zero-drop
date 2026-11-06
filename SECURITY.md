# Security

ZeroDrop is a hackathon prototype (ETH Mumbai, November 2026). The contracts have not been audited. **Do not use it for a real disclosure where someone's safety depends on it.**

## Reporting a problem

Please do not put exploit details in a public issue.

- Use GitHub's private vulnerability reporting ("Security" tab, "Report a vulnerability") on this repository, if it is enabled.
- Otherwise contact the maintainers through the contact details on the repository owner's profile.

**TODO before the repository is made public:** name a monitored contact here (an address or a confirmed private-reporting channel). None has been set, and this file does not invent one.

Useful in a report: the commit, what you ran, what you expected, what happened. For anything involving keys or identities, describe it without attaching real secrets. Please give us reasonable time to fix before publishing. This is a volunteer prototype with no bounty and no service level.

## Known limitations

These are stated, not hidden. The README has the details and the current evidence for each.

1. **The anonymity path is verified on devnet chain 1337, but direct posting on Sepolia is visible.** The EIP-8141 frame transaction path has been live-tested and verified on the alt-mempool devnet (block 10041, tx `0x3f87...`), where ZeroDrop itself is the payer (0 ETH from user). On Sepolia, ordinary direct transactions were used, placing the sender's address on chain.
2. **Proof verification over the public 100k gas limit is demonstrated on the devnet.** A 370,032 execution gas VERIFY frame was admitted by the alt-mempool and mined, while rejected by the canonical mempool's `MAX_VERIFY_GAS` cap. Production Semaphore proofs on Sepolia require ~400k-900k gas, which fits this alt-mempool staked-sender model.
3. **Frame opcodes have been executed on live ethrex devnet.** Real EIP-8141 opcodes (`approve`, `txparam`, `framedataload`) were exercised on-chain in block 10041. Staking was executed against the devnet `IStakingRegistry` (`0xd51c...`).
4. **Contracts are unaudited.** Known deviations include: the issuer's membership root is not checked by the contract; the frame signature hash does not cover the proof bytes; `MIN_BODY_GAS` is 450,000.
5. **Issuer trust.** The group issuer decides who is a member. A malicious issuer can add keys it controls.
6. **Reader inclusion check (L1) verifies `eth_getProof` storage proofs** against a block header's state root. While cryptographically sound against tampered storage proofs, trust in the state root itself currently relies on a single RPC or k-of-n header quorum rather than a full execution light client (e.g. Helios/Colibri).
7. **Identity storage.** The Semaphore identity is encrypted in IndexedDB using a passphrase-derived key (PBKDF2 + AES-GCM). Device malware, keyloggers, or an untrusted browser profile defeat the protection.
8. **Metadata stripping is partial.** Images are re-encoded via HTML5 canvas, and PDFs undergo structural object-tree stripping (dropping Info, XMP, DocumentID, and scripts). Printer dots, embedded visual artifacts, font embeddings, writing style, and semantic content that identifies the source cannot be removed automatically.
9. **Small anonymity sets and timing.** A group of a few members offers little anonymity, and posting soon after joining narrows it further. A global passive network adversary is out of scope.
10. **Anyone can pin or fetch** a document by CID, and pinners can drop it. The on-chain record still shows what existed.
11. **Devnet shortcuts.** The target network is a throwaway devnet with deliberately open admin surfaces and a shared funded key. Never reuse a devnet key anywhere else.
12. **Test keys in the repository.** The anvil default key in `scripts/` is public. No other private key is, or should ever be, committed. `.local/` (demo identities) is gitignored.
13. **Single-file build integrity.** Two clean builds were byte-identical on one machine. Reproducibility across machines is untested, and there is no CI. The Groth16 trusted setup (Semaphore's ceremony) and the Anon-RPC specifier owner are trusted third parties.

See [README.md](README.md) (Status, CROPS, Threat model, Trade-offs).
