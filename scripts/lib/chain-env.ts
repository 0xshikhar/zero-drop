/**
 * Shared environment handling for the deploy and spike scripts.
 *
 * Rules:
 * - RPC_URL defaults to the local anvil (http://127.0.0.1:8545).
 * - DEPLOYER_PRIVATE_KEY has a default ONLY on the local anvil chain (31337), where the key is public.
 *   On any other chain, including the devnet (1337), it must be set. The key is never printed.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, http, type Abi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export const LOCAL_CHAIN_ID = 31337;
export const DEVNET_CHAIN_ID = 1337;

/** Anvil account 0. Public knowledge. Never use it on a network that holds value. */
const ANVIL_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;

/**
 * NaiveStakingRegistry on the public alt-mempool devnet (chain 1337), from docs.altmempool.wtf
 * (concepts/entities-and-stake, checked 2026-11-06). The docs say addresses can change when the devnet resets.
 */
export const DEVNET_STAKING_REGISTRY = "0xd51c04d7a0b01124e84de152f4e56d9eecb22d2f" as Address;
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;

export function rpcUrl(): string {
  return process.env.RPC_URL ?? "http://127.0.0.1:8545";
}

export async function chainIdOf(url: string): Promise<number> {
  return createPublicClient({ transport: http(url) }).getChainId();
}

/** Account for the chain. Throws, without echoing any key material, when none is configured. */
export function signerFor(chainId: number) {
  const configured = process.env.DEPLOYER_PRIVATE_KEY;
  if (configured) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(configured)) {
      throw new Error("DEPLOYER_PRIVATE_KEY must be a 0x-prefixed 32-byte hex string");
    }
    return privateKeyToAccount(configured as Hex);
  }
  if (chainId === LOCAL_CHAIN_ID) return privateKeyToAccount(ANVIL_KEY);
  throw new Error(
    `DEPLOYER_PRIVATE_KEY is required on chain ${chainId}. The built-in default exists only for the local anvil chain ${LOCAL_CHAIN_ID}.`,
  );
}

export interface Artifact {
  abi: Abi;
  bytecode: { object: Hex };
}

/** Reads a forge artifact. Run `forge build` first. */
export function loadArtifact(name: string): Artifact {
  const path = resolve(repoRoot, `contracts/out/${name}.sol/${name}.json`);
  return JSON.parse(readFileSync(path, "utf8")) as Artifact;
}
