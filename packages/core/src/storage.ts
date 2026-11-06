/**
 * ZeroDrop Large-Scale Storage Endowment (Panama Papers Scale)
 *
 * Implements client calculations, quoting, and contract interactions for decentralized
 * storage endowments. Files <= 1 MiB are free; files > 1 MiB can be backed by an on-chain
 * storage endowment in ZeroDropStorage.sol to incentivize continuous IPFS/Filecoin persistence.
 */
import type { Hex, PublicClient } from "viem";
import { zeroDropStorageAbi } from "./abi";

export const FREE_TIER_BYTES = 1_048_576; // 1 MiB
export const DEFAULT_RATE_PER_MB_PER_BLOCK = 100n; // wei per MB per block
export const ETHEREUM_BLOCK_TIME_SECONDS = 12;

export interface StorageQuote {
  sizeBytes: number;
  durationBlocks: bigint;
  durationDays: number;
  excessBytes: number;
  excessMb: number;
  isFreeTier: boolean;
  costWei: bigint;
  costEthFormatted: string;
}

export interface StorageStatus {
  isFunded: boolean;
  balanceWei: bigint;
  sizeBytes: number;
  paidUntilBlock: bigint;
  blocksRemaining: bigint;
  daysRemaining: number;
  pinnerCount: number;
}

/**
 * Calculates storage cost quote in wei for a given byte size and target duration in days.
 */
export function calculateStorageQuote(
  sizeBytes: number,
  durationDays = 365,
  ratePerMbPerBlock = DEFAULT_RATE_PER_MB_PER_BLOCK
): StorageQuote {
  const isFreeTier = sizeBytes <= FREE_TIER_BYTES;
  const blocksPerDay = BigInt(Math.floor((24 * 3600) / ETHEREUM_BLOCK_TIME_SECONDS)); // ~7200 blocks/day
  const durationBlocks = BigInt(durationDays) * blocksPerDay;

  if (isFreeTier) {
    return {
      sizeBytes,
      durationBlocks,
      durationDays,
      excessBytes: 0,
      excessMb: 0,
      isFreeTier: true,
      costWei: 0n,
      costEthFormatted: "0 ETH (Free Tier)",
    };
  }

  const excessBytes = sizeBytes - FREE_TIER_BYTES;
  const excessMb = Math.ceil(excessBytes / (1024 * 1024));
  const costWei = BigInt(excessMb) * ratePerMbPerBlock * durationBlocks;

  const costEth = Number(costWei) / 1e18;
  const costEthFormatted = `${costEth.toFixed(4)} ETH`;

  return {
    sizeBytes,
    durationBlocks,
    durationDays,
    excessBytes,
    excessMb,
    isFreeTier: false,
    costWei,
    costEthFormatted,
  };
}

/**
 * Formats data size into human-readable string (KB, MB, GB, TB).
 */
export function formatDataSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * Queries the on-chain storage endowment status for a CID digest.
 */
export async function getStorageEndowmentStatus(
  client: PublicClient,
  storageContractAddress: Hex,
  cidDigest: Hex
): Promise<StorageStatus> {
  try {
    const result = (await client.readContract({
      address: storageContractAddress,
      abi: zeroDropStorageAbi,
      functionName: "getStorageStatus",
      args: [cidDigest],
    })) as [boolean, bigint, bigint, bigint, bigint, bigint];

    const [isFunded, balance, sizeBytesBig, paidUntilBlock, blocksRemaining, pinnerCount] = result;
    const daysRemaining = Number(blocksRemaining) / (7200);

    return {
      isFunded,
      balanceWei: balance,
      sizeBytes: Number(sizeBytesBig),
      paidUntilBlock,
      blocksRemaining,
      daysRemaining: Math.max(0, Math.round(daysRemaining)),
      pinnerCount: Number(pinnerCount),
    };
  } catch {
    return {
      isFunded: false,
      balanceWei: 0n,
      sizeBytes: 0,
      paidUntilBlock: 0n,
      blocksRemaining: 0n,
      daysRemaining: 0,
      pinnerCount: 0,
    };
  }
}

