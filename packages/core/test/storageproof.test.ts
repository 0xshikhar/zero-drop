import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, encodeAbiParameters, http, keccak256, parseAbi, toHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createWalletClient } from "viem";
import { describe, expect, it } from "vitest";
import {
  ProofUnsupportedError,
  ZERODROP_SLOTS,
  decodeRecordWords,
  deriveBlockHash,
  knownRootSlot,
  recordBaseSlot,
  recordSlots,
  rootSizeSlot,
  verifyRecordStorageProof,
} from "../src/storageproof";
import { buildChain, fakeProofClient, flipNode, type FakeChain } from "./helpers/proofchain";

const ZD = "0x00000000000000000000000000000000000000cd" as Address;
const CID = `0x${"ab".repeat(32)}` as Hex;
const CASE = `0x${"11".repeat(32)}` as Hex;
const RECORD = { cidDigest: CID, groupId: 1n, caseId: CASE, root: 42n, nullifier: 7n, blockNumber: 12n, size: 4n };

async function chain(overrides: Parameters<typeof buildChain>[0] extends infer _ ? Partial<Parameters<typeof buildChain>[0]> : never = {}) {
  return buildChain({ address: ZD, record: RECORD, ...overrides });
}

const run = (clients: ReturnType<typeof fakeProofClient>[], quorum: number | "single-endpoint" = 2) =>
  verifyRecordStorageProof({ publicClients: clients, zeroDropAddress: ZD, cidDigest: CID, quorum });

describe("storage slot derivation", () => {
  it("matches an independent ABI-encoding of the mapping formula", () => {
    const base = BigInt(keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [CID, 5n])));
    expect(recordBaseSlot(CID)).toBe(base);
    expect(recordSlots(CID).map(BigInt)).toEqual([0n, 1n, 2n, 3n, 4n].map((i) => base + i));

    const innerK = keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [3n, 2n]));
    expect(knownRootSlot(3n, 99n)).toBe(keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "bytes32" }], [99n, innerK])));
    const innerS = keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [3n, 3n]));
    expect(rootSizeSlot(3n, 99n)).toBe(keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "bytes32" }], [99n, innerS])));
  });

  it("decodes the packed blockNumber and exists word", () => {
    const r = decodeRecordWords([1n, BigInt(CASE), 42n, 7n, 12n | (1n << 64n)]);
    expect(r).toEqual({ groupId: 1n, caseId: CASE, root: 42n, nullifier: 7n, blockNumber: 12n, exists: true });
    expect(decodeRecordWords([0n, 0n, 0n, 0n, 0n]).exists).toBe(false);
  });

  const forgeLayout = (() => {
    try {
      const cwd = resolve(dirname(fileURLToPath(import.meta.url)), "../../../contracts");
      // Fresh out/cache dirs: a plain `forge inspect` fails ("storage layout missing") after a normal `forge build`,
      // and building into contracts/out here could race with other forge runs.
      const tmp = mkdtempSync(join(tmpdir(), "zd-forge-"));
      const out = execFileSync(
        "forge",
        ["inspect", "ZeroDrop", "storage-layout", "--json", "--force", "--out", join(tmp, "out"), "--cache-path", join(tmp, "cache")],
        {
          cwd,
          encoding: "utf8",
          timeout: 120_000,
          stdio: ["ignore", "pipe", "ignore"],
        },
      );
      rmSync(tmp, { recursive: true, force: true });
      return JSON.parse(out) as { storage: { slot: string; offset: number; label: string }[] };
    } catch {
      return undefined;
    }
  })();

  it.skipIf(!forgeLayout)("ZERODROP_SLOTS equal the compiler's storage layout (forge inspect)", () => {
    const slotOf = (label: string) => BigInt(forgeLayout!.storage.find((s) => s.label === label)!.slot);
    expect(ZERODROP_SLOTS.knownRoot).toBe(slotOf("knownRoot"));
    expect(ZERODROP_SLOTS.rootSize).toBe(slotOf("rootSize"));
    expect(ZERODROP_SLOTS.records).toBe(slotOf("records"));
  });
});

