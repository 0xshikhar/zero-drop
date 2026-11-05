/**
 * Deploys SemaphoreVerifier, SemaphoreVerifierAdapter and ZeroDrop, wires the verifier, locks it,
 * and writes config/local.json. Run with: pnpm contracts:deploy
 *
 * Env: RPC_URL (default http://127.0.0.1:8545), DEPLOYER_PRIVATE_KEY (default: anvil account 0,
 * a well-known dev key; never use it on a public network).
 * Run `forge build` first (this script reads bytecode from contracts/out).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  http,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:8545";
const DEFAULT_ANVIL_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const DEPLOYER_KEY = (process.env.DEPLOYER_PRIVATE_KEY ?? DEFAULT_ANVIL_KEY) as Hex;

interface Artifact {
  abi: Abi;
  bytecode: { object: Hex };
}

function loadArtifact(name: string): Artifact {
  const path = resolve(root, `contracts/out/${name}.sol/${name}.json`);
  return JSON.parse(readFileSync(path, "utf8")) as Artifact;
}

async function main(): Promise<void> {
  const account = privateKeyToAccount(DEPLOYER_KEY);
  const transport = http(RPC_URL);
  const publicClient = createPublicClient({ transport });
  const walletClient = createWalletClient({ account, transport });

  const chainId = await publicClient.getChainId();
  console.log(`chain ${chainId} via ${RPC_URL}, deployer ${account.address}`);

  const deploy = async (name: string, args: unknown[] = []) => {
    const artifact = loadArtifact(name);
    const hash = await walletClient.deployContract({
      abi: artifact.abi,
      bytecode: artifact.bytecode.object,
      args,
      account,
      chain: null,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success" || !receipt.contractAddress) {
      throw new Error(`${name} deployment failed (tx ${hash})`);
    }
    console.log(`${name} at ${receipt.contractAddress} (block ${receipt.blockNumber})`);
    return { address: receipt.contractAddress as Address, blockNumber: receipt.blockNumber };
  };

  const semaphore = await deploy("SemaphoreVerifier");
  const adapter = await deploy("SemaphoreVerifierAdapter", [semaphore.address]);
  const zeroDrop = await deploy("ZeroDrop");

  const zeroDropAbi = loadArtifact("ZeroDrop").abi;
  const send = async (functionName: string, args: unknown[]) => {
    const hash = await walletClient.writeContract({
      address: zeroDrop.address,
      abi: zeroDropAbi,
      functionName,
      args,
      account,
      chain: null,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${functionName} reverted (tx ${hash})`);
    console.log(`${functionName} ok (block ${receipt.blockNumber})`);
  };

  await send("setVerifier", [adapter.address]);
  await send("lockVerifier", []);

  const config = {
    chainId,
    rpcUrl: RPC_URL,
    contracts: {
      zeroDrop: zeroDrop.address,
      verifierAdapter: adapter.address,
      semaphoreVerifier: semaphore.address,
    },
    deployedBlock: Number(zeroDrop.blockNumber),
  };
  const out = resolve(root, "config/local.json");
  writeFileSync(out, JSON.stringify(config, null, 2) + "\n");
  console.log(`wrote ${out}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
