import { createMPT, verifyMPTWithMerkleProof, type MerklePatriciaTrie } from "@ethereumjs/mpt";
import {
  concat,
  fromRlp,
  hexToBigInt,
  hexToBytes,
  isHex,
  keccak256,
  pad,
  toHex,
  toRlp,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { fanOutRead } from "./chain";

/**
 * L1 inclusion by storage proof (EIP-1186, `eth_getProof`).
 *
 * What a reader gets from this module: the `ZeroDrop.records[cidDigest]` struct (and the
 * `knownRoot` / `rootSize` entries of its root), proven by Merkle-Patricia proofs against a block's
 * state root, checked locally with @ethereumjs/mpt. The state root is tied to a block hash by
 * re-deriving the hash from the header's RLP. The block hash is then agreed across the RPC quorum.
 */

// -------------------------------------------------------------------------------------------------
// Storage layout of ZeroDrop
// -------------------------------------------------------------------------------------------------

/**
 * Storage slots of the ZeroDrop mappings. They come from the compiler's layout:
 *
 *     cd contracts && forge inspect ZeroDrop storage-layout --json
 *
 *   slot 0  nextGroupId            uint256
 *   slot 1  groups                 mapping(uint256 => Group)
 *   slot 2  knownRoot              mapping(uint256 => mapping(uint256 => bool))
 *   slot 3  rootSize               mapping(uint256 => mapping(uint256 => uint32))
 *   slot 4  nullifierUsed          mapping(uint256 => mapping(uint256 => bool))
 *   slot 5  records                mapping(bytes32 => Record)
 *   slot 6  verifier (offset 0, address) + verifierLocked (offset 20, bool)
 *
 * `Record` occupies five consecutive slots starting at keccak256(cidDigest . 5):
 *   +0 groupId  uint256
 *   +1 caseId   bytes32
 *   +2 root     uint256
 *   +3 nullifier uint256
 *   +4 blockNumber uint64 (offset 0, low 8 bytes) and exists bool (offset 8, the next byte)
 *
 * These constants are verified three ways: contracts/test/StorageLayout.t.sol reads the slots with
 * `vm.load` after a real `record()`; test/storageproof.test.ts checks them against `forge inspect`
 * (when forge is installed); and the opt-in live test compares them with `eth_getStorageAt` and
 * `records()` on a running anvil deployment. Adding or reordering storage variables in ZeroDrop.sol
 * moves them: those tests fail first.
 */
export const ZERODROP_SLOTS = {
  knownRoot: 2n,
  rootSize: 3n,
  records: 5n,
} as const;

/** Number of storage slots a `Record` occupies. */
export const RECORD_SLOT_COUNT = 5;

const U64_MASK = (1n << 64n) - 1n;

const word = (value: bigint | Hex): Hex => pad(typeof value === "bigint" ? toHex(value) : value, { size: 32 });

/** Slot of the first word of `records[cidDigest]`. */
export function recordBaseSlot(cidDigest: Hex): bigint {
  return hexToBigInt(keccak256(concat([word(cidDigest), word(ZERODROP_SLOTS.records)])));
}

/** The five slots of `records[cidDigest]`, in struct order. */
export function recordSlots(cidDigest: Hex): Hex[] {
  const base = recordBaseSlot(cidDigest);
  return Array.from({ length: RECORD_SLOT_COUNT }, (_, i) => word(base + BigInt(i)));
}

function nestedMappingSlot(outerSlot: bigint, groupId: bigint, root: bigint): Hex {
  const inner = keccak256(concat([word(groupId), word(outerSlot)]));
  return keccak256(concat([word(root), inner]));
}

/** Slot of `knownRoot[groupId][root]`. */
export function knownRootSlot(groupId: bigint, root: bigint): Hex {
  return nestedMappingSlot(ZERODROP_SLOTS.knownRoot, groupId, root);
}

/** Slot of `rootSize[groupId][root]`. The uint32 sits at offset 0 of its own slot. */
export function rootSizeSlot(groupId: bigint, root: bigint): Hex {
  return nestedMappingSlot(ZERODROP_SLOTS.rootSize, groupId, root);
}

export type RecordWords = {
  groupId: bigint;
  caseId: Hex;
  root: bigint;
  nullifier: bigint;
  blockNumber: bigint;
  exists: boolean;
};

/** Decodes the five 32-byte words of a `Record` (the same fields as the `records()` getter). */
export function decodeRecordWords(words: readonly bigint[]): RecordWords {
  if (words.length !== RECORD_SLOT_COUNT) throw new Error(`a Record is ${RECORD_SLOT_COUNT} words, got ${words.length}`);
  const [groupId, caseId, root, nullifier, packed] = words as [bigint, bigint, bigint, bigint, bigint];
  return {
    groupId,
    caseId: word(caseId),
    root,
    nullifier,
    blockNumber: packed & U64_MASK,
    exists: ((packed >> 64n) & 0xffn) !== 0n,
  };
}

// -------------------------------------------------------------------------------------------------
// Block header
// -------------------------------------------------------------------------------------------------

/** Header fields in RLP order. `int` fields are RLP integers, the rest are byte strings used as is. */
const HEADER_FIELDS: ReadonlyArray<{ key: string; int: boolean; optional: boolean }> = [
  { key: "parentHash", int: false, optional: false },
  { key: "sha3Uncles", int: false, optional: false },
  { key: "miner", int: false, optional: false },
  { key: "stateRoot", int: false, optional: false },
  { key: "transactionsRoot", int: false, optional: false },
  { key: "receiptsRoot", int: false, optional: false },
  { key: "logsBloom", int: false, optional: false },
  { key: "difficulty", int: true, optional: false },
  { key: "number", int: true, optional: false },
  { key: "gasLimit", int: true, optional: false },
  { key: "gasUsed", int: true, optional: false },
  { key: "timestamp", int: true, optional: false },
  { key: "extraData", int: false, optional: false },
  { key: "mixHash", int: false, optional: false },
  { key: "nonce", int: false, optional: false },
  // Appended by later forks, each only when the chain has the fork (London, Shanghai, Cancun x3, Prague).
  { key: "baseFeePerGas", int: true, optional: true },
  { key: "withdrawalsRoot", int: false, optional: true },
  { key: "blobGasUsed", int: true, optional: true },
  { key: "excessBlobGas", int: true, optional: true },
  { key: "parentBeaconBlockRoot", int: false, optional: true },
  { key: "requestsHash", int: false, optional: true },
];

/** Keys of an `eth_getBlockByNumber` result that are not part of the header. */
const NON_HEADER_KEYS = new Set([
  "hash",
  "size",
  "totalDifficulty",
  "transactions",
  "uncles",
  "withdrawals",
  "sealFields",
]);

export type HeaderDerivation = {
  /** The header was RLP-encoded from every field and its keccak256 equals the reported hash. */
  checked: boolean;
  /** keccak256 of the RLP-encoded header, when it could be built. */
  derivedHash?: Hex;
  /** Why the header could not be checked, or how it failed. */
  detail: string;
  /** Header fields the node returned that this code does not know how to encode. */
  unknownFields: string[];
};

type RawBlock = Record<string, unknown>;

const intHex = (v: string): Hex => {
  const n = BigInt(v);
  if (n === 0n) return "0x";
  const h = n.toString(16);
  return `0x${h.length % 2 ? "0" : ""}${h}`;
};

/**
 * Re-derives the block hash from the header JSON an RPC returned: RLP-encode the header fields in
 * consensus order and keccak256 them. The result is only meaningful when the node returned every
 * header field. A chain may add header fields that this list does not know. Then the derivation
 * cannot be done, `checked` is false and `unknownFields` says why (the caller falls back to
 * "block hash and state root agreed by the quorum").
 */
export function deriveBlockHash(block: RawBlock): HeaderDerivation {
  const reported = block.hash;
  const knownKeys = new Set([...HEADER_FIELDS.map((f) => f.key), ...NON_HEADER_KEYS]);
  const unknownFields = Object.keys(block).filter((k) => !knownKeys.has(k) && block[k] !== null && block[k] !== undefined);
  const items: Hex[] = [];
  let sawGap = false;
  for (const field of HEADER_FIELDS) {
    const raw = block[field.key];
    if (raw === undefined || raw === null) {
      if (!field.optional) return { checked: false, detail: `header field ${field.key} is missing`, unknownFields };
      sawGap = true;
      continue;
    }
    if (sawGap) {
      return { checked: false, detail: `header field ${field.key} present after an absent optional field`, unknownFields };
    }
    if (typeof raw !== "string" || !isHex(raw)) {
      return { checked: false, detail: `header field ${field.key} is not hex`, unknownFields };
    }
    items.push(field.int ? intHex(raw) : (raw as Hex));
  }
  const derivedHash = keccak256(toRlp(items));
  if (typeof reported !== "string" || derivedHash.toLowerCase() !== reported.toLowerCase()) {
    return {
      checked: false,
      derivedHash,
      detail:
        unknownFields.length > 0
          ? `header RLP hash differs from the reported hash; the node returned header fields this code does not encode: ${unknownFields.join(", ")}`
          : "header RLP hash differs from the reported block hash",
      unknownFields,
    };
  }
  return { checked: true, derivedHash, detail: "header RLP hashes to the reported block hash", unknownFields };
}

// -------------------------------------------------------------------------------------------------
// Proof verification (pure: no network)
// -------------------------------------------------------------------------------------------------

/** The `eth_getProof` response, as raw JSON. */
export type RawAccountProof = {
  address?: string;
  accountProof: readonly Hex[];
  balance?: Hex;
  codeHash: Hex;
  nonce?: Hex;
  storageHash: Hex;
  storageProof: ReadonlyArray<{ key: Hex; value: Hex; proof: readonly Hex[] }>;
};

export type VerifiedAccount = { storageHash: Hex; codeHash: Hex; nonce: bigint; balance: bigint };

let referenceTrie: Promise<MerklePatriciaTrie> | undefined;
/** A secure (key-hashing) trie that only supplies key hashing to `verifyMPTWithMerkleProof`. */
function secureTrie(): Promise<MerklePatriciaTrie> {
  referenceTrie ??= createMPT({ useKeyHashing: true });
  return referenceTrie;
}

const bytesOf = (h: Hex): Uint8Array => hexToBytes(h);

/**
 * Verifies the account proof of `address` against `stateRoot`. Returns the proven account fields, or
 * throws when the proof is invalid or proves the account absent. The response's own `storageHash`
 * and `codeHash` must equal the proven ones.
 */
export async function verifyAccountProof(
  stateRoot: Hex,
  address: Address,
  proof: RawAccountProof,
): Promise<VerifiedAccount> {
  const trie = await secureTrie();
  let leaf: Uint8Array | null;
  try {
    leaf = await verifyMPTWithMerkleProof(trie, bytesOf(stateRoot), bytesOf(address), proof.accountProof.map(bytesOf));
  } catch (e) {
    throw new Error(`account proof does not verify against the state root: ${(e as Error).message}`);
  }
  if (leaf === null) throw new Error("account proof proves the contract account is absent from the state");
  const fields = fromRlp(toHex(leaf), "hex") as Hex[];
  if (!Array.isArray(fields) || fields.length !== 4) throw new Error("account leaf is not a 4-item RLP list");
  const [nonce, balance, storageHash, codeHash] = fields as [Hex, Hex, Hex, Hex];
  if (storageHash.toLowerCase() !== proof.storageHash.toLowerCase()) {
    throw new Error("the response's storageHash differs from the storage root in the proven account");
  }
  if (codeHash.toLowerCase() !== proof.codeHash.toLowerCase()) {
    throw new Error("the response's codeHash differs from the code hash in the proven account");
  }
  return {
    storageHash,
    codeHash,
    nonce: nonce === "0x" ? 0n : hexToBigInt(nonce),
    balance: balance === "0x" ? 0n : hexToBigInt(balance),
  };
}

/**
 * Verifies each requested storage slot against the account's `storageHash` and returns the proven
 * 32-byte values (an absent slot is a proven zero). The response must contain exactly the requested
 * slots, in order.
 */
export async function verifyStorageProofs(
  storageHash: Hex,
  slots: readonly Hex[],
  proof: Pick<RawAccountProof, "storageProof">,
): Promise<bigint[]> {
  if (proof.storageProof.length !== slots.length) {
    throw new Error(`asked for ${slots.length} storage proofs, got ${proof.storageProof.length}`);
  }
  const trie = await secureTrie();
  const out: bigint[] = [];
  for (let i = 0; i < slots.length; i++) {
    const slot = word(slots[i]!);
    const entry = proof.storageProof[i]!;
    if (!isHex(entry.key) || hexToBigInt(entry.key) !== hexToBigInt(slot)) {
      throw new Error(`storage proof ${i} is for a different slot than requested`);
    }
    let leaf: Uint8Array | null;
    try {
      leaf = await verifyMPTWithMerkleProof(trie, bytesOf(storageHash), bytesOf(slot), entry.proof.map(bytesOf));
    } catch (e) {
      throw new Error(`storage proof ${i} does not verify against the storage root: ${(e as Error).message}`);
    }
    // The leaf holds RLP(trimmed big-endian integer). Absent means zero.
    const value = leaf === null ? 0n : bytesToUint(fromRlp(toHex(leaf), "bytes") as Uint8Array);
    if (isHex(entry.value) && entry.value !== "0x" && hexToBigInt(entry.value) !== value) {
      throw new Error(`storage proof ${i}: the response's value differs from the proven value`);
    }
    out.push(value);
  }
  return out;
}

function bytesToUint(b: Uint8Array): bigint {
  if (b.length > 32) throw new Error("storage value longer than 32 bytes");
  return b.length === 0 ? 0n : hexToBigInt(toHex(b));
}

// -------------------------------------------------------------------------------------------------
// The check
// -------------------------------------------------------------------------------------------------

export type VerifyRecordStorageProofArgs = {
  /** One client per endpoint. Each is asked for the header and `eth_getProof` itself (via `request`). */
  publicClients: readonly PublicClient[];
  zeroDropAddress: Address;
  cidDigest: Hex;
  /** Endpoints that must agree (integer >= 2), or "single-endpoint" with exactly one endpoint. */
  quorum: number | "single-endpoint";
  /**
   * Block to prove at. Default: the highest block that `quorum` endpoints report having. Nodes keep
   * proofs only for recent blocks (about 128 on a typical full node), so a very old block may fail.
   * The record is immutable once written, so any block at or after the record's block shows it.
   */
  blockNumber?: bigint;
};

export type StorageProofValues = RecordWords & {
  /** `knownRoot[groupId][root]` at the proven block. */
  knownRoot: boolean;
  /** `rootSize[groupId][root]`: the number of members the root covers, i.e. the anonymity set. */
  anonymitySet: bigint;
};

export type StorageProofResult = {
  ok: boolean;
  reason: string;
  /** Trust limits and fallbacks, in plain words. */
  notes: string[];
  verified: {
    /** The account (nonce, balance, storage root, code hash) was proven against the state root. */
    account: boolean;
    /** The storage slots were proven against the account's storage root. */
    storage: boolean;
  };
  /** The block hash was re-derived from the header RLP and equals the reported one. */
  headerChecked: boolean;
  blockNumber?: bigint;
  blockHash?: Hex;
  stateRoot?: Hex;
  /** The proven account (storage root and code hash), when the account proof verified. */
  account?: VerifiedAccount;
  /** The proven values. Present when the proofs verified, also when the record does not exist. */
  values?: StorageProofValues;
  endpoints: { total: number; agreeing: number };
};

type EndpointProof = {
  blockHash: Hex;
  stateRoot: Hex;
  headerChecked: boolean;
  headerDetail: string;
  account: VerifiedAccount;
  values: bigint[];
};

type Requester = { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> };

function requester(client: PublicClient): Requester | undefined {
  const c = client as unknown as Partial<Requester>;
  return typeof c.request === "function" ? (c as Requester) : undefined;
}

const hexQty = (n: bigint): Hex => `0x${n.toString(16)}`;

/** True when an RPC error means the node does not serve the method at all (as opposed to a bad proof). */
export function isMethodUnsupported(error: unknown): boolean {
  const e = error as { code?: number; message?: string; details?: string; cause?: { code?: number } } | undefined;
  const text = `${e?.message ?? ""} ${e?.details ?? ""}`.toLowerCase();
  return (
    e?.code === -32601 ||
    e?.code === -32004 ||
    e?.cause?.code === -32601 ||
    e?.cause?.code === -32004 ||
    /method not found|unknown method|not implemented|method .{0,40}(not supported|not available|not whitelisted|disabled|does not exist)|(not supported|not available|not whitelisted|disabled).{0,20}method/.test(text)
  );
}

/** Thrown when no endpoint could be asked for `eth_getProof` at all. Callers may fall back to plain reads. */
export class ProofUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProofUnsupportedError";
  }
}

