/**
 * Offline tests for the frame-transaction builder. They do not reach the devnet, which is NOT verified
 * from this machine (TLS "certificate is not yet valid"). These tests check encoding, shape and the
 * on-chain rules that the builder enforces up front.
 */
import { describe, expect, it } from "vitest";
import { decodeFunctionData, parseAbi, toFunctionSelector, type Address, type Hex } from "viem";
import { decodeTx, encodeTx } from "@forshtat/hegota-support/tx";
import { toWire } from "@forshtat/hegota-support/rpc";
import {
  DISCLOSURE_PROFILE,
  MIN_SENDER_EXECUTION_GAS,
  RECORD_SIGNATURE,
  buildDisclosureFrameTx,
  buildDisclosureFrames,
  recordSelector,
  simulateDisclosureFrameTx,
  submitDisclosureFrameTx,
  type DisclosureFrameTxArgs,
} from "../src/frametx";
import { NetworkClient } from "../src/net";

const ZERODROP: Address = "0x00000000000000000000000000000000000000cd";
const CASE: Hex = `0x${"11".repeat(32)}`;
const CID: Hex = `0x${"22".repeat(32)}`;
const PROOF: Hex = `0x${"33".repeat(256)}`;
const RECORD_ABI = parseAbi([`function ${RECORD_SIGNATURE}`]);

const base: DisclosureFrameTxArgs = {
  zeroDrop: ZERODROP,
  groupId: 1n,
  caseId: CASE,
  cidDigest: CID,
  root: 42n,
  nullifier: 7n,
  depth: 20n,
  proof: PROOF,
  maxFeePerGas: 2_000_000_000n,
};

