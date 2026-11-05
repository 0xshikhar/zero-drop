# Running your own alt-mempool sidecar

ZeroDrop does not run a relayer. A frame transaction authorises and pays for itself, so any alt-mempool node can carry it (`docs/architecture.md`, section 3.4). This folder is how you run one yourself, and how the app's "remove the hosted sidecar, post through your own" step is meant to work.

> **Status, plainly.** Nothing in this folder has been run against a real sidecar. `run.sh --check` and `run.sh --print` were run and behave as described below. `run.sh --run` was only run to confirm that it refuses when prerequisites are missing. On the machine this was written on, the Docker daemon was not running, there was no checkout of the upstream sidecar, and the public devnet's TLS certificate was not yet valid (see `evidence/devnet-status.md`). The upstream repository was not cloned or built.

## What the sidecar is

The sidecar is not our code. It is [`forshtat/mempool-workshop-sidecar`](https://github.com/forshtat/mempool-workshop-sidecar) (MIT, branch `master`), a fork of Etherspot's Skandha ERC-4337 bundler that handles EIP-8141 frame transactions. It exposes `eth_sendFrameTransaction`, simulates each transaction with `ethrex_simulateFrameTransaction`, applies the alt-mempool rules, optionally gossips over libp2p, and in `auto` mode relays to an ethrex node with `ethrex_submitPrivilegedFrameTransaction`.

`run.sh` only automates the documented steps. It writes a config and runs the commands the upstream docs give. Sources, all read on 2026-11-06:

- `docs.altmempool.wtf/guides/run-the-sidecar`, `/reference/cli`, `/reference/configuration`, `/guides/devnet`, `/guides/staking`
- the upstream `README.md` and `deploy/devnet/devnet-readme.md` (sections 1 and 7)

## Usage

```sh
sidecar/run.sh --check        # prerequisites; exit 1 if any is missing; runs nothing else
sidecar/run.sh                # prints the config and the exact upstream commands for your setup; runs nothing
sidecar/run.sh --run          # checks, then executes the documented command
sidecar/run.sh --run --node   # node mode: adds libp2p and the public devnet's boot ENR
sidecar/run.sh --bun          # use the from-source path instead of Docker (default: Docker if its daemon answers)
```

Environment:

| Variable | Needed for | Meaning |
|---|---|---|
| `ETHREX_RPC_URL` | check, run | JSON-RPC URL of an EIP-8141-aware ethrex (`eip8141-tracer` branch) for chain 1337. The public devnet's is `https://altmempool.forshtat.com` |
| `SIDECAR_REPO` | check, run | Path to your own checkout of the upstream sidecar. The script never clones or builds it for you |
| `SKANDHA_RELAYERS` | run | The key that submits transactions on chain. Use a throwaway devnet key. It is passed through the environment and never written to a file or printed. The docs name this variable but not its exact format (single key or list); the documented file form is `"relayers": ["0x..."]` |
| `STAKING_REGISTRY` | optional | Default `0xd51c04d7a0b01124e84de152f4e56d9eecb22d2f` (devnet `NaiveStakingRegistry`; the docs say it can change when the devnet resets) |
| `SIDECAR_PORT` | optional | Default 14337 |

Prerequisites it checks: the Docker daemon (or `bun` for `--bun`), `ETHREX_RPC_URL`, `SIDECAR_REPO`, `SKANDHA_RELAYERS`. It also reports whether `cargo` exists. `cargo` is only needed to build ethrex from source, and the docs read for this script give no cargo command, so none is printed. Running ethrex yourself is documented as a Docker image (`ghcr.io/forshtat/ethrex:eip8141-tracer-latest`, devnet-readme section 4); we have not done that either.

The commands it prints and runs (Docker path), from the upstream docs:

```sh
cd "$SIDECAR_REPO"
docker build -t skandha .
docker run --mount type=bind,source="<config.json>",target=/usr/app/config.json,readonly -dp 14337:14337 skandha standalone
```

Two deliberate differences when `--run` executes it: the published port is bound to loopback (the sidecar has open admin methods and holds a relayer key), and the relayer key comes from `-e SKANDHA_RELAYERS` rather than the config file. The from-source path is `bun install`, `bun run build`, `./skandha standalone --configFile <config.json>`.

## What we do not have

1. **The BUDGET-010 patched branch.** BUDGET-010 is the ERC-8421 rule that tracks verification gas per entity, so a staked entity can use far more than an unstaked one. Our own research notes (`docs/research/README.md`, checked against the sidecar source and GitHub on 2026-11-06) say the upstream pull requests for it (#2 to #4) were open and not merged, and that the sidecar hard-coded the 100,000 gas verification cap. The docs site today describes per-entity budgets but also marks the numbers as unresolved (100k and 1M in the draft, 250k and 2.5M on the landing page), and says the sidecar follows an earlier draft. We have not been able to ask a live node what it enforces.
2. **A BN254 precompile allowlist.** Verifying a Groth16 proof calls the pairing precompiles. The same research notes report that the default allowlist for precompiles in validation (rule CALLING-040) is empty, so such calls are rejected. We did not find a configuration field for it in the configuration reference, so this script does not set one. We did not verify this either.

What this means for a verification step over 100k gas:

- Running the stock upstream sidecar ourselves changes who relays the transaction. It does not change the rules. A stock sidecar should be expected to admit and reject the same transactions as the hosted one.
- A ZeroDrop `VERIFY` frame that burns 300k gas (the `MockVerifier` path) is therefore expected to be rejected by a stock sidecar if the 100k cap is in force. The real Semaphore verifier would additionally hit the precompile rule. Both are **expectations from documents, not observed results**. Whether the hosted devnet currently admits either has not been tested; that is what `scripts/gas-spike.ts` is for (below).
- To get past both, the plan in `docs/research/03-build-plan.md` is a locally patched sidecar (BUDGET-010 branch plus an allowlist for precompiles 0x01 to 0x11) relayed to the public ethrex. That is not in this repository and `run.sh` does not build it. If the hosted devnet does not admit >100k verification and nobody deploys the patch, the fallback in `docs/phases.md` applies: demo with `MockVerifier`, state the gap, and show canonical-mempool rejection as the evidence (`evidence/canonical-rejection.md`).

## Pointing the app at a sidecar

The app takes a list of sidecar URLs and submits to all of them unless the "single sidecar" toggle is on.

- At runtime: Settings, sidecar URLs, add `http://127.0.0.1:14337/rpc` (or any other `/rpc` URL). Stored in the browser.
- At build time: `sidecarUrls` in `config/devnet.json`. `apps/web/src/lib/config.ts` reads every `config/*.json` when the app is built, so rebuild after editing. `scripts/deploy.ts` does not write `sidecarUrls`; add the key by hand after a deploy (it replaces the placeholder file).
- The page's Content-Security-Policy lists loopback origins for direct requests. A remote sidecar contacted directly (not through Anon-RPC) needs the build variable `ZERODROP_CSP_CONNECT="https://host"` (see `apps/web/vite.config.ts`). Through Anon-RPC the requests come from the harness worker and are not governed by the page's `connect-src`. That route has not been run against Tor by us.

The sidecar's own RPC is `http://127.0.0.1:14337/rpc/`. Check it:

```sh
curl -s -X POST http://127.0.0.1:14337/rpc -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}'
```

## Staking

A sender needs stake to use the larger staked budgets. The registry keys everything off `msg.sender`, so `ZeroDrop` (the sender) must call `addStake` itself.

- Interface: `contracts/src/IStakingRegistry.sol` (`addStake(uint32 unstakeDelaySec) payable`, `unlockStake()`, `withdrawStake(address)`, `getDepositInfo(address)`). Devnet registry: `0xd51c04d7a0b01124e84de152f4e56d9eecb22d2f`.
- `ZeroDrop.stake(86400, amount)` (owner only) forwards `amount` from the contract's own float to the registry. So fund the float first with `donate()`, then stake. `scripts/deploy.ts --fund <eth> --stake <eth>` does both, in that order.
- The amount must be strictly greater than the sidecar's `minStake` (0.01 ETH on the devnet) for the BALANCE and SELFBALANCE carve-out. The upstream workshop stakes 0.012 ETH, the command below uses 0.02. The unstake delay is 86400 seconds (ERC-8421 minimum).
- The sidecar must know the registry (`stakingRegistryAddress` in its config, or `SKANDHA_STAKING_REGISTRY_ADDRESS`), otherwise it treats every entity as unstaked. `run.sh` writes it into the config.
- `unlockStake()` removes every staked permission at once. Never stake from the shared genesis key.

## Funding

There is no reliable faucet to count on. The docs site says "no faucet". The upstream `devnet-readme.md` says there is one: a "Faucet" button in the explorer, or `skandha_explorer_faucet` on the sidecar (1 ETH per address per hour), and the hackathon page also mentions a faucet. Which is current is unverified.

The documented fallback: one account is funded at genesis and its key is **published on purpose** in the upstream repository (`deploy/devnet/genesis.values.env`), so everyone shares it and nonce collisions are possible. The documented pattern is to generate your own key and fund it once from the shared account with a plain transfer (the workshop's `npm run step_1_check` does that). A transfer to a brand-new account needs at least 204,600 gas on this network because of the extra state gas; 250,000 is comfortable.

Rules for this repository: never copy any private key into it (not the shared one, not yours), never stake or hold anything from the shared key, put your own key only in the shell environment (`DEPLOYER_PRIVATE_KEY`).

## Deploying ZeroDrop to the devnet, once TLS is valid

At the time of writing the certificate for `altmempool.forshtat.com` has `notBefore` 2026-11-06 05:31:33 GMT, later than this machine's clock. Do not work around it with `-k` or `NODE_TLS_REJECT_UNAUTHORIZED=0`. Check:

```sh
pnpm tsx scripts/check-devnet.ts          # exit 0 only when the execution RPC and the sidecar both answer with chain 1337
```

Then, with your own funded key in the environment (the flags below are the real ones in `scripts/deploy.ts`):

```sh
pnpm build:contracts            # deploy.ts reads bytecode from contracts/out
RPC_URL=https://altmempool.forshtat.com DEPLOYER_PRIVATE_KEY=0x... \
  pnpm tsx scripts/deploy.ts --mock --direct=false --fund 0.1 --stake 0.02 --out config/devnet.json
```

Then add the sidecar URL to `config/devnet.json` (`"sidecarUrls": ["https://altmempool.forshtat.com/rpc"]`) and rebuild the app. Then the gas spike, which deploys its own fresh `ZeroDrop` with a `MockVerifier`, builds the 2-frame transaction, simulates it with `ethrex_simulateFrameTransaction`, submits it and polls:

```sh
RPC_URL=https://altmempool.forshtat.com MEMPOOL_URLS=https://altmempool.forshtat.com/rpc DEPLOYER_PRIVATE_KEY=0x... \
  pnpm tsx scripts/gas-spike.ts --fund 0.1 --stake 0.012 --trace
```

`--dry` builds and prints the encoded transaction offline (no network, no key). `scripts/gas-spike.ts` has never been run against a frame-capable node. Record whatever it prints, including a rejection and its reason, in `evidence/txs.md`.

## Running a node for the walk-away demo

1. Run `sidecar/run.sh --run` (Docker or bun) with `ETHREX_RPC_URL` pointing at an ethrex you trust. The relay call is unauthenticated on the public devnet, so on the public node anyone can submit privileged transactions; that is a devnet shortcut, not a design to copy.
2. Add your sidecar URL to the app's sidecar list, remove the hosted one, post, and check the status with `skandha_frameTransactionStatus`.
3. Record the result in `evidence/txs.md`. Until this has been done, "posting through our own sidecar lands" is unproven.