async function proveAt(
  client: PublicClient,
  address: Address,
  slots: readonly Hex[],
  blockNumber: bigint,
): Promise<EndpointProof> {
  const rpc = requester(client);
  if (!rpc) throw new ProofUnsupportedError("client has no raw request method");
  const tag = hexQty(blockNumber);

  const block = (await rpc.request({ method: "eth_getBlockByNumber", params: [tag, false] })) as RawBlock | null;
  if (!block) throw new Error(`block ${blockNumber} not found`);
  if (typeof block.hash !== "string" || typeof block.stateRoot !== "string") {
    throw new Error("block header has no hash or stateRoot");
  }
  if (block.number !== undefined && BigInt(block.number as string) !== blockNumber) {
    throw new Error(`endpoint returned block ${BigInt(block.number as string)}, asked for ${blockNumber}`);
  }
  const header = deriveBlockHash(block);
  // A header that the node gave fully (no unknown fields) and that does not hash to its own hash is a lie.
  if (!header.checked && header.derivedHash && header.unknownFields.length === 0) {
    throw new Error(`block ${blockNumber}: ${header.detail}`);
  }

  let proof: RawAccountProof;
  try {
    proof = (await rpc.request({ method: "eth_getProof", params: [address, slots, tag] })) as RawAccountProof;
  } catch (e) {
    if (isMethodUnsupported(e)) throw new ProofUnsupportedError(`eth_getProof: ${(e as Error).message}`);
    throw e;
  }
  if (!proof || !Array.isArray(proof.accountProof) || !Array.isArray(proof.storageProof)) {
    throw new Error("eth_getProof returned a malformed response");
  }

  const stateRoot = block.stateRoot as Hex;
  const account = await verifyAccountProof(stateRoot, address, proof);
  const values = await verifyStorageProofs(account.storageHash, slots, proof);
  return {
    blockHash: block.hash as Hex,
    stateRoot,
    headerChecked: header.checked,
    headerDetail: header.detail,
    account,
    values,
  };
}

