import { createMerkleProof, createMPT } from "@ethereumjs/mpt";
import { bytesToHex, hexToBytes, keccak256, toHex, toRlp, type Address, type Hex, type PublicClient } from "viem";
import { knownRootSlot, recordSlots, rootSizeSlot } from "../../src/storageproof";

/**
 * A tiny fake chain with real Merkle-Patricia tries: one ZeroDrop account whose storage holds a record,
 * some filler accounts and slots, and a block header whose hash is the keccak of its RLP. It serves
 * `eth_blockNumber`, `eth_getBlockByNumber` and `eth_getProof` through a viem-like `request`, so the
 * tests can tamper with any part of a response.
 */

const word = (n: bigint): Hex => `0x${n.toString(16).padStart(64, "0")}`;
const EMPTY_CODE_HASH = keccak256("0x");

/** RLP of a storage value: the big-endian integer without leading zeros. */
function storageLeaf(value: bigint): Uint8Array {
  const h = value.toString(16);
  return hexToBytes(toRlp(`0x${h.length % 2 ? "0" : ""}${h}`));
}

function intHex(n: bigint): Hex {
  if (n === 0n) return "0x";
  const h = n.toString(16);
  return `0x${h.length % 2 ? "0" : ""}${h}`;
}

export type FakeRecord = {
  cidDigest: Hex;
  groupId: bigint;
  caseId: Hex;
  root: bigint;
  nullifier: bigint;
  blockNumber: bigint;
  exists?: boolean;
  /** `rootSize[groupId][root]`. Default 4. */
  size?: bigint;
  /** `knownRoot[groupId][root]`. Default true. */
  known?: boolean;
};

export type ChainOptions = {
  address: Address;
  record?: FakeRecord;
  number?: bigint;
  /** Code hash of the account. Default: a non-empty value. */
  codeHash?: Hex;
  /** Extra header JSON fields (e.g. a field the code does not know). They are NOT part of the hashed header. */
  extraHeaderJson?: Record<string, unknown>;
  /** Extra RLP header items appended after the known ones (changes the real hash). */
  extraHeaderRlp?: Hex[];
};

export type FakeChain = {
  address: Address;
  number: bigint;
  stateRoot: Hex;
  storageHash: Hex;
  blockHash: Hex;
  block: Record<string, unknown>;
  getProof: (address: Address, slots: Hex[]) => Promise<Record<string, unknown>>;
};

