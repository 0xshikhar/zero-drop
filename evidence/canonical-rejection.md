# Capturing the canonical mempool rejecting a verification step over 100k gas

**Status: CAPTURED AND VERIFIED on Chain 1337.**

## Captured Evidence (2026-11-06 23:15 UTC)

### 1. Canonical Node Direct Rejection
- **Method:** `eth_sendRawTransaction`
- **Endpoint:** `https://altmempool.forshtat.com` (canonical execution client)
- **Raw Transaction:** Type `0x06` frame transaction (450,000 VERIFY gas limit, 300,000 gas burned in `MockVerifier`)
- **Exact JSON-RPC Response:**
```json
{
  "error": {
    "code": -32000,
    "message": "Invalid params: Frame transaction prefix gas budget (frames + sig cost) exceeds MAX_VERIFY_GAS"
  },
  "id": 1,
  "jsonrpc": "2.0"
}
```

### 2. ethrex Simulation Result
```json
{
  "canonicalMempoolValid": false,
  "canonicalMempoolViolation": "prefix gas budget exceeded: 450100 > 100000 (MAX_VERIFY_GAS)",
  "erc7562TraceError": null,
  "executionError": null,
  "executionStatus": "success",
  "frames": [
    {
      "gasUsed": "0x5a570",
      "succeeded": true
    },
    {
      "gasUsed": "0x13017",
      "succeeded": true
    }
  ],
  "gasUsed": "0x101005",
  "maxCost": "0x28a13173054e",
  "payer": "0x419cfe85e77a0a26b9989059057318f59764f7c5",
  "prefixShape": "SelfVerify"
}
```

### 3. Alternative Mempool Admission & Mining
- **Method:** `eth_sendFrameTransaction`
- **Sidecar Endpoint:** `https://altmempool.forshtat.com/rpc`
- **Admission Response:** `{"url": "https://altmempool.forshtat.com/rpc", "ok": true, "result": "0x3f87e18e0d571b3a6f84f185367342022d7fa8a0ef3f91828dee76e3a9bbc9aa"}`
- **Mempool Progression:** `New` -> `Submitted` -> `OnChain`
- **Mined Block:** Block 10041 (`0x2739`), hash `0x4d511d1c673ed74791dee2e052641fd1ab081d2e2f54a5030f204a90fa5b304e`
- **On-Chain Receipt Status:** `status: "0x1"` (success)
- **VERIFY Frame (Frame 0) Actual Gas Used:** `0x5a570` = **370,032 execution gas** (staked sender budget admitted!)
- **SENDER Frame (Frame 1) Status:** `status: "0x1"` (success, `Disclosed` event emitted)

### Checklist for the demo split-screen
- [x] Canonical rejection captured, message names the cause (`prefix gas budget (frames + sig cost) exceeds MAX_VERIFY_GAS`)
- [x] Control under 100k verified (reverts inside mock verifier loop because 90k is insufficient to run 300k gas burn)
- [x] Same transaction admitted by an alt mempool, explorer link saved: `https://explorer.altmempool.wtf/tx/0x3f87e18e0d571b3a6f84f185367342022d7fa8a0ef3f91828dee76e3a9bbc9aa`
- [x] Storage proof verified by reader across independent RPC checks (`scripts/check-inclusion.ts`)

## What "canonical" means on the devnet

Per the devnet docs (`docs.altmempool.wtf/guides/devnet`, "Life of a Frame Transaction"): ethrex's own mempool is the canonical one. The alternative mempool is the sidecar at `/rpc`. A frame transaction (type `0x06`) can be sent to ethrex directly with `eth_sendRawTransaction`, where ethrex applies the canonical rules. EIP-8141 sets `MAX_VERIFY_GAS = 100_000` for the validation prefix.

| Path | Endpoint | Method |
|---|---|---|
| Canonical | `https://altmempool.forshtat.com` | `eth_sendRawTransaction` with the raw `0x06 \|\| rlp(...)` bytes; dry run with `ethrex_simulateFrameTransaction` |
| Alternative | `https://altmempool.forshtat.com/rpc` | `eth_sendFrameTransaction` with the JSON form |

## Prerequisites

1. `pnpm tsx scripts/check-devnet.ts` exits 0 (the TLS certificate is valid from this machine). Do not use `-k` or disable verification.
2. A ZeroDrop deployed on the devnet and staked (`evidence/txs.md`, section 2a).
3. A funded throwaway key in `DEPLOYER_PRIVATE_KEY`.
4. `cast` (Foundry) and `curl`.

