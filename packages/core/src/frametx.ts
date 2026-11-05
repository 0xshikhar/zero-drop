/**
 * EIP-8141 frame transaction for a disclosure, using @forshtat/hegota-support.
 *
 * STATUS: NOT VERIFIED AGAINST THE DEVNET. The public alt-mempool devnet (chain 1337) presents a TLS
 * certificate that currently fails validation from the development machine ("certificate is not yet
 * valid"). Nothing in this file has been simulated or submitted to that devnet. Do not disable TLS
 * verification to reach it. The encoding is tested offline only (test/frametx.test.ts).
 *
 * Shape, from contracts/src/frame/DisclosureFrameChecks.sol and docs/architecture.md section 4:
 * - tx.sender is ZeroDrop (self relay: the contract pays, the source holds no account).
 * - frames[0] = VERIFY, target null (tx.sender), scope EXECUTION_AND_PAYMENT.
 * - frames[1] = SENDER, target ZeroDrop, value 0, calldata = record(...).
 * - nonceKeys = [nullifier] (EIP-8250 keyed nonce, one per nullifier).
 * - signatures = [ARBITRARY entry whose signature bytes are the Semaphore proof].
 */
import { encodeFunctionData, keccak256, parseAbi, toBytes, type Address, type Hex } from "viem";
import { profile as tracerProfile } from "@forshtat/hegota-support/profiles/ethrex-eip8141-tracer";
import { encodeTx, frame, newTx, sigHash, sigScheme, txHash, type FrameTx } from "@forshtat/hegota-support/tx";
import { RpcError, explainRejection, toWire, type Rejection } from "@forshtat/hegota-support/rpc";
import { network as defaultNetwork, type NetworkClient, type RequestRole } from "./net";

export const DISCLOSURE_PROFILE = tracerProfile;
export const DEVNET_CHAIN_ID = 1337;

/** Signature of ZeroDrop.record. Its selector is checked by DisclosureFrameChecks.RECORD_SELECTOR. */
export const RECORD_SIGNATURE = "record(uint256,bytes32,bytes32,uint256,uint256,uint256,bytes)";
const RECORD_ABI = parseAbi([`function ${RECORD_SIGNATURE}`]);

/** Mirror of DisclosureFrameChecks.MIN_BODY_GAS (450k: a real depth-2 Semaphore `record` needs about 395k, and record re-verifies on the frame path). */
export const MIN_SENDER_EXECUTION_GAS = 450_000n;
/** Mirror of DisclosureFrameChecks.MAX_COST_CAP (0.01 ether in wei). */
export const MAX_COST_CAP_WEI = 10n ** 16n;

export type DisclosureFrameTxArgs = {
  /** Defaults to the devnet, 1337. */
  chainId?: number;
  /** The deployed ZeroDrop. It is both tx.sender and the SENDER frame target. */
  zeroDrop: Address;
  groupId: bigint;
  caseId: Hex;
  cidDigest: Hex;
  root: bigint;
  nullifier: bigint;
  depth: bigint;
  /** Semaphore proof bytes (the ABI-encoded uint256[8] the verifier reads). */
  proof: Hex;
  /** Sequence within the nullifier's nonce key. Defaults to 0. */
  nonceSeq?: bigint;
  maxFeePerGas: bigint;
  /** Defaults to maxFeePerGas. */
  maxPriorityFeePerGas?: bigint;
  /** Execution gas for the VERIFY frame. Defaults to 450 000 (a verifier call plus the checks). */
  verifyExecutionGas?: bigint;
  /** Execution gas for the SENDER frame. Defaults to 800 000, and must be >= MIN_SENDER_EXECUTION_GAS. */
  senderExecutionGas?: bigint;
  /** State gas for the SENDER frame. Defaults to 200 000. */
  senderStateGas?: bigint;
  /** Also copy the proof into the ARBITRARY signature entry. The VERIFY fallback reads the proof from the SENDER frame calldata, so this only doubles the size. Default false. */
  proofInSignature?: boolean;
};

export type DisclosureFrameTx = {
  tx: FrameTx;
  /** `0x06 || rlp(payload)`, the bytes sent to the mempool. */
  raw: Hex;
  /** The library's sigHash. It does not cover the ARBITRARY proof bytes (see note below). */
  sigHash: Hex;
  txHash: Hex;
};

/**
 * ABI-encoded calldata for ZeroDrop.record. The selector is keccak256 of RECORD_SIGNATURE.
 */