/** Highest block that at least `required` endpoints report as their head. */
async function agreedHead(clients: readonly PublicClient[], required: number): Promise<bigint> {
  const settled = await Promise.allSettled(
    clients.map(async (c) => {
      const rpc = requester(c);
      if (!rpc) throw new ProofUnsupportedError("client has no raw request method");
      return BigInt((await rpc.request({ method: "eth_blockNumber" })) as string);
    }),
  );
  const heads = settled
    .filter((s): s is PromiseFulfilledResult<bigint> => s.status === "fulfilled")
    .map((s) => s.value)
    .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  if (heads.length < required) {
    const unsupported = settled.find((s) => s.status === "rejected" && s.reason instanceof ProofUnsupportedError);
    if (unsupported && heads.length === 0) throw (unsupported as PromiseRejectedResult).reason;
    throw new Error(`only ${heads.length} of ${clients.length} endpoints reported a block number, quorum is ${required}`);
  }
  return heads[required - 1]!;
}

/**
 * Proves `ZeroDrop.records[cidDigest]` (and `knownRoot` / `rootSize` of its root) from `eth_getProof`.
 *
 * Per endpoint: fetch the block header and the proofs for one block; re-derive the block hash from
 * the header; verify the account proof against the header's stateRoot and the storage proofs against
 * the account's storageHash, locally. An endpoint whose proof does not verify, or whose header
 * contradicts its own hash, does not count. The remaining answers (block hash, state root, account,
 * values) must be identical across `quorum` endpoints.
 *
 * Trust limit. This is a header quorum, not a light client. With k >= 2 endpoints the state root is
 * trusted to the assumption that fewer than k independent RPC operators collude. With one endpoint
 * ("single-endpoint") the state root is trusted to that one RPC: the record is proven against the
 * state root it served, but that RPC could serve a state root of a block that is not on the canonical
 * chain (or an invented chain) and still produce proofs that verify. The proof rules out only an RPC
 * that lies about individual slots without presenting a consistent state. Neither mode checks
 * consensus (no sync committee or finality). Colibri or Helios would.
 *
 * Throws nothing for verification failures (they come back as `ok: false`). Rejects with
 * `ProofUnsupportedError` only when no endpoint serves `eth_getProof` / raw requests at all, so the
 * caller can fall back to plain reads and say so.
 */
