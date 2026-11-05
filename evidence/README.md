# Evidence

This folder holds what was actually run, with the output, so a reader can tell a result from an intention. Nothing here is a mock-up. Anything that has not happened is marked **not yet** and has the command that will fill it.

| File | What it is | State |
|---|---|---|
| [`txs.md`](txs.md) | Transactions and deployed addresses. Local anvil entries are real and were read back from the chain. The devnet section is empty on purpose | local: real. devnet: **not yet** |
| [`devnet-status.md`](devnet-status.md) | Output of `scripts/check-devnet.ts` against the public devnet, with a timestamp | real, and says the devnet was not reachable |
| [`ipfs-pin.md`](ipfs-pin.md) | The single-file build: checks, CIDs, reproducibility, pinning into a local offline Kubo, `file://` load | real, local only. Nothing was published to the public IPFS network |
| [`canonical-rejection.md`](canonical-rejection.md) | The procedure to capture the canonical mempool rejecting a verification step over 100k gas | a procedure, **no result yet** |

Rules for adding to this folder:

1. Paste output verbatim, with the command and a UTC timestamp. Do not retype hashes: copy them.
2. If something fails, record the failure. A rejection with its reason is evidence too.
3. Never put a private key, a seed phrase, a Semaphore identity secret or an RPC URL with an API key here. The anvil default keys are public test keys and may be named, nothing else.
4. A chain on a developer machine (anvil) is not the devnet. Say which one each entry is from.
5. Local anvil state is in memory. Hashes from it are valid only for the chain whose genesis block hash is given in `txs.md`; they cannot be looked up elsewhere.

Scripts that produce this evidence: `scripts/build-ipfs.sh`, `scripts/check-single-file.ts`, `scripts/check-file-url.ts`, `scripts/build-cid.ts`, `scripts/check-devnet.ts`, `scripts/gas-spike.ts`, `scripts/deploy.ts`.
