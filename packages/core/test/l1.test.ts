import { describe, expect, it } from "vitest";
import type { Hex, PublicClient } from "viem";
import { verifyInclusion, type VerifyInclusionArgs } from "../src/l1";
import { buildChain, fakeProofClient, flipNode, type Tamper } from "./helpers/proofchain";

const ZERODROP = "0x00000000000000000000000000000000000000cd" as const;
const CID = `0x${"ab".repeat(32)}` as Hex;
const CASE = `0x${"11".repeat(32)}` as Hex;
const HASH_A = `0x${"aa".repeat(32)}` as Hex;
const HASH_B = `0x${"bb".repeat(32)}` as Hex;

type Answers = {
  record?: readonly unknown[] | Error;
  logs?: unknown[] | Error;
  blockHash?: Hex | Error;
  chainId?: number;
  /** When true, every read on this endpoint fails. */
  down?: boolean;
};

/** A fake viem client that answers the three L1 reads from fixed values. */
function fakeClient(answers: Answers = {}): PublicClient {
  const record = answers.record ?? [1n, CASE, 42n, 7n, 100n, true];
  const logs = answers.logs ?? [
    {
      blockHash: HASH_A,
      transactionHash: `0x${"cc".repeat(32)}`,
      logIndex: 0,
      args: { cidDigest: CID, groupId: 1n, caseId: CASE, root: 42n, nullifier: 7n, depth: 20n, proof: "0x1234" },
    },
  ];
  const hash = answers.blockHash ?? HASH_A;
  const fail = (x: unknown) => {
    if (x instanceof Error) throw x;
    return x;
  };
  const down = () => {
    if (answers.down) throw new Error("HTTP 502");
  };
  return {
    readContract: async () => (down(), fail(record)),
    getContractEvents: async () => (down(), fail(logs)),
    getBlock: async () => {
      down();
      const h = fail(hash) as Hex;
      return { hash: h };
    },
    getChainId: async () => (down(), answers.chainId ?? 31337),
  } as unknown as PublicClient;
}

function args(overrides: Partial<VerifyInclusionArgs>): VerifyInclusionArgs {
  return {
    publicClients: [fakeClient(), fakeClient()],
    zeroDropAddress: ZERODROP,
    cidDigest: CID,
    quorum: 2,
    ...overrides,
  };
}

describe("verifyInclusion with two endpoints", () => {
  it("is ok when both endpoints agree, and states what is not verified", async () => {
    const result = await verifyInclusion(args({}));
    expect(result.ok).toBe(true);
    expect(result).toMatchObject({
      groupId: 1n,
      caseId: CASE,
      root: 42n,
      nullifier: 7n,
      depth: 20n,
      blockNumber: 100n,
      blockHash: HASH_A,
      agreeingEndpoints: 2,
    });
    expect(result.storageProofVerified).toBe(false);
    expect(result.notes.join(" ")).toMatch(/Storage proof NOT verified: the endpoints do not serve eth_getProof/);
  });

  it("is not ok when the endpoints disagree on the block hash", async () => {
    const result = await verifyInclusion(args({ publicClients: [fakeClient(), fakeClient({ blockHash: HASH_B })] }));
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/block hash: no agreement/);
    expect(result.blockHash).toBeUndefined();
  });

  it("is not ok when the endpoints disagree on the record", async () => {
    const result = await verifyInclusion(
      args({ publicClients: [fakeClient(), fakeClient({ record: [1n, CASE, 99n, 7n, 100n, true] })] }),
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/^records: no agreement/);
  });

  it("is not ok when the endpoints disagree on the Disclosed log", async () => {
    const other = [
      {
        blockHash: HASH_A,
        transactionHash: `0x${"dd".repeat(32)}`,
        logIndex: 3,
        args: { cidDigest: CID, groupId: 1n, caseId: CASE, root: 42n, nullifier: 7n, depth: 20n, proof: "0x" },
      },
    ];
    const result = await verifyInclusion(args({ publicClients: [fakeClient(), fakeClient({ logs: other })] }));
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/Disclosed logs: no agreement/);
  });

  it("is not ok when one endpoint fails and the quorum needs it", async () => {
    const result = await verifyInclusion(
      args({ publicClients: [fakeClient(), fakeClient({ record: new Error("HTTP 502") })] }),
    );
    expect(result.ok).toBe(false);
  });

  it("is ok with three endpoints when two agree and one is down", async () => {
    const result = await verifyInclusion(
      args({
        publicClients: [fakeClient(), fakeClient({ down: true }), fakeClient()],
        quorum: 2,
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.agreeingEndpoints).toBe(2);
  });

  it("is not ok when the record root differs from expectedRoot", async () => {
    const result = await verifyInclusion(args({ expectedRoot: 43n }));
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/differs from expectedRoot/);
  });

  it("is not ok when the record does not exist", async () => {
    const result = await verifyInclusion(args({ publicClients: [fakeClient({ record: [0n, `0x${"00".repeat(32)}`, 0n, 0n, 0n, false] }), fakeClient({ record: [0n, `0x${"00".repeat(32)}`, 0n, 0n, 0n, false] })] }));
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/no record/);
  });

  it("is not ok when there is no single Disclosed log", async () => {
    const result = await verifyInclusion(args({ publicClients: [fakeClient({ logs: [] }), fakeClient({ logs: [] })] }));
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/expected exactly one Disclosed log/);
  });

  it("is not ok when the log's block hash differs from the agreed block hash", async () => {
    const wrong = [
      {
        blockHash: HASH_B,
        transactionHash: `0x${"cc".repeat(32)}`,
        logIndex: 0,
        args: { cidDigest: CID, groupId: 1n, caseId: CASE, root: 42n, nullifier: 7n, depth: 20n, proof: "0x" },
      },
    ];
    const result = await verifyInclusion(args({ publicClients: [fakeClient({ logs: wrong }), fakeClient({ logs: wrong })] }));
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/log's block hash differs/);
  });

  it("is not ok when an endpoint reports the wrong chain id", async () => {
    const result = await verifyInclusion(
      args({ expectedChainId: 31337, publicClients: [fakeClient(), fakeClient({ chainId: 1 })] }),
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/chain id/);
  });
});