export async function verifyRecordStorageProof(args: VerifyRecordStorageProofArgs): Promise<StorageProofResult> {
  const { publicClients: clients, zeroDropAddress, cidDigest, quorum } = args;
  const notes: string[] = [];
  const endpoints = (agreeing = 0) => ({ total: clients.length, agreeing });
  const fail = (reason: string, extra: Partial<StorageProofResult> = {}): StorageProofResult => ({
    ok: false,
    reason,
    notes,
    verified: { account: false, storage: false },
    headerChecked: false,
    endpoints: endpoints(),
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

  const trustNote = single
    ? "Single endpoint: the state root is trusted to this one RPC. The record is proven against the state root it served, " +
      "but that RPC could serve a state root for a block that is not on the canonical chain and the proofs would still verify. " +
      "Not a light client, no consensus check."
    : `Block hash and state root agreed by ${required} of ${clients.length} endpoints; the record is proven against that state root. ` +
      `This holds unless ${required} of them collude. Not a light client, no consensus check.`;

  // Pin one block for all proofs.
  let blockNumber: bigint;
  try {
    blockNumber = args.blockNumber ?? (await agreedHead(clients, required));
  } catch (e) {
    if (e instanceof ProofUnsupportedError) throw e;
    return fail(`block number: ${(e as Error).message}`);
  }

  const round = async (slots: readonly Hex[]) => {
    const read = await fanOutRead(clients, (c) => proveAt(c, zeroDropAddress, slots, blockNumber), {
      quorum: required,
      key: (p) =>
        JSON.stringify({
          h: p.blockHash,
          s: p.stateRoot,
          a: [p.account.storageHash, p.account.codeHash],
          v: p.values.map((v) => v.toString()),
        }),
    });
    return read;
  };

  const first = await round(recordSlots(cidDigest));
  if (!first.ok) {
    if (first.agreeing === 0 && first.errors.length > 0 && first.errors.every((m) => /^(eth_getProof:|client has no raw)/.test(m))) {
      throw new ProofUnsupportedError(first.errors[0]!);
    }
    const detail = first.errors.length > 0 ? ` (${[...new Set(first.errors)].join("; ")})` : "";
    return fail(`storage proof: ${first.reason}${detail}`, { blockNumber, endpoints: endpoints(first.agreeing) });
  }
  const p1 = first.value!;
  const record = decodeRecordWords(p1.values);
  const base: Partial<StorageProofResult> = {
    blockNumber,
    blockHash: p1.blockHash,
    stateRoot: p1.stateRoot,
    headerChecked: p1.headerChecked,
    account: p1.account,
    endpoints: endpoints(first.agreeing),
  };
  if (p1.headerChecked) {
    notes.push("The block hash was re-derived from the header RLP and equals the reported hash, so the state root belongs to that block.");
  } else {
    notes.push(
      `The block header RLP could not be re-derived (${p1.headerDetail}). The block hash and state root are agreed by the quorum ` +
        "but are not tied together locally; this check falls back to state root agreement.",
    );
  }
  notes.push(trustNote);

  if (p1.account.codeHash === "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470") {
    return fail("the address is proven to have no code (not a contract)", {
      ...base,
      verified: { account: true, storage: false },
    });
  }

  if (!record.exists) {
    return fail("no record for this cidDigest: the storage proof shows the slot empty at this block", {
      ...base,
      verified: { account: true, storage: true },
      values: { ...record, knownRoot: false, anonymitySet: 0n },
    });
  }
  if (record.blockNumber > blockNumber) {
    return fail(`proven record block ${record.blockNumber} is later than the proof block ${blockNumber}`, {
      ...base,
      verified: { account: true, storage: true },
    });
  }

  // The group root of the record: known, and how many members it covers.
  const second = await round([knownRootSlot(record.groupId, record.root), rootSizeSlot(record.groupId, record.root)]);
  if (!second.ok) {
    const detail = second.errors.length > 0 ? ` (${[...new Set(second.errors)].join("; ")})` : "";
    return fail(`storage proof of knownRoot/rootSize: ${second.reason}${detail}`, {
      ...base,
      verified: { account: true, storage: false },
    });
  }
  const p2 = second.value!;
  if (p2.blockHash !== p1.blockHash || p2.stateRoot !== p1.stateRoot) {
    return fail("the endpoints answered the second proof round for a different block", {
      ...base,
      verified: { account: true, storage: false },
    });
  }
  const [knownFlag, size] = p2.values as [bigint, bigint];
  const values: StorageProofValues = {
    ...record,
    knownRoot: (knownFlag & 0xffn) !== 0n,
    anonymitySet: size & 0xffffffffn,
  };
  if (!values.knownRoot) {
    return fail("the record's root is not a known root of its group in the proven state", {
      ...base,
      verified: { account: true, storage: true },
      values,
    });
  }

  return {
    ok: true,
    reason: `Record proven by storage proof at block ${blockNumber}, anonymity set ${values.anonymitySet}. ${single ? "Single endpoint." : `${first.agreeing} of ${clients.length} endpoints agree.`}`,
    notes,
    verified: { account: true, storage: true },
    headerChecked: p1.headerChecked,
    blockNumber,
    blockHash: p1.blockHash,
    stateRoot: p1.stateRoot,
    account: p1.account,
    values,
    endpoints: endpoints(Math.min(first.agreeing, second.agreeing)),
  };
}
