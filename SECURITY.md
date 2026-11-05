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

1. **The anonymity path has not been shown to work.** The only posting path that has run is a direct transaction from an ordinary account, which puts the poster's address on chain. The EIP-8141 frame path, the alternative mempool and the Tor transport are built or designed but have not been run against the devnet or Tor.
2. **Proof verification over the public 100k gas limit is unproven** on any mempool. We do not have the patched sidecar or the precompile allowlist the design assumes.
3. **Frame-opcode behaviour is unverified.** The contract's VERIFY fallback was tested only against mocked frame opcodes.
4. **Contracts are unaudited.** Known deviations include: the issuer's membership root is not checked by the contract; the frame signature hash does not cover the proof bytes; `MIN_BODY_GAS` is 450,000.
5. **Issuer trust.** The group issuer decides who is a member. A malicious issuer can add keys it controls.
6. **Reader inclusion check (L1) trusts the RPC** it asks, or a k-of-n agreement on block headers. It is not a light client.
7. **Identity storage.** The Semaphore identity is kept unencrypted in the browser's IndexedDB. The passphrase-encrypted export is for backups only. Device malware or an MDM profile defeats the design.
8. **Metadata stripping is partial.** Images are re-encoded in the browser with browser-dependent results; PDFs are rejected. Printer dots, writing style and content that identifies the source cannot be removed.
9. **Small anonymity sets and timing.** A group of a few members offers little anonymity, and posting soon after joining narrows it further. A global passive network adversary is out of scope.
10. **Anyone can pin or fetch** a document by CID, and pinners can drop it. The on-chain record still shows what existed.
11. **Devnet shortcuts.** The target network is a throwaway devnet with deliberately open admin surfaces and a shared funded key. Never reuse a devnet key anywhere else.
12. **Test keys in the repository.** The anvil default key in `scripts/` is public. No other private key is, or should ever be, committed. `.local/` (demo identities) is gitignored.
13. **Single-file build integrity.** Two clean builds were byte-identical on one machine. Reproducibility across machines is untested, and there is no CI. The Groth16 trusted setup (Semaphore's ceremony) and the Anon-RPC specifier owner are trusted third parties.

See [README.md](README.md) (Status, CROPS, Threat model, Trade-offs).
