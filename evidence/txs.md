# Transactions and addresses

Two chains appear in this repository. Do not mix them up.

- **Local anvil, chain id 31337.** Real, run on a development machine. In-memory state, no explorer. Public test keys.
- **Alt-mempool devnet, chain id 1337.** The one the hackathon asks for. **Not reached yet.** Its section below is empty.

## 1. Local anvil (chain 31337): real entries

Read back from the running anvil on 2026-11-05 about 21:30 UTC (this machine's clock), block 36 at the time. Chain identity: genesis block hash `0xcd6f3c6a91de68611f71b568f7af5e697bae3ad2050b601f234d1467b4e71f6c`, block 0 timestamp 1793910291 (2026-11-05 20:24:51 UTC). Anvil restarts lose this state; the hashes below mean nothing against a different anvil instance.

Deployer and sender of every transaction here: anvil account 0, `0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266`, a public test key.

### 1a. Current deployments (the ones in `config/`)

`config/local.json`, Semaphore verifier, `directRecordEnabled: true`, verifier locked:

| What | Address | Block | Deploy tx |
|---|---|---|---|
| `ZeroDrop` | `0xa85233c63b9ee964add6f2cffe00fd84eb32338f` | 25 | `0xf0442d907a10501430c815dd5b9d393a5602ecb5c49cec67ae42f5b00c3917ea` |
| `SemaphoreVerifier` | `0x4a679253410272dd5232b3ff7cf5dbb88f295319` | 26 | `0xbd20af46996ffef53a359e22cb8e7eea4945c64fbeb7f267a45192750ebcc1d6` |
| `SemaphoreVerifierAdapter` | `0x7a2088a1bfc9d81c55368ae168c2c02570cb814f` | 27 | `0x6b8761a7efbb277fae5e18fd1155f0a597c0e7548170b3fc6b93b1dbd1822436` |

Follow-up transactions on it (from the logs): `VerifierChanged` block 28 (`0x9e08ee494bac80940ca66104eb53080ff3940d1f8e96f5396ec5826af64ab60c`), `VerifierLocked` block 29 (`0x81a082911d47e9881bbfb889ca411549fd65fc8879d26d8cf4837bc592e72872`), `GroupCreated` block 33 (`0xe08df876dc1791b18382bfe89820ae0ea0e1aa192341e6d72363c2382603bf42`), `MembersAdded` block 34 (`0x7b180d2d8162f6739e6409736e6de6af4976d75bbd31d68418c208e4535814b7`). No `Disclosed` event on this deployment.

`config/local-mock.json`, `MockVerifier` burning 300,000 gas, `directRecordEnabled: true`, verifier not locked:

| What | Address | Block | Deploy tx |
|---|---|---|---|
| `ZeroDrop` | `0x67d269191c92caf3cd7723f116c85e6e9bf55933` | 30 | `0x5f946d48dc57ad543c8f7e34080fc3627d04045d2974d46817736263cbadea67` |
| `MockVerifier` | `0xe6e340d132b5f46d1e472debcd681b2abc16e57e` | 31 | `0x960ba7fdddb00568f38c3d8251226c49070932cb9da6bdef09879f26abc14f57` |

Follow-up: `VerifierChanged` block 32 (`0x57f97bc370ed370d52dd46ad97832cbb86cc8b6e14a049ceda2de47e150a4639`), `GroupCreated` block 35 (`0x245337ebc944a63a579038c47f0de705f1c23f3e97a3a6903b650513bfc32939`), `MembersAdded` block 36 (`0xebadb6f3bde5c98df3eddbe1da9aa90b6656f4e221b56e13f498c8a670bbe9ef`). No `Disclosed` event on this deployment either: **no mock-mode disclosure has been recorded on chain.**

### 1b. Real-proof disclosures (an earlier deployment, no longer in `config/`)

An earlier deployment on the same chain holds three `Disclosed` events. Contract `ZeroDrop` `0x9fe46736679d2d9a65f0992f2272de9f3c7fa6e0` (created block 3, tx `0xf4a4c016250170d21efbd15ba5a062e684715ea81e4f953b22e6cabff62f871b`), verifier adapter `0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512`, verifier locked (`verifierLocked()` returned `true`). `record` verifies the proof through that verifier, so each of these transactions is a record whose Semaphore Groth16 proof the contract accepted.

| Block | Tx | Group | cidDigest | Gas used | Note |
|---|---|---|---|---|---|
| 8 | `0x78ec966bea44615db016eb05ef2e87a8a07cddca33110432e79a8c5f2269e493` | 1 | `0x0192f75868dd864182fa3f7cf54be369734048a4908dd0a262fd4e5d8e3f9386` | 402,066 | cidDigest, case, root and nullifier equal `contracts/test/fixtures/semaphore-proof.json`: the fixture proof, from `scripts/check-local.ts` |
| 11 | `0x6102522c47aa7951248c7f1bdb963eb01952d7812caff125b556cd60e8b3430e` | 2 | `0x6c9b6500e92765d96e668055c756188374fd349f177eb00572a7b6d3435f9783` | 402,066 | 256-byte proof, depth 2, different CID and case from the fixture |
| 12 | `0x23bdf3c22f5a37a4d66cc59ed50677f1fed8a1dd91266f924f6ef240b9224cfa` | 2 | `0x8f60093236a973dafee3585cbb7c82141d20e41f846233cc3e346f5b2c756265` | 402,066 | same shape. `status.md` records the `scripts/demo.ts` run as block 12 |

Block 12 details: case `0x70979eed82c047eac8892cf1a240b4ebb889fcbfc20cc8abb5d751a34a6747e9`, root `0x0b448b84ad903ef41c6ac55f2a18fdcfa5025e15e457ce72a34bc48e104e9f55`, nullifier `0x2055effb4f791424dcbacf00d29abc4c5a16998306a5266ead665233591888c6`, proof 256 bytes. Blocks 11 and 12 have the same group and root, so they come from the same seeded group; attributing 11 to a particular script run was not checked.

Re-check done for this file: calling the adapter directly,

```sh
cast call 0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512 \
  "verify(uint256,uint256,uint256,uint256,uint256,bytes)(bool)" <root> <nullifier> <message> <scope> 2 <proof> --rpc-url http://127.0.0.1:8545
```

with the values from `contracts/test/fixtures/semaphore-proof.json` returned `true`. With the message value changed by one bit it returned `false` (negative control). I did not re-verify the block 11 and 12 proofs: their message and scope values are not in a file, and the circuit files are not in the repository.

What this proves and does not prove:

- It proves the contract and the Semaphore verifier accept a real proof on a local chain.
- It does **not** show anonymity: these were direct transactions from the anvil account, so the poster address is visible on chain, which is the documented limitation of the direct path.
- It is not an alt-mempool result and not a frame transaction.

Earlier deployments on the same chain (blocks 13 to 24) from previous runs are not listed.

## 2. Alt-mempool devnet (chain 1337): not yet reached

As of the timestamp in [`devnet-status.md`](devnet-status.md) the devnet endpoints failed TLS verification from the development machine (certificate not yet valid) and nothing was sent. Every field below is empty on purpose. Fill each from real output only.

Prerequisites: `pnpm tsx scripts/check-devnet.ts` exits 0; your own funded throwaway key (see `sidecar/README.md`, "Funding"); `pnpm build:contracts`.

### 2a. Deployment

```sh
RPC_URL=https://altmempool.forshtat.com DEPLOYER_PRIVATE_KEY=0x... \
  pnpm tsx scripts/deploy.ts --mock --direct=false --fund 0.1 --stake 0.02 --out config/devnet.json
```

| Field | Value |
|---|---|
| Date and time (UTC) | |
| Deployer address | |
| `ZeroDrop` address | |
| `MockVerifier` address | |
| Deploy block (from `config/devnet.json`) | |
| Float after deploy (script prints it) | |
| Stake tx hash and amount | |
| `getDepositInfo(ZeroDrop)` on the registry (`cast call 0xd51c04d7a0b01124e84de152f4e56d9eecb22d2f "getDepositInfo(address)(uint256,uint32,uint64)" <ZeroDrop> --rpc-url https://altmempool.forshtat.com`) | |

### 2b. Gas spike (the first frame transaction)

```sh
RPC_URL=https://altmempool.forshtat.com MEMPOOL_URLS=https://altmempool.forshtat.com/rpc DEPLOYER_PRIVATE_KEY=0x... \
  pnpm tsx scripts/gas-spike.ts --fund 0.1 --stake 0.012 --trace
```

| Field | Value |
|---|---|
| Date and time (UTC) | |
| `ethrex_simulateFrameTransaction` result (`valid`, `violation`, `gasUsed`) | |
| Submit result: tx hash, or the rejection error verbatim | |
| `skandha_frameTransactionStatus` | |
| `eth_getFrameTransactionReceipt` | |
| Block number | |
| Explorer link (explorer.altmempool.wtf) | |
| Verification gas actually used by the VERIFY frame | |

If the sidecar rejects the transaction, paste the rejection in the table and keep it. A rejection that names the 100,000 cap or a precompile rule is the answer to the open question in `sidecar/README.md`.

### 2c. Admitted disclosure through the hosted sidecar

| Field | Value |
|---|---|
| Date and time (UTC) | |
| Mode (mock verifier or Semaphore) | |
| Disclosure tx hash | |
| Explorer link | |
| `Disclosed` event (cidDigest, group, case, nullifier) | |
| Reader result: L0, L1, L2 | |

### 2d. Admitted disclosure through our own sidecar (walk-away)

| Field | Value |
|---|---|
| Date and time (UTC) | |
| How the sidecar was started (`sidecar/run.sh` flags, ethrex URL) | |
| Sidecar URL in the app's list, hosted URL removed | |
| Disclosure tx hash | |
| Status after submission | |

### 2e. Canonical mempool rejection

See [`canonical-rejection.md`](canonical-rejection.md). Paste the captured response here once it exists.

| Field | Value |
|---|---|
| Date and time (UTC) | |
| Request (method, endpoint) | |
| Response verbatim | |
| Same transaction through the alt mempool | |