export function recordCalldata(args: Pick<DisclosureFrameTxArgs, "groupId" | "caseId" | "cidDigest" | "root" | "nullifier" | "depth" | "proof">): Hex {
  return encodeFunctionData({
    abi: RECORD_ABI,
    functionName: "record",
    args: [args.groupId, args.caseId, args.cidDigest, args.root, args.nullifier, args.depth, args.proof],
  });
}

/** Selector of record(...), computed from its signature. */
export function recordSelector(): Hex {
  return keccak256(toBytes(RECORD_SIGNATURE)).slice(0, 10) as Hex;
}

/**
 * The two frames of a disclosure. Throws when the arguments break a rule that the on-chain
 * DisclosureFrameChecks would also reject, so the failure is named before anything is sent.
 */
export function buildDisclosureFrames(args: DisclosureFrameTxArgs) {
  const profile = DISCLOSURE_PROFILE;
  const verifyGas = args.verifyExecutionGas ?? 450_000n;
  const senderGas = args.senderExecutionGas ?? 800_000n;
  const senderState = args.senderStateGas ?? 200_000n;
  const maxFee = args.maxFeePerGas;

  if (args.nullifier === 0n) throw new Error("nullifier must be nonzero (DisclosureFrameChecks.NullifierZero)");
  if (senderGas < MIN_SENDER_EXECUTION_GAS) {
    throw new Error(`SENDER execution gas ${senderGas} is below the floor ${MIN_SENDER_EXECUTION_GAS}`);
  }
  // Estimate of the on-chain maxCost: total gas limits times the fee cap. The contract computes its own figure.
  const estimatedCost = (verifyGas + senderGas + senderState) * maxFee;
  if (estimatedCost > MAX_COST_CAP_WEI) {
    throw new Error(`estimated max cost ${estimatedCost} wei exceeds the cap ${MAX_COST_CAP_WEI} wei`);
  }

  const frames = [
    frame(profile, "VERIFY", { scope: "EXECUTION_AND_PAYMENT", execution: verifyGas }),
    frame(profile, "SENDER", {
      target: args.zeroDrop,
      execution: senderGas,
      state: senderState,
      value: 0n,
      data: recordCalldata(args),
    }),
  ];
  return frames;
}

/**
 * Builds and encodes the disclosure transaction. The ARBITRARY signature carries the proof bytes. The
 * transaction is not signed with a key (ARBITRARY has no signer), so nothing here authenticates the
 * sender beyond the VERIFY frame's on-chain checks.
 */
export function buildDisclosureFrameTx(args: DisclosureFrameTxArgs): DisclosureFrameTx {
  const profile = DISCLOSURE_PROFILE;
  if (args.proof === "0x") throw new Error("proof must not be empty");
  const frames = buildDisclosureFrames(args);
  const tx = newTx({
    chainId: args.chainId ?? DEVNET_CHAIN_ID,
    sender: args.zeroDrop,
    nonceKeys: [args.nullifier],
    nonceSeq: args.nonceSeq ?? 0n,
    frames,
    signatures: [{ scheme: sigScheme(profile, "ARBITRARY"), signer: "0x", msg: "0x", signature: args.proofInSignature ? args.proof : "0x" }],
    fees: {
      maxFeePerGas: args.maxFeePerGas,
      maxPriorityFeePerGas: args.maxPriorityFeePerGas ?? args.maxFeePerGas,
    },
  });
  return {
    tx,
    raw: encodeTx(profile, tx),
    sigHash: sigHash(profile, tx),
    txHash: txHash(profile, tx),
  };
}

export type FrameRpcOptions = {
  url: string;
  role?: RequestRole;
  session?: string;
  /** Defaults to the module-level network singleton. Tests inject a fake. */
  net?: NetworkClient;
};

let rpcId = 0;

/**
 * Raw JSON-RPC over `network.fetch`. The library's own rpc() calls the global fetch directly, which
 * would skip the traffic meter and the isolation key, so it is not used here. Errors are the library's
 * RpcError, with the same codes.
 */
