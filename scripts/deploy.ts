/**
 * Deploys ZeroDrop plus a verifier, wires the verifier and writes a config file.
 *
 *   pnpm contracts:deploy                                   # semaphore, local anvil, config/local.json
 *   pnpm contracts:deploy --mock --out config/local-mock.json
 *   RPC_URL=... DEPLOYER_PRIVATE_KEY=... pnpm contracts:deploy --mock --direct=false \
 *       --out config/devnet-mock.json --fund 0.1 --stake 0.012
 *
 * Options
 *   --mock                  MockVerifier(gasToBurn) instead of the Semaphore adapter (or env VERIFIER=mock).
 *   --gas-to-burn <n>       Gas the mock burns per verify. Default 300000.
 *   --out <path>            Config file, relative to the repo root. Default: config/local.json (config/local-mock.json
 *                           with --mock) on the local chain. Required on any other chain, so a devnet deploy never
 *                           overwrites the local config.
 *   --direct=true|false     Allow `record` to be called directly (dev path). Default true on the local chain,
 *                           false everywhere else.
 *   --registry <address>    IStakingRegistry. Default: the documented devnet registry on chain 1337, else none.
 *   --fund <eth>            After deploy, donate this much ETH to the float (`donate()`).
 *   --stake <eth>           After deploy and funding, `stake(86400, amount)` at the registry. The amount must come
 *                           from the float, so use --fund as well (or the contract balance is too low).
 *   --lock=true|false       Lock the verifier. Default true for the Semaphore verifier, false for the mock.
 *
 * Env: RPC_URL (default http://127.0.0.1:8545), DEPLOYER_PRIVATE_KEY (default only on chain 31337, never printed),
 * VERIFIER=mock.
 * Run `forge build` first (this script reads bytecode from contracts/out).
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { getAddress, isAddress, parseEther, type Address } from "viem";
import {
  DEVNET_CHAIN_ID,
  DEVNET_STAKING_REGISTRY,
  LOCAL_CHAIN_ID,
  ZERO_ADDRESS,
  chainIdOf,
  loadArtifact,
  repoRoot,
  rpcUrl,
  signerFor,
} from "./lib/chain-env.ts";
import { makeDeployer } from "./lib/deploy-lib.ts";

const { values } = parseArgs({
  options: {
    mock: { type: "boolean", default: false },
    "gas-to-burn": { type: "string" },
    out: { type: "string" },
    direct: { type: "string" },
    registry: { type: "string" },
    fund: { type: "string" },
    stake: { type: "string" },
    lock: { type: "string" },
  },
  strict: true,
  // pnpm may forward a leading "--" when called as `pnpm contracts:deploy -- --mock`.
  args: process.argv.slice(2).filter((arg, i) => !(i === 0 && arg === "--")),
});

function parseBool(name: string, value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`--${name} must be true or false, got "${value}"`);
}

const UNSTAKE_DELAY_SEC = 86_400;

async function main(): Promise<void> {
  const url = rpcUrl();
  const chainId = await chainIdOf(url);
  const account = signerFor(chainId);
  const { publicClient, deploy, send: sendTx } = makeDeployer(url, account);

  const mock = values.mock || process.env.VERIFIER === "mock";
  const verifierKind = mock ? "mock" : "semaphore";
  const gasToBurn = BigInt(values["gas-to-burn"] ?? 300_000);
  const local = chainId === LOCAL_CHAIN_ID;
  const direct = parseBool("direct", values.direct, local);
  const lock = parseBool("lock", values.lock, !mock);

  const registryArg = values.registry ?? (chainId === DEVNET_CHAIN_ID ? DEVNET_STAKING_REGISTRY : ZERO_ADDRESS);
  if (!isAddress(registryArg)) throw new Error(`--registry is not an address: ${registryArg}`);
  const registry = getAddress(registryArg) as Address;

  const outRel = values.out ?? (local ? (mock ? "config/local-mock.json" : "config/local.json") : undefined);
  if (!outRel) throw new Error(`--out is required on chain ${chainId} (it is optional only on the local chain ${LOCAL_CHAIN_ID})`);
  const out = resolve(repoRoot, outRel);

  const fundWei = values.fund ? parseEther(values.fund) : 0n;
  const stakeWei = values.stake ? parseEther(values.stake) : 0n;
  if (stakeWei > 0n && registry === ZERO_ADDRESS) throw new Error("--stake needs a registry: pass --registry <address>");

  console.log(`chain ${chainId} via ${url}, deployer ${account.address}`);
  console.log(`verifier ${verifierKind}, direct record ${direct}, registry ${registry}, out ${outRel}`);

  const zeroDrop = await deploy("ZeroDrop", [direct, registry]);
  const zeroDropAbi = loadArtifact("ZeroDrop").abi;
  const send = (functionName: string, args: unknown[], value?: bigint) =>
    sendTx(zeroDrop.address, zeroDropAbi, functionName, args, value);

  let contracts: Record<string, Address>;
  let extra: Record<string, unknown> = {};
  let verifierAddress: Address;
  if (mock) {
    const verifier = await deploy("MockVerifier", [gasToBurn]);
    verifierAddress = verifier.address;
    contracts = { zeroDrop: zeroDrop.address, mockVerifier: verifier.address };
    extra = { mockGasToBurn: gasToBurn.toString() };
  } else {
    const semaphore = await deploy("SemaphoreVerifier");
    const adapter = await deploy("SemaphoreVerifierAdapter", [semaphore.address]);
    verifierAddress = adapter.address;
    contracts = {
      zeroDrop: zeroDrop.address,
      verifierAdapter: adapter.address,
      semaphoreVerifier: semaphore.address,
    };
  }

  await send("setVerifier", [verifierAddress]);
  if (lock) await send("lockVerifier", []);

  if (fundWei > 0n) await send("donate", [], fundWei);
  if (stakeWei > 0n) await send("stake", [UNSTAKE_DELAY_SEC, stakeWei]);

  const balance = await publicClient.getBalance({ address: zeroDrop.address });
  const config = {
    chainId,
    rpcUrl: url,
    verifierKind,
    directRecordEnabled: direct,
    verifierLocked: lock,
    stakingRegistry: registry === ZERO_ADDRESS ? null : registry,
    ...extra,
    contracts,
    deployedBlock: Number(zeroDrop.blockNumber),
  };
  writeFileSync(out, JSON.stringify(config, null, 2) + "\n");
  console.log(`float ${balance} wei${stakeWei > 0n ? `, staked ${stakeWei} wei` : ""}`);
  console.log(`wrote ${out}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
