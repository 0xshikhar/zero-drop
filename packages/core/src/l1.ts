import { parseAbi, type Address, type Hex, type PublicClient } from "viem";
import { fanOutRead, stableKey } from "./chain";
import { ProofUnsupportedError, verifyRecordStorageProof, type StorageProofResult } from "./storageproof";

/**
 * Minimal ABI for the two reads used here. It is written locally on purpose: this module needs only
 * `records` and `Disclosed`, and it must not depend on the generated ABI file.
 * `records(bytes32)` returns (groupId, caseId, root, nullifier, blockNumber, exists).
 */
export const L1_RECORD_ABI = parseAbi([
  "function records(bytes32 cidDigest) view returns (uint256 groupId, bytes32 caseId, uint256 root, uint256 nullifier, uint64 blockNumber, bool exists)",
  "event Disclosed(bytes32 indexed cidDigest, uint256 indexed groupId, bytes32 indexed caseId, uint256 root, uint256 nullifier, uint256 depth, bytes proof)",
]);

export type VerifyInclusionArgs = {
  /** One client per endpoint. Use several independent RPC operators for a meaningful quorum. */
  publicClients: readonly PublicClient[];
  zeroDropAddress: Address;
  cidDigest: Hex;
  /** When given, the on-chain root must equal it. */
  expectedRoot?: bigint;
  /**
   * Endpoints that must agree (integer >= 2) when there are several. With exactly one endpoint, the
   * only accepted value is "single-endpoint", which states the trust limit explicitly.
   */
  quorum: number | "single-endpoint";
  /** When given, every endpoint must also report this chain id. */
  expectedChainId?: number;
  /**
   * Storage proof of the record (`eth_getProof`, verified locally against the block's state root).
   * - "auto" (default): do it when the endpoints serve `eth_getProof`. Otherwise fall back to the plain
   *   reads and say so in `notes` (`storageProofVerified` is false).
   * - true: required. Endpoints without `eth_getProof` make the result not ok.
   * - false: skip, plain reads only.
   */
  storageProof?: boolean | "auto";
};

export type InclusionResult = {
  ok: boolean;
  reason: string;
  /** What this check did not verify, and what it trusts. */
  notes: string[];
  groupId?: bigint;
  caseId?: Hex;
  root?: bigint;
  nullifier?: bigint;
  depth?: bigint;
  blockNumber?: bigint;
  blockHash?: Hex;
  /** Endpoints that agreed on the block hash. */
  agreeingEndpoints: number;
  /** The record was proven against a state root by `eth_getProof` and local MPT verification. */
  storageProofVerified: boolean;
  /** The full storage proof result, when one was attempted. */
  storageProof?: StorageProofResult;
  /** Members covered by the record's root (`rootSize`), proven by the storage proof. */
  anonymitySet?: bigint;
};

/**
 * Checks that `cidDigest` is recorded on ZeroDrop, and that the record and its Disclosed event agree
 * across endpoints.
 *
 * What is checked:
 * - `records(cidDigest)` is read from every endpoint, and the quorum must agree.
 * - `Disclosed` logs for `cidDigest` in the record's block are read from every endpoint. Exactly one
 *   log must match, and its fields must equal the record.
 * - The block hash at that height is read from every endpoint, and the quorum must agree. The log's
 *   blockHash must equal it.
 *
 * - Storage proof (default, when the endpoints serve `eth_getProof`): `records[cidDigest]` and the
 *   `knownRoot` / `rootSize` entries of its root are proven by Merkle-Patricia proofs against the state
 *   root of a recent block, and the proven values must equal the record read above. See
 *   `verifyRecordStorageProof` for what that proves and its trust limit: with a quorum it is a k-of-n
 *   header agreement (not a light client); with "single-endpoint" the state root is trusted to that one
 *   RPC and the record is proven against it. Without `eth_getProof` the check falls back to the plain
 *   reads above and says so in `notes`.
 */