export async function frameRpc<T = unknown>(options: FrameRpcOptions, method: string, params: unknown[]): Promise<T> {
  const { url, role = "source", session = "default" } = options;
  const net = options.net ?? defaultNetwork;
  let res: Response;
  try {
    res = await net.fetch(
      url,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
      },
      role,
      session,
    );
  } catch (error) {
    throw new RpcError("RPC_UNREACHABLE", `Cannot reach ${url}: ${error instanceof Error ? error.message : String(error)}`, url, method);
  }
  let body: { result?: T; error?: { code: number; message: string } };
  try {
    body = (await res.json()) as typeof body;
  } catch {
    throw new RpcError("RPC_BAD_RESPONSE", `${url} answered HTTP ${res.status} without JSON`, url, method);
  }
  if (body.error) throw new RpcError(`RPC_${body.error.code}`, body.error.message, url, method);
  return body.result as T;
}

/**
 * Dry run through `ethrex_simulateFrameTransaction`.
 * Parameters follow docs.altmempool.wtf: [rawTx (0x06||rlp hex), block?, {trace?}]. NOT VERIFIED against a live node.
 */
export async function simulateDisclosureFrameTx(options: FrameRpcOptions & { tx: FrameTx; trace?: boolean }): Promise<unknown> {
  return frameRpc(options, "ethrex_simulateFrameTransaction", [encodeTx(DISCLOSURE_PROFILE, options.tx), null, { trace: options.trace ?? false }]);
}

export type FrameSubmitResult = {
  url: string;
  ok: boolean;
  /** The node's reply on success. */
  result?: unknown;
  /** The node's error text, mapped to a mempool rule family. */
  rejection?: Rejection;
  error?: string;
};

/**
 * Sends the transaction with `eth_sendFrameTransaction` to every mempool endpoint, in parallel. The
 * architecture calls for fan-out to all sidecars, so the result is per endpoint. Nothing is retried.
 * NOT VERIFIED against the devnet (see the file header).
 */
export async function submitDisclosureFrameTx(options: {
  tx: FrameTx;
  mempoolUrls: readonly string[];
  role?: RequestRole;
  session?: string;
  net?: NetworkClient;
}): Promise<{ accepted: boolean; results: FrameSubmitResult[] }> {
  if (options.mempoolUrls.length === 0) throw new Error("submitDisclosureFrameTx: no mempool endpoints configured");
  const wire = toWire(options.tx);
  const results = await Promise.all(
    options.mempoolUrls.map(async (url): Promise<FrameSubmitResult> => {
      try {
        const result = await frameRpc({ url, role: options.role, session: options.session, net: options.net }, "eth_sendFrameTransaction", [wire]);
        return { url, ok: true, result };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { url, ok: false, error: message, rejection: explainRejection(message) };
      }
    }),
  );
  return { accepted: results.some((r) => r.ok), results };
}

export type FrameStatusResult = { url: string; ok: boolean; status?: unknown; error?: string };

/**
 * Polls `skandha_frameTransactionStatus` on every mempool endpoint (docs: statuses include pending,
 * OnChain and Reverted). Returns one result per endpoint each call. NOT VERIFIED against a live node.
 */
export async function frameTransactionStatus(options: {
  txHash: Hex;
  mempoolUrls: readonly string[];
  role?: RequestRole;
  session?: string;
  net?: NetworkClient;
}): Promise<FrameStatusResult[]> {
  return Promise.all(
    options.mempoolUrls.map(async (url): Promise<FrameStatusResult> => {
      try {
        const status = await frameRpc({ url, role: options.role, session: options.session, net: options.net }, "skandha_frameTransactionStatus", [options.txHash]);
        return { url, ok: true, status };
      } catch (error) {
        return { url, ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }),
  );
}

/** Polls until a terminal status (a status string containing OnChain or Reverted) or the deadline passes. */
export async function waitForFrameTransaction(options: {
  txHash: Hex;
  mempoolUrls: readonly string[];
  intervalMs?: number;
  timeoutMs?: number;
  onUpdate?: (results: FrameStatusResult[]) => void;
  signal?: AbortSignal;
  net?: NetworkClient;
  role?: RequestRole;
  session?: string;
}): Promise<{ terminal: boolean; results: FrameStatusResult[] }> {
  const deadline = Date.now() + (options.timeoutMs ?? 120_000);
  let results: FrameStatusResult[] = [];
  while (Date.now() < deadline && !options.signal?.aborted) {
    results = await frameTransactionStatus(options);
    options.onUpdate?.(results);
    const text = JSON.stringify(results.map((r) => r.status ?? null)).toLowerCase();
    if (text.includes("onchain") || text.includes("reverted")) return { terminal: true, results };
    await new Promise((r) => setTimeout(r, options.intervalMs ?? 2_000));
  }
  return { terminal: false, results };
}
