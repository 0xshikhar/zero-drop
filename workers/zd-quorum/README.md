# zd-quorum: Anon-RPC Quorum & Storage Proof Verifying Worker

`zd-quorum` is a specialized Anon-RPC worker implementing the official Ethereum Foundation Anon-RPC specification (`@anon-rpc/browser-harness` 0.4.0).

## Motivation & Threat Model

While Tor-JS hides the user's IP address from upstreams, a malicious or compromised RPC endpoint can still attempt to:
1. Return forged account balances or state reads.
2. Serve equivocal block hashes or state roots.
3. Log query timing and requested storage keys to correlate whistleblowers.

`zd-quorum` addresses these integrity risks by bringing Byzantine quorum agreement and in-sandbox cryptographic verification directly into the browser's isolated Web Worker:

| Feature | Mechanism | Security Guarantee |
|---|---|---|
| **Quorum Fan-Out** | Parallel JSON-RPC dispatch to $M$ independent upstreams | Upstreams cannot unilaterally falsify read results |
| **Byzantine Agreement** | Requires $\ge N$ (default 2) identical results | Fails closed on disagreement (`502 Bad Gateway`); never silently picks a single RPC |
| **In-Sandbox Proofs** | Inspects `eth_getProof` trie proofs against state root | Proves storage inclusion locally before returning to host |
| **Isolation Keys** | Partitions connections by `anonOptions.isolationKey` | Reads under different keys cannot be linked by connection reuse |
| **Decoy Reads** | Dispatches asynchronous synthetic `eth_getBalance` queries | Masks actual document access patterns from passive loggers |

## Worker Architecture

```
                                  +---------------------------------------+
                                  |         Host Application              |
                                  |   (ZeroDrop Web / Reader Page)        |
                                  +---------------------------------------+
                                                     |
                                         anonRpcWorker.acceptCall()
                                                     |
                                                     v
+---------------------------------------------------------------------------------------------------+
|  zd-quorum Sandboxed Web Worker (null-origin iframe)                                             |
|                                                                                                   |
|   1. Parse Request & Extract isolationKey ("<role>:<session>")                                   |
|   2. Fire Decoy Query (synthetic eth_getBalance to random address)                                |
|   3. Parallel Fan-Out to Upstreams:                                                              |
|         |---> Upstream 1 (https://ethereum-rpc.publicnode.com)                                    |
|         |---> Upstream 2 (https://rpc.ankr.com/eth)                                               |
|         |---> Upstream 3 (https://cloudflare-eth.com)                                             |
|   4. Vote Counting & Quorum Consensus (require >= threshold matching results)                     |
|   5. In-Sandbox Merkle Validation (if eth_getProof, check storageHash & accountProof trie nodes)    |
+---------------------------------------------------------------------------------------------------+
                                                     |
                                             call.respond()
                                                     |
                                                     v
                                  +---------------------------------------+
                                  |         Verified Result               |
                                  +---------------------------------------+
```

## Configuration Schema

Configured via `workerInit.config` (opaque plain value):

```json
{
  "upstreams": [
    "https://ethereum-rpc.publicnode.com",
    "https://rpc.ankr.com/eth",
    "https://cloudflare-eth.com"
  ],
  "quorumThreshold": 2,
  "enableDecoys": true
}
```

## Building

```bash
pnpm worker:build
```

Builds `workers/zd-quorum/dist/worker.js` (deterministic IIFE, ~4.1 KB) and outputs `keccak256` hash.

## Specifier Contract (`IWorkerSpecifier`)

The worker's bundle integrity is pinned onchain via `contracts/src/ZdQuorumSpecifier.sol`:
- `workerHash()`: `0x50658577909d54de86ff95f5d39f2bbff03977d674f69450f01f5cb5c545c0e1`
- `workerResolvers()`: Redundant decentralized IPFS gateways serving the exact byte bundle.