describe("deriveBlockHash", () => {
  it("re-derives the hash from the header", async () => {
    const c = await chain();
    expect(deriveBlockHash(c.block)).toMatchObject({ checked: true, derivedHash: c.blockHash });
  });

  it("does not check a header with a field it cannot encode, and says which", async () => {
    const c = await chain({ extraHeaderRlp: ["0x1234"], extraHeaderJson: { blockAccessListHash: keccak256("0x09") } });
    const d = deriveBlockHash(c.block);
    expect(d.checked).toBe(false);
    expect(d.unknownFields).toEqual(["blockAccessListHash"]);
    expect(d.detail).toMatch(/blockAccessListHash/);
  });
});

describe("verifyRecordStorageProof", () => {
  it("verifies account and storage proofs and decodes the record (single endpoint)", async () => {
    const c = await chain();
    const r = await run([fakeProofClient(c)], "single-endpoint");
    expect(r.ok).toBe(true);
    expect(r.verified).toEqual({ account: true, storage: true });
    expect(r.headerChecked).toBe(true);
    expect(r.blockNumber).toBe(50n);
    expect(r.blockHash).toBe(c.blockHash);
    expect(r.stateRoot).toBe(c.stateRoot);
    expect(r.values).toMatchObject({
      groupId: 1n,
      caseId: CASE,
      root: 42n,
      nullifier: 7n,
      blockNumber: 12n,
      exists: true,
      knownRoot: true,
      anonymitySet: 4n,
    });
    expect(r.endpoints).toEqual({ total: 1, agreeing: 1 });
    expect(r.notes.join(" ")).toMatch(/Single endpoint: the state root is trusted to this one RPC/);
    expect(r.notes.join(" ")).toMatch(/not on the canonical chain/);
  });

  it("verifies with a quorum of two and states the collusion limit", async () => {
    const c = await chain();
    const r = await run([fakeProofClient(c), fakeProofClient(c)], 2);
    expect(r.ok).toBe(true);
    expect(r.endpoints).toEqual({ total: 2, agreeing: 2 });
    expect(r.notes.join(" ")).toMatch(/agreed by 2 of 2 endpoints/);
  });

  it("proves absence of a record and reports no record", async () => {
    const c = await buildChain({ address: ZD });
    const r = await run([fakeProofClient(c)], "single-endpoint");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/no record/);
    expect(r.verified).toEqual({ account: true, storage: true });
    expect(r.values?.exists).toBe(false);
  });

  it("fails when the root is not a known root in the proven state", async () => {
    const c = await chain({ record: { ...RECORD, known: false } });
    const r = await run([fakeProofClient(c)], "single-endpoint");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/not a known root/);
  });

  it("reports an anonymity set of the proven rootSize", async () => {
    const c = await chain({ record: { ...RECORD, size: 11n } });
    const r = await run([fakeProofClient(c)], "single-endpoint");
    expect(r.values?.anonymitySet).toBe(11n);
  });

  describe("forged or tampered proofs fail", () => {
    it("a tampered storage proof node", async () => {
      const c = await chain();
      const r = await run(
        [fakeProofClient(c, { proof: (p) => ((p.storageProof[0].proof = flipNode(p.storageProof[0].proof)), p) })],
        "single-endpoint",
      );
      expect(r.ok).toBe(false);
      expect(r.verified.storage).toBe(false);
      expect(r.reason).toMatch(/storage proof/);
    });

    it("a tampered account proof node", async () => {
      const c = await chain();
      const r = await run(
        [fakeProofClient(c, { proof: (p) => ((p.accountProof = flipNode(p.accountProof)), p) })],
        "single-endpoint",
      );
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/account proof does not verify/);
    });

    it("a tampered root node (the hash of the first node no longer equals the state root)", async () => {
      const c = await chain();
      const r = await run(
        [fakeProofClient(c, { proof: (p) => ((p.accountProof = flipNode(p.accountProof, 0)), p) })],
        "single-endpoint",
      );
      expect(r.ok).toBe(false);
    });

    it("a stateRoot in the header that does not belong to the account trie", async () => {
      const c = await chain();
      const other = await chain({ codeHash: keccak256("0x99") });
      expect(other.stateRoot).not.toBe(c.stateRoot);
      // Header claims the other chain's state root (and hashes consistently), but the proof is for c.
      const r = await run(
        [fakeProofClient(c, { block: () => structuredClone(other.block) })],
        "single-endpoint",
      );
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/account proof does not verify against the state root/);
    });

    it("a proof for a different slot than requested", async () => {
      const c = await chain();
      const r = await run(
        [
          fakeProofClient(c, {
            proof: async (p) => {
              const other = await c.getProof(ZD, recordSlots(`0x${"cd".repeat(32)}`));
              p.storageProof = other.storageProof as any;
              return p;
            },
          }),
        ],
        "single-endpoint",
      );
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/different slot/);
    });

    it("a valid proof of a different slot's nodes presented under the requested key", async () => {
      const c = await chain();
      const r = await run(
        [
          fakeProofClient(c, {
            proof: async (p) => {
              const other = (await c.getProof(ZD, recordSlots(`0x${"cd".repeat(32)}`))).storageProof as any[];
              p.storageProof = p.storageProof.map((sp: any, i: number) => ({ ...sp, proof: other[i].proof }));
              return p;
            },
          }),
        ],
        "single-endpoint",
      );
      expect(r.ok).toBe(false);
    });

    it("a lying value next to a valid proof", async () => {
      const c = await chain();
      const r = await run(
        [fakeProofClient(c, { proof: (p) => ((p.storageProof[2].value = "0x2b"), p) })],
        "single-endpoint",
      );
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/differs from the proven value/);
    });

    it("a storageHash that differs from the proven account", async () => {
      const c = await chain();
      const r = await run(
        [fakeProofClient(c, { proof: (p) => ((p.storageHash = keccak256("0x77")), p) })],
        "single-endpoint",
      );
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/storageHash differs/);
    });

    it("a block hash that is not the hash of the header", async () => {
      const c = await chain();
      const r = await run(
        [fakeProofClient(c, { block: (b) => ((b.hash = keccak256("0x1")), b) })],
        "single-endpoint",
      );
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/header RLP hash differs/);
    });

    it("a header whose fields were changed after hashing (state root swapped)", async () => {
      const c = await chain();
      const r = await run(
        [fakeProofClient(c, { block: (b) => ((b.stateRoot = keccak256("0x1")), b) })],
        "single-endpoint",
      );
      expect(r.ok).toBe(false);
    });

    it("an account that is not a contract", async () => {
      const c = await chain({ codeHash: keccak256("0x") });
      const r = await run([fakeProofClient(c)], "single-endpoint");
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/no code/);
    });

    it("an address with no account at all", async () => {
      const c = await chain();
      const r = await verifyRecordStorageProof({
        publicClients: [fakeProofClient(c)],
        zeroDropAddress: "0x00000000000000000000000000000000000000ee",
        cidDigest: CID,
        quorum: "single-endpoint",
      });
      expect(r.ok).toBe(false);
    });
  });

  describe("quorum", () => {
    it("one honest endpoint against one that serves a whole fabricated chain: no agreement", async () => {
      const honest = await chain();
      const fake = await chain({ record: { ...RECORD, nullifier: 8n } });
      const r = await run([fakeProofClient(honest), fakeProofClient(fake)], 2);
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/no agreement/);
    });

    it("single endpoint serving a fabricated but self-consistent chain passes: that is the stated trust limit", async () => {
      const fake = await chain({ record: { ...RECORD, nullifier: 8n } });
      const r = await run([fakeProofClient(fake)], "single-endpoint");
      expect(r.ok).toBe(true);
      expect(r.notes.join(" ")).toMatch(/could serve a state root for a block that is not on the canonical chain/);
    });

    it("two of three agree while the third serves a tampered proof", async () => {
      const c = await chain();
      const bad = fakeProofClient(c, { proof: (p) => ((p.storageProof[1].proof = flipNode(p.storageProof[1].proof)), p) });
      const r = await run([fakeProofClient(c), bad, fakeProofClient(c)], 2);
      expect(r.ok).toBe(true);
      expect(r.endpoints).toEqual({ total: 3, agreeing: 2 });
    });

    it("endpoints at different heads prove at the highest block that a quorum has", async () => {
      const c = await chain({ number: 50n });
      const r = await run(
        [fakeProofClient(c, { head: 55n }), fakeProofClient(c, { head: 50n }), fakeProofClient(c, { head: 3n })],
        2,
      );
      expect(r.blockNumber).toBe(50n);
      expect(r.ok).toBe(true);
    });

    it("rejects quorum configurations like verifyInclusion does", async () => {
      const c = await chain();
      expect((await run([fakeProofClient(c)], 2)).reason).toMatch(/exceeds/);
      expect((await run([fakeProofClient(c), fakeProofClient(c)], "single-endpoint")).reason).toMatch(/requires exactly one/);
      expect((await run([fakeProofClient(c), fakeProofClient(c)], 1)).reason).toMatch(/integer >= 2/);
      expect((await run([], 2)).ok).toBe(false);
    });
  });

  describe("header fallback", () => {
    it("falls back to state root agreement when the header has fields it cannot encode, and says so", async () => {
      const c = await chain({ extraHeaderRlp: ["0x1234"], extraHeaderJson: { blockAccessListHash: keccak256("0x09") } });
      const r = await run([fakeProofClient(c), fakeProofClient(c)], 2);
      expect(r.ok).toBe(true);
      expect(r.headerChecked).toBe(false);
      expect(r.notes.join(" ")).toMatch(/header RLP could not be re-derived.*blockAccessListHash/s);
      expect(r.notes.join(" ")).toMatch(/falls back to state root agreement/);
    });
  });

  describe("unsupported endpoints", () => {
    it("rejects with ProofUnsupportedError when eth_getProof is not served", async () => {
      const c = await chain();
      await expect(run([fakeProofClient(c, { noProof: true })], "single-endpoint")).rejects.toBeInstanceOf(
        ProofUnsupportedError,
      );
    });

    it("rejects with ProofUnsupportedError for clients without raw requests", async () => {
      await expect(run([{} as any], "single-endpoint")).rejects.toBeInstanceOf(ProofUnsupportedError);
    });

    it("a down endpoint is a failure, not an unsupported method", async () => {
      const c = await chain();
      const r = await run([fakeProofClient(c, { down: true })], "single-endpoint");
      expect(r.ok).toBe(false);
    });
  });
});