describe("disclosure frame transaction", () => {
  it("has exactly two frames: VERIFY, then a SENDER frame to ZeroDrop", () => {
    const { tx } = buildDisclosureFrameTx(base);
    const profile = DISCLOSURE_PROFILE;
    expect(tx.frames).toHaveLength(2);
    expect(tx.frames[0]).toMatchObject({ mode: profile.frameModes.VERIFY!, target: null });
    expect(tx.frames[0]!.flags & 0x3).toBe(profile.approveScopes.EXECUTION_AND_PAYMENT);
    expect(tx.frames[1]).toMatchObject({ mode: profile.frameModes.SENDER!, target: ZERODROP, value: 0n });
    expect(tx.sender).toBe(ZERODROP);
  });

  it("the SENDER frame calldata starts with the selector of record(...)", () => {
    const { tx } = buildDisclosureFrameTx(base);
    const data = tx.frames[1]!.data;
    expect(data.slice(0, 10)).toBe(toFunctionSelector(RECORD_SIGNATURE));
    expect(data.slice(0, 10)).toBe(recordSelector());
  });

  it("the calldata decodes back to the record arguments", () => {
    const { tx } = buildDisclosureFrameTx(base);
    const decoded = decodeAbiArgs(tx.frames[1]!.data);
    expect(decoded).toEqual([1n, CASE, CID, 42n, 7n, 20n, PROOF]);
  });

  it("uses the nullifier as the nonce key and carries the proof in an ARBITRARY signature only when asked", () => {
    const { tx } = buildDisclosureFrameTx({ ...base, proofInSignature: true });
    expect(buildDisclosureFrameTx(base).tx.signatures[0]!.signature).toBe("0x");
    expect(tx.nonceKeys).toEqual([7n]);
    expect(tx.signatures).toEqual([{ scheme: 0, signer: "0x", msg: "0x", signature: PROOF }]);
  });

  it("encodes as type 0x06 and round-trips through the library decoder", () => {
    const profile = DISCLOSURE_PROFILE;
    const { tx, raw, sigHash, txHash } = buildDisclosureFrameTx({ ...base, proofInSignature: true });
    expect(raw.startsWith("0x06")).toBe(true);
    expect(sigHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(txHash).toMatch(/^0x[0-9a-f]{64}$/);

    const decoded = decodeTx(profile, raw);
    expect(encodeTx(profile, decoded)).toBe(raw);
    expect(decoded.frames).toHaveLength(2);
    expect(decoded.chainId).toBe(1337n);
    expect(decoded.nonceKeys).toEqual([7n]);
    expect(decoded.frames[1]!.data).toBe(tx.frames[1]!.data);
    expect(decoded.signatures[0]!.signature).toBe(PROOF);
  });

  it("refuses a body gas limit below the on-chain floor", () => {
    expect(() => buildDisclosureFrames({ ...base, senderExecutionGas: MIN_SENDER_EXECUTION_GAS - 1n })).toThrow(/below the floor/);
  });

  it("refuses a zero nullifier", () => {
    expect(() => buildDisclosureFrameTx({ ...base, nullifier: 0n })).toThrow(/nullifier must be nonzero/);
  });

  it("refuses a cost above the 0.01 ether cap", () => {
    expect(() => buildDisclosureFrameTx({ ...base, maxFeePerGas: 100_000_000_000n })).toThrow(/exceeds the cap/);
  });

  it("refuses an empty proof", () => {
    expect(() => buildDisclosureFrameTx({ ...base, proof: "0x" })).toThrow(/proof must not be empty/);
  });
});

describe("submission over network.fetch (offline fake transport)", () => {
  it("sends eth_sendFrameTransaction to every endpoint and maps rejections", async () => {
    const seen: { url: string; method: string; params: unknown[] }[] = [];
    const net = new NetworkClient(async (input, init) => {
      const body = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] };
      seen.push({ url: String(input), method: body.method, params: body.params });
      if (String(input).includes("bad")) {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32000, message: "banned opcode OP-011 at frame 0" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: "0xabc" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const { tx } = buildDisclosureFrameTx(base);

    const out = await submitDisclosureFrameTx({ tx, mempoolUrls: ["https://good.example/rpc", "https://bad.example/rpc"], net });
    expect(out.accepted).toBe(true);
    expect(out.results[0]).toMatchObject({ ok: true, result: "0xabc" });
    expect(out.results[1]).toMatchObject({ ok: false, rejection: { rule: "OP-011" } });

    expect(seen.map((s) => s.method)).toEqual(["eth_sendFrameTransaction", "eth_sendFrameTransaction"]);
    expect(seen[0]!.params[0]).toEqual(JSON.parse(JSON.stringify(toWire(tx))));
    expect(net.summary()).toEqual({ total: 2, anonymous: 0, direct: 2 });
    expect(net.requests.every((r) => r.isolationKey === "source:default")).toBe(true);
  });

  it("reports an unreachable endpoint as a failed result, not a throw", async () => {
    const net = new NetworkClient(async () => {
      throw new Error("certificate is not yet valid");
    });
    const { tx } = buildDisclosureFrameTx(base);
    const out = await submitDisclosureFrameTx({ tx, mempoolUrls: ["https://altmempool.forshtat.com/rpc"], net });
    expect(out.accepted).toBe(false);
    expect(out.results[0]!.error).toMatch(/Cannot reach .*certificate is not yet valid/);
  });

  it("simulation uses ethrex_simulateFrameTransaction with the wire form (parameter shape not verified)", async () => {
    let method = "";
    const net = new NetworkClient(async (_input, init) => {
      method = (JSON.parse(String(init?.body)) as { method: string }).method;
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }), { status: 200 });
    });
    const { tx } = buildDisclosureFrameTx(base);
    await expect(simulateDisclosureFrameTx({ tx, url: "https://sim.example/rpc", net })).resolves.toEqual({ ok: true });
    expect(method).toBe("ethrex_simulateFrameTransaction");
  });
});

/** Decodes the ABI arguments of a record(...) calldata, in order. */
function decodeAbiArgs(data: Hex): readonly unknown[] {
  return decodeFunctionData({ abi: RECORD_ABI, data }).args ?? [];
}