describe("verifyInclusion quorum configuration", () => {
  it("a single endpoint without the explicit flag is not ok", async () => {
    const result = await verifyInclusion(args({ publicClients: [fakeClient()], quorum: 2 }));
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/quorum 2 exceeds the 1 configured endpoint/);
  });

  it("a single endpoint with quorum 'single-endpoint' is ok and states the trust limit", async () => {
    const result = await verifyInclusion(args({ publicClients: [fakeClient()], quorum: "single-endpoint" }));
    expect(result.ok).toBe(true);
    expect(result.reason).toMatch(/Single endpoint: the answer is trusted to one RPC/);
    expect(result.agreeingEndpoints).toBe(1);
  });

  it("'single-endpoint' with several endpoints is refused", async () => {
    const result = await verifyInclusion(args({ quorum: "single-endpoint" }));
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/requires exactly one endpoint/);
  });

  it("a quorum of 1 with several endpoints is refused", async () => {
    const result = await verifyInclusion(args({ quorum: 1 }));
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/integer >= 2/);
  });

  it("no endpoints is refused", async () => {
    const result = await verifyInclusion(args({ publicClients: [] }));
    expect(result.ok).toBe(false);
  });
});

describe("verifyInclusion with a storage proof", () => {
  const RECORD = { cidDigest: CID, groupId: 1n, caseId: CASE, root: 42n, nullifier: 7n, blockNumber: 100n, size: 4n };

  /** The plain-read answers of fakeClient plus a raw `request` serving a real proof chain. */
  async function proofClients(n: number, tampers: Tamper[] = [], recordOverride: Partial<typeof RECORD> = {}) {
    const chain = await buildChain({ address: ZERODROP, record: { ...RECORD, ...recordOverride }, number: 120n });
    return Array.from({ length: n }, (_, i) => {
      const plain = fakeClient() as unknown as Record<string, unknown>;
      const proof = fakeProofClient(chain, tampers[i] ?? {}) as unknown as Record<string, unknown>;
      return { ...plain, request: proof.request } as unknown as PublicClient;
    });
  }

  it("verifies the record by storage proof with a quorum, and reports the anonymity set", async () => {
    const result = await verifyInclusion(args({ publicClients: await proofClients(2) }));
    expect(result.ok).toBe(true);
    expect(result.storageProofVerified).toBe(true);
    expect(result.anonymitySet).toBe(4n);
    expect(result.storageProof?.headerChecked).toBe(true);
    expect(result.reason).toMatch(/proven by storage proof against the quorum state root/);
    expect(result.reason).not.toMatch(/Storage proof NOT verified/);
  });

  it("single endpoint with a proof states the exact trust limit", async () => {
    const result = await verifyInclusion(args({ publicClients: await proofClients(1), quorum: "single-endpoint" }));
    expect(result.ok).toBe(true);
    expect(result.storageProofVerified).toBe(true);
    expect(result.reason).toMatch(/state root that one RPC served; that state root is trusted to it/);
    expect(result.notes.join(" ")).toMatch(/not on the canonical chain/);
  });

  it("is not ok when a storage proof is tampered with", async () => {
    const tamper: Tamper = { proof: (p) => ((p.storageProof[0].proof = flipNode(p.storageProof[0].proof)), p) };
    const result = await verifyInclusion(args({ publicClients: await proofClients(1, [tamper]), quorum: "single-endpoint" }));
    expect(result.ok).toBe(false);
    expect(result.storageProofVerified).toBe(false);
    expect(result.reason).toMatch(/^storage proof:/);
  });

  it("is not ok when the proven storage differs from the records() getter", async () => {
    const result = await verifyInclusion(args({ publicClients: await proofClients(2, [], { nullifier: 8n }) }));
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/proven storage differs from what the records\(\) getter returned/);
  });

  it("falls back to the plain reads and says so when eth_getProof is not served", async () => {
    const result = await verifyInclusion(args({ publicClients: await proofClients(2, [{ noProof: true }, { noProof: true }]) }));
    expect(result.ok).toBe(true);
    expect(result.storageProofVerified).toBe(false);
    expect(result.notes.join(" ")).toMatch(/Storage proof NOT verified: the endpoints do not serve eth_getProof/);
    expect(result.reason).toMatch(/Storage proof NOT verified/);
  });

  it("storageProof: true makes a missing eth_getProof a failure", async () => {
    const result = await verifyInclusion(
      args({ publicClients: await proofClients(2, [{ noProof: true }, { noProof: true }]), storageProof: true }),
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/storage proof required but unavailable/);
  });

  it("storageProof: false skips the proof and says so", async () => {
    const result = await verifyInclusion(args({ publicClients: await proofClients(2), storageProof: false }));
    expect(result.ok).toBe(true);
    expect(result.storageProofVerified).toBe(false);
    expect(result.notes.join(" ")).toMatch(/skipped by the caller/);
  });
});