// ------------------------------------------------------------------------------------------------------
// Live check against a running anvil (opt-in): ZD_ANVIL=http://127.0.0.1:8545 pnpm --filter @zerodrop/core test
// ------------------------------------------------------------------------------------------------------

const ANVIL = process.env.ZD_ANVIL;
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const ANVIL_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;

const ZD_ABI = parseAbi([
  "function records(bytes32) view returns (uint256 groupId, bytes32 caseId, uint256 root, uint256 nullifier, uint64 blockNumber, bool exists)",
  "function groups(uint256) view returns (address issuer, uint32 size, uint32 minSize, uint256 root)",
  "function knownRoot(uint256, uint256) view returns (bool)",
  "function rootSize(uint256, uint256) view returns (uint32)",
  "function record(uint256 groupId, bytes32 caseId, bytes32 cidDigest, uint256 root, uint256 nullifier, uint256 depth, bytes proof)",
]);

describe.skipIf(!ANVIL)("live: anvil deployment (config/local-mock.json)", () => {
  const config = existsSync(resolve(repo, "config/local-mock.json"))
    ? (JSON.parse(readFileSync(resolve(repo, "config/local-mock.json"), "utf8")) as { contracts: { zeroDrop: Address } })
    : undefined;
  const zeroDrop = config?.contracts.zeroDrop as Address;
  const client = createPublicClient({ transport: http(ANVIL ?? "http://127.0.0.1:8545") });
  // Unique per run: records are write-once, so each run uses a fresh digest and nullifier.
  const salt = BigInt(Date.now());
  const cid = keccak256(toHex(`zerodrop-live-storageproof-${salt}`));

  async function ensureRecord() {
    const existing = await client.readContract({ address: zeroDrop, abi: ZD_ABI, functionName: "records", args: [cid] });
    if (existing[5]) return;
    const wallet = createWalletClient({ account: privateKeyToAccount(ANVIL_KEY), transport: http(ANVIL ?? "http://127.0.0.1:8545") });
    const groupId = 1n;
    const group = await client.readContract({ address: zeroDrop, abi: ZD_ABI, functionName: "groups", args: [groupId] });
    const root = group[3];
    const caseId = keccak256(toHex("zerodrop-live-storageproof-case"));
    // MockVerifier ignores the proof; any 256 bytes do. Unique nullifier per run.
    const hash = await wallet.writeContract({
      chain: null,
      address: zeroDrop,
      abi: ZD_ABI,
      functionName: "record",
      args: [groupId, caseId, cid, root, salt, 2n, `0x${"00".repeat(256)}`],
    });
    await client.waitForTransactionReceipt({ hash });
  }

  it("proves a real record against anvil's state root, with the real block hash re-derived from the header", async () => {
    expect(zeroDrop).toBeTruthy();
    await ensureRecord();
    const onchain = await client.readContract({ address: zeroDrop, abi: ZD_ABI, functionName: "records", args: [cid] });

    const result = await verifyRecordStorageProof({
      publicClients: [client],
      zeroDropAddress: zeroDrop,
      cidDigest: cid,
      quorum: "single-endpoint",
    });
    expect(result.reason).toMatch(/proven/);
    expect(result.ok).toBe(true);
    expect(result.verified).toEqual({ account: true, storage: true });
    expect(result.headerChecked).toBe(true);
    expect(result.values).toMatchObject({
      groupId: onchain[0],
      caseId: onchain[1],
      root: onchain[2],
      nullifier: onchain[3],
      blockNumber: onchain[4],
      exists: true,
      knownRoot: true,
    });
    const size = await client.readContract({ address: zeroDrop, abi: ZD_ABI, functionName: "rootSize", args: [onchain[0], onchain[2]] });
    expect(result.values?.anonymitySet).toBe(BigInt(size));
    const block = await client.getBlock({ blockNumber: result.blockNumber! });
    expect(result.blockHash).toBe(block.hash);
    expect(result.stateRoot).toBe(block.stateRoot);
  });

  it("the hard-coded slots match eth_getStorageAt and the getters", async () => {
    await ensureRecord();
    const onchain = await client.readContract({ address: zeroDrop, abi: ZD_ABI, functionName: "records", args: [cid] });
    const slots = recordSlots(cid);
    const raw = await Promise.all(slots.map((slot) => client.getStorageAt({ address: zeroDrop, slot })));
    const decoded = decodeRecordWords(raw.map((w) => BigInt(w ?? "0x0")));
    expect(decoded).toEqual({
      groupId: onchain[0],
      caseId: onchain[1],
      root: onchain[2],
      nullifier: onchain[3],
      blockNumber: onchain[4],
      exists: onchain[5],
    });
    const known = await client.getStorageAt({ address: zeroDrop, slot: knownRootSlot(onchain[0], onchain[2]) });
    const size = await client.getStorageAt({ address: zeroDrop, slot: rootSizeSlot(onchain[0], onchain[2]) });
    expect(BigInt(known ?? "0x0")).toBe(1n);
    expect(BigInt(size ?? "0x0")).toBe(
      BigInt(await client.readContract({ address: zeroDrop, abi: ZD_ABI, functionName: "rootSize", args: [onchain[0], onchain[2]] })),
    );
  });

  it("a record that does not exist is proven absent", async () => {
    const result = await verifyRecordStorageProof({
      publicClients: [client],
      zeroDropAddress: zeroDrop,
      cidDigest: keccak256(toHex(`never-recorded-${salt}`)),
      quorum: "single-endpoint",
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/no record/);
    expect(result.verified.storage).toBe(true);
  });

  it("a forged value fails against the live proof", async () => {
    await ensureRecord();
    // An endpoint that relays anvil's answers but flips one byte of a storage proof node.
    const base = client as unknown as { request: (a: unknown) => Promise<any> };
    const liar = {
      request: async (a: { method: string }) => {
        const out = await base.request(a);
        if (a.method === "eth_getProof") out.storageProof[0].proof = flipNode(out.storageProof[0].proof);
        return out;
      },
    } as any;
    const result = await verifyRecordStorageProof({
      publicClients: [liar],
      zeroDropAddress: zeroDrop,
      cidDigest: cid,
      quorum: "single-endpoint",
    });
    expect(result.ok).toBe(false);
  });
});

// Keeps the helper type referenced for editors.
export type { FakeChain };