export async function buildChain(opts: ChainOptions): Promise<FakeChain> {
  const number = opts.number ?? 50n;
  const codeHash = opts.codeHash ?? keccak256("0x600160005260206000f3");

  const storage = await createMPT({ useKeyHashing: true });
  const values = new Map<string, bigint>();
  const putSlot = async (slot: Hex, value: bigint) => {
    values.set(slot.toLowerCase(), value);
    await storage.put(hexToBytes(slot), storageLeaf(value));
  };
  // Filler slots so the trie has branches.
  for (let i = 0; i < 12; i++) await putSlot(word(BigInt(100 + i)), BigInt(i + 1));
  const r = opts.record;
  if (r) {
    const slots = recordSlots(r.cidDigest);
    const packed = (r.blockNumber & ((1n << 64n) - 1n)) | ((r.exists ?? true) ? 1n << 64n : 0n);
    const words = [r.groupId, BigInt(r.caseId), r.root, r.nullifier, packed];
    for (let i = 0; i < 5; i++) if (words[i]! !== 0n) await putSlot(slots[i]!, words[i]!);
    const size = r.size ?? 4n;
    if ((r.known ?? true)) await putSlot(knownRootSlot(r.groupId, r.root), 1n);
    if (size !== 0n) await putSlot(rootSizeSlot(r.groupId, r.root), size);
  }
  const storageHash = bytesToHex(storage.root());

  const accounts = await createMPT({ useKeyHashing: true });
  for (let i = 1; i <= 9; i++) {
    const a = `0x${i.toString(16).padStart(40, "0")}` as Hex;
    await accounts.put(hexToBytes(a), hexToBytes(toRlp([intHex(BigInt(i)), intHex(1000n), keccak256("0x1234"), EMPTY_CODE_HASH])));
  }
  await accounts.put(
    hexToBytes(opts.address),
    hexToBytes(toRlp([intHex(1n), "0x", storageHash, codeHash])),
  );
  const stateRoot = bytesToHex(accounts.root());

  const header = {
    parentHash: keccak256("0x01"),
    sha3Uncles: keccak256(toRlp([])),
    miner: `0x${"00".repeat(20)}`,
    stateRoot,
    transactionsRoot: keccak256("0x02"),
    receiptsRoot: keccak256("0x03"),
    logsBloom: `0x${"00".repeat(256)}`,
    difficulty: "0x0",
    number: toHex(number),
    gasLimit: "0x1c9c380",
    gasUsed: "0x5208",
    timestamp: "0x6540f000",
    extraData: "0x",
    mixHash: keccak256("0x04"),
    nonce: "0x0000000000000000",
    baseFeePerGas: "0x3b9aca00",
    withdrawalsRoot: keccak256("0x05"),
    blobGasUsed: "0x0",
    excessBlobGas: "0x0",
    parentBeaconBlockRoot: keccak256("0x06"),
    requestsHash: keccak256("0x07"),
  };
  const items: Hex[] = [
    header.parentHash,
    header.sha3Uncles,
    header.miner as Hex,
    header.stateRoot,
    header.transactionsRoot,
    header.receiptsRoot,
    header.logsBloom as Hex,
    intHex(0n),
    intHex(number),
    intHex(BigInt(header.gasLimit)),
    intHex(BigInt(header.gasUsed)),
    intHex(BigInt(header.timestamp)),
    "0x",
    header.mixHash,
    header.nonce as Hex,
    intHex(BigInt(header.baseFeePerGas)),
    header.withdrawalsRoot,
    intHex(0n),
    intHex(0n),
    header.parentBeaconBlockRoot,
    header.requestsHash,
    ...(opts.extraHeaderRlp ?? []),
  ];
  const blockHash = keccak256(toRlp(items));
  const block = {
    ...header,
    ...(opts.extraHeaderJson ?? {}),
    hash: blockHash,
    size: "0x400",
    totalDifficulty: "0x0",
    transactions: [],
    uncles: [],
    withdrawals: [],
  };

  const getProof = async (address: Address, slots: Hex[]) => {
    const accountProof = (await createMerkleProof(accounts, hexToBytes(address))).map((n) => bytesToHex(n));
    const storageProof = [];
    for (const slot of slots) {
      const proof = (await createMerkleProof(storage, hexToBytes(slot))).map((n) => bytesToHex(n));
      const value = toHex(values.get(slot.toLowerCase()) ?? 0n);
      storageProof.push({ key: slot, value, proof });
    }
    return {
      address,
      accountProof,
      balance: "0x0",
      codeHash,
      nonce: "0x1",
      storageHash,
      storageProof,
    };
  };

  return { address: opts.address, number, stateRoot, storageHash, blockHash, block, getProof };
}

export type Tamper = {
  /** Called with the raw `eth_getProof` response before it is returned. */
  proof?: (p: any) => any;
  /** Called with the raw block JSON before it is returned. */
  block?: (b: any) => any;
  head?: bigint;
  /** Make the method unsupported. */
  noProof?: boolean;
  down?: boolean;
};

/** A viem-like client that serves the chain. Only `request` exists, which is all the proof code uses. */
export function fakeProofClient(chain: FakeChain, tamper: Tamper = {}): PublicClient {
  const request = async ({ method, params = [] }: { method: string; params?: unknown[] }) => {
    if (tamper.down) throw new Error("HTTP 502");
    if (method === "eth_blockNumber") return toHex(tamper.head ?? chain.number);
    if (method === "eth_getBlockByNumber") {
      const b = structuredClone(chain.block);
      return tamper.block ? tamper.block(b) : b;
    }
    if (method === "eth_getProof") {
      if (tamper.noProof) {
        const e = new Error("the method eth_getProof does not exist/is not available") as Error & { code: number };
        e.code = -32601;
        throw e;
      }
      const [address, slots] = params as [Address, Hex[]];
      const p = await chain.getProof(address, slots);
      return tamper.proof ? tamper.proof(p) : p;
    }
    throw new Error(`unexpected method ${method}`);
  };
  return { request } as unknown as PublicClient;
}

/** Flips one bit in the middle of a node. */
export function flipNode(nodes: string[], index = nodes.length - 1): string[] {
  const out = [...nodes];
  const hex = out[index]!;
  const pos = 2 + Math.floor((hex.length - 2) / 2 / 2) * 2;
  const byte = parseInt(hex.slice(pos, pos + 2), 16) ^ 0x01;
  out[index] = hex.slice(0, pos) + byte.toString(16).padStart(2, "0") + hex.slice(pos + 2);
  return out;
}
