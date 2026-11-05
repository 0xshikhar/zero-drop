import local from "../../../../config/local.json";
import devnet from "../../../../config/devnet.json";

/** Written by `pnpm contracts:deploy`. Chain 31337 is the local anvil demo. */
export const LOCAL = local as {
  chainId: number;
  rpcUrl: string;
  contracts: { zeroDrop: `0x${string}`; verifierAdapter: `0x${string}`; semaphoreVerifier: `0x${string}` };
  deployedBlock: number;
};

/** Devnet placeholders. Frame transactions are not verified against this devnet. */
export const DEVNET = devnet as {
  chainId: number;
  rpcUrls: string[];
  sidecarUrls: string[];
  contracts: { zeroDrop: string | null; verifier: string | null };
};
