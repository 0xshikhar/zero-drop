/** Small deploy/send helpers on top of viem, shared by scripts/deploy.ts and scripts/gas-spike.ts. */
import { createPublicClient, createWalletClient, http, type Abi, type Address, type Hex } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { loadArtifact } from "./chain-env.ts";

export function makeDeployer(url: string, account: PrivateKeyAccount) {
  const transport = http(url);
  const publicClient = createPublicClient({ transport });
  const walletClient = createWalletClient({ account, transport });

  async function deploy(name: string, args: unknown[] = []) {
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
  }

  async function send(address: Address, abi: Abi, functionName: string, args: unknown[], value?: bigint): Promise<Hex> {
    const hash = await walletClient.writeContract({ address, abi, functionName, args, value, account, chain: null });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${functionName} reverted (tx ${hash})`);
    console.log(`${functionName} ok (block ${receipt.blockNumber})`);
    return hash;
  }

  return { publicClient, walletClient, deploy, send };
}