export async function verifyInclusion(args: VerifyInclusionArgs): Promise<InclusionResult> {
  const { publicClients: clients, zeroDropAddress, cidDigest, expectedRoot, quorum, expectedChainId } = args;
  const proofMode = args.storageProof ?? "auto";
  const notes: string[] = [];
  const fail = (reason: string, agreeingEndpoints = 0, extra: Partial<InclusionResult> = {}): InclusionResult => ({
    ok: false,
    reason,
    notes,
    agreeingEndpoints,
    storageProofVerified: false,
    ...extra,
  });

  if (clients.length === 0) return fail("no RPC endpoints configured");

  const single = quorum === "single-endpoint";
  if (single && clients.length !== 1) {
    return fail(`quorum "single-endpoint" requires exactly one endpoint, but ${clients.length} are configured`);
  }
  if (!single) {
    if (!Number.isInteger(quorum) || quorum < 2) {
      return fail('quorum must be an integer >= 2, or "single-endpoint" with exactly one endpoint');
    }
    if (quorum > clients.length) return fail(`quorum ${quorum} exceeds the ${clients.length} configured endpoint(s)`);
  }
  const required = single ? 1 : quorum;

  if (expectedChainId !== undefined) {
    const chains = await fanOutRead(clients, (c) => c.getChainId(), { quorum: required });
    if (!chains.ok) return fail(`chain id: ${chains.reason}`, chains.agreeing);
    if (chains.value !== expectedChainId) {
      return fail(`endpoints report chain ${chains.value}, expected ${expectedChainId}`, chains.agreeing);
    }
  }

  // 1. The record, from every endpoint.
  const recordRead = await fanOutRead(
    clients,
    async (c) => {
      const [groupId, caseId, root, nullifier, blockNumber, exists] = (await c.readContract({
        address: zeroDropAddress,
        abi: L1_RECORD_ABI,
        functionName: "records",
        args: [cidDigest as Hex],
      })) as readonly [bigint, Hex, bigint, bigint, bigint, boolean];
      return { groupId, caseId, root, nullifier, blockNumber, exists };
    },
    { quorum: required },
  );
  if (!recordRead.ok) return fail(`records: ${recordRead.reason}`, recordRead.agreeing);
  const record = recordRead.value!;
  if (!record.exists) return fail("no record for this cidDigest on the agreed view");
  if (expectedRoot !== undefined && record.root !== expectedRoot) {
    return fail(`record root ${record.root} differs from expectedRoot ${expectedRoot}`, recordRead.agreeing);
  }

  // 2. The Disclosed log in the record's block, from every endpoint.
  const logRead = await fanOutRead(
    clients,
    (c) =>
      c.getContractEvents({
        address: zeroDropAddress,
        abi: L1_RECORD_ABI,
        eventName: "Disclosed",
        args: { cidDigest: cidDigest as Hex },
        fromBlock: record.blockNumber,
        toBlock: record.blockNumber,
      }),
    {
      quorum: required,
      key: (logs) =>
        stableKey(
          logs.map((l) => ({
            blockHash: l.blockHash,
            transactionHash: l.transactionHash,
            logIndex: l.logIndex,
            args: l.args,
          })),
        ),
    },
  );
  if (!logRead.ok) return fail(`Disclosed logs: ${logRead.reason}`, logRead.agreeing);
  const logs = logRead.value!;
  if (logs.length !== 1) {
    return fail(`expected exactly one Disclosed log at block ${record.blockNumber}, got ${logs.length}`, logRead.agreeing);
  }
  const [log] = logs;
  const logArgs = log!.args as {
    groupId: bigint;
    caseId: Hex;
    root: bigint;
    nullifier: bigint;
    depth: bigint;
  };
  if (
    logArgs.groupId !== record.groupId ||
    logArgs.caseId.toLowerCase() !== record.caseId.toLowerCase() ||
    logArgs.root !== record.root ||
    logArgs.nullifier !== record.nullifier
  ) {
    return fail("Disclosed log disagrees with the record", logRead.agreeing);
  }

  // 3. The block hash at that height, from every endpoint.
  const hashRead = await fanOutRead(
    clients,
    async (c) => {
      const block = await c.getBlock({ blockNumber: record.blockNumber });
      if (!block.hash) throw new Error("block has no hash (not final)");
      return block.hash;
    },
    { quorum: required },
  );
  if (!hashRead.ok) return fail(`block hash: ${hashRead.reason}`, hashRead.agreeing);
  const blockHash = hashRead.value!;
  if (log!.blockHash?.toLowerCase() !== blockHash.toLowerCase()) {
    return fail("the log's block hash differs from the quorum block hash", hashRead.agreeing);
  }

  // 4. Storage proof of the record against a state root.
  let proof: StorageProofResult | undefined;
  if (proofMode !== false) {
    try {
      proof = await verifyRecordStorageProof({ publicClients: clients, zeroDropAddress, cidDigest, quorum });
    } catch (e) {
      if (!(e instanceof ProofUnsupportedError)) throw e;
      if (proofMode === true) return fail(`storage proof required but unavailable: ${e.message}`, hashRead.agreeing);
      notes.push(
        `Storage proof NOT verified: the endpoints do not serve eth_getProof (${e.message}). ` +
          "Fell back to the plain reads: record, Disclosed log and block hash agreement.",
      );
    }
  } else {
    notes.push("Storage proof NOT verified: skipped by the caller (storageProof: false).");
  }
  if (proof) {
    notes.push(...proof.notes);
    if (!proof.ok) return fail(`storage proof: ${proof.reason}`, hashRead.agreeing, { storageProof: proof });
    const v = proof.values!;
    if (
      v.groupId !== record.groupId ||
      v.caseId.toLowerCase() !== record.caseId.toLowerCase() ||
      v.root !== record.root ||
      v.nullifier !== record.nullifier ||
      v.blockNumber !== record.blockNumber ||
      !v.exists
    ) {
      return fail("the proven storage differs from what the records() getter returned", hashRead.agreeing, {
        storageProof: proof,
      });
    }
  }

  const proven = proof?.ok === true;
  let trust: string;
  if (proven) {
    trust = single
      ? "Single endpoint: the record is proven by storage proof against the state root that one RPC served; that state root is trusted to it, so it is not checked against the canonical chain."
      : `Agreement of ${required} of ${clients.length} endpoints on the record, the Disclosed log and the block hash; the record is proven by storage proof against the quorum state root. Not a light client.`;
  } else {
    trust = single
      ? "Single endpoint: the answer is trusted to one RPC with no cross-check. Storage proof NOT verified."
      : `Agreement of ${required} of ${clients.length} endpoints on the record, the Disclosed log and the block hash. Not a light client. Storage proof NOT verified.`;
  }
  return {
    ok: true,
    reason: `Disclosed record found in block ${record.blockNumber}. ${trust}`,
    notes,
    groupId: record.groupId,
    caseId: record.caseId,
    root: record.root,
    nullifier: record.nullifier,
    depth: logArgs.depth,
    blockNumber: record.blockNumber,
    blockHash,
    agreeingEndpoints: hashRead.agreeing,
    storageProofVerified: proven,
    storageProof: proof,
    anonymitySet: proof?.values?.anonymitySet,
  };
}