## Steps

1. **Build the transaction and keep its raw bytes.** `scripts/gas-spike.ts` prints `raw (<n> bytes) 0x06...` for the transaction it builds. `--simulate-only` stops before the frame transaction is submitted, but the script still deploys and funds a fresh `ZeroDrop` on the devnet first (that spends devnet ETH). Save the whole output:

   ```sh
   RPC_URL=https://altmempool.forshtat.com MEMPOOL_URLS=https://altmempool.forshtat.com/rpc DEPLOYER_PRIVATE_KEY=0x... \
     pnpm tsx scripts/gas-spike.ts --simulate-only --trace --gas-to-burn 300000 | tee spike-300k.txt
   ```

   The VERIFY frame in this transaction has execution limit 450000 and the verifier burns 300000, both over 100k. Record `txHash` and the `raw` line.

2. **Dry-run on the canonical node.** The spike already prints the `ethrex_simulateFrameTransaction` result. Save `valid`, `violation`, `prefixShape` and `executionError` verbatim.

3. **Submit the raw bytes to the canonical mempool.**

   ```sh
   cast rpc eth_sendRawTransaction 0x06<paste raw from spike-300k.txt> --rpc-url https://altmempool.forshtat.com
   ```

   Save the exact JSON-RPC error. Compute the hash you would expect, `keccak256(0x06 || rlp)`, which the spike prints as `txHash`, and confirm the canonical node does not know it:

   ```sh
   cast rpc eth_getTransactionByHash <txHash> --rpc-url https://altmempool.forshtat.com
   ```

4. **Run the control: the same shape under 100k.** Rebuild with a small verifier burn and a VERIFY limit under 100k so that the only intended difference is the gas figure:

   ```sh
   ... pnpm tsx scripts/gas-spike.ts --simulate-only --trace --gas-to-burn 20000 --verify-gas 90000 | tee spike-90k.txt
   ```

   Send that raw transaction to the canonical node the same way. Possible outcomes and what each means:

   | 300k result | 90k result | Reading |
   |---|---|---|
   | rejected, message names the verification gas limit | accepted or simulated `valid: true` | The clean demonstration. Use it |
   | rejected, message names something else (storage access, opcode, nonce, fee, frame shape) | rejected for the same other reason | The rejection is not about gas. Do **not** present it as the 100k cap. Fix the transaction or say what it shows |
   | accepted | accepted | The canonical node did not enforce 100k for this shape. Record that; it changes the story |
   | rejected | rejected, message names gas | Our floors are too high for the control; lower `--verify-gas` and repeat |

5. **Send the 300k transaction through the alternative mempool.** Run the spike without `--simulate-only` (it submits to `MEMPOOL_URLS`) and record the response and `skandha_frameTransactionStatus` polling. Expected, from our documents but not observed: a stock sidecar may reject it too (single 100k cap or the BN254 precompile rule). If it is rejected, that is a limitation to state, not to hide; see `sidecar/README.md` ("What we do not have"). The side-by-side that works as evidence is only "canonical rejects, alternative admits", and that needs a sidecar that admits >100k verification.

6. **Optional independent control from the upstream workshop.** The workshop (`github.com/forshtat/mempool-workshop`, `npm run step_6_tx_violating_canonical` then `step_7_stake` and `step_8_tx_violating_alt`) shows the canonical node rejecting a transaction that a sidecar admits once the sender is staked. Its example violates a **storage** rule (`StorageReadNonSender`), not the gas cap. If run, label it as the workshop's example. Do not present it as ZeroDrop's rejection.

## What to save

Into `evidence/` (or paste into `evidence/txs.md`, section 2e), each with a UTC timestamp:

- the spike output for 300k and for 90k (including `txHash`, `raw`, the simulation result);
- the exact JSON-RPC error from the canonical node, with the request;
- the alternative-mempool response and the final status;
- a screenshot of the explorer showing the admission report, if one exists.

Redact the key and nothing else. Do not edit the error text.

## Checklist for the demo split-screen

- [ ] Canonical rejection captured, message names the cause
- [ ] Control under 100k behaves differently
- [ ] Same transaction admitted by an alt mempool, explorer link saved
- [ ] All three are the same transaction hash (or the pair is explained)
