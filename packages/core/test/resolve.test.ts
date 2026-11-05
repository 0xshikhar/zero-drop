import { describe, expect, it } from "vitest";
import { cidFor } from "../src/content";
import { NetworkClient } from "../src/net";
import type { PinnerEndpoint } from "../src/pin";
import { resolveDocument } from "../src/resolve";

const bytes = new TextEncoder().encode("the real document");
const cid = cidFor(bytes);
const ep = (id: string): PinnerEndpoint => ({ id, kind: "zerodrop", url: `http://${id}.test` });

type Behaviour = { delay?: number; body?: Uint8Array | string; status?: number; throws?: string; headers?: Record<string, string> };

function sleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new DOMException("aborted", "AbortError"));
    });
  });
}

function fake(behaviours: Record<string, Behaviour>) {
  const aborted: string[] = [];
  const client = new NetworkClient(async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const b = behaviours[url.hostname.replace(/\.test$/, "")] ?? { throws: "no route" };
    try {
      await sleep(b.delay ?? 0, init.signal);
    } catch (error) {
      aborted.push(url.hostname);
      throw error;
    }
    if (b.throws) throw new TypeError(b.throws);
    return new Response(b.body ?? bytes, { status: b.status ?? 200, headers: b.headers });
  });
  return { client, aborted };
}

describe("resolveDocument", () => {
  it("returns the fastest verified response and cancels the losers", async () => {
    const { client, aborted } = fake({ slow: { delay: 200 }, fast: { delay: 5 }, mid: { delay: 100 } });
    const result = await resolveDocument({ cid, endpoints: [ep("slow"), ep("fast"), ep("mid")], client });
    expect(result.ok).toBe(true);
    expect(result.source).toBe("fast");
    expect(result.bytes).toEqual(bytes);
    expect(result.attempts.map((a) => [a.endpointId, a.status])).toEqual([["slow", "cancelled"], ["fast", "verified"], ["mid", "cancelled"]]);
    expect(aborted.sort()).toEqual(["mid.test", "slow.test"]);
    expect(client.requests.every((r) => r.role === "reader" && r.method === "GET")).toBe(true);
  });

  it("never accepts wrong bytes, even from the fastest endpoint, and reports it", async () => {
    const { client } = fake({ liar: { delay: 1, body: "forged document" }, honest: { delay: 30 }, down: { throws: "ECONNREFUSED" } });
    const result = await resolveDocument({ cid, endpoints: [ep("liar"), ep("honest"), ep("down")], client });
    expect(result.ok).toBe(true);
    expect(result.source).toBe("honest");
    expect(result.wrongBytes).toEqual(["liar"]);
    expect(result.failed).toEqual(["down"]);
    expect(result.answered.sort()).toEqual(["honest", "liar"]);
  });

  it("fails when every endpoint is down, 404, or lying", async () => {
    const { client } = fake({ a: { throws: "boom" }, b: { status: 404, body: "nope" }, c: { body: "forged" } });
    const result = await resolveDocument({ cid, endpoints: [ep("a"), ep("b"), ep("c")], client });
    expect(result.ok).toBe(false);
    expect(result.bytes).toBeUndefined();
    expect(result.failed).toEqual(["a", "b"]);
    expect(result.wrongBytes).toEqual(["c"]);
    expect(result.attempts.find((a) => a.endpointId === "b")!.error).toBe("HTTP 404");
  });

  it("fails cleanly with all endpoints failing", async () => {
    const { client } = fake({});
    const result = await resolveDocument({ cid, endpoints: [ep("x"), ep("y")], client });
    expect(result.ok).toBe(false);
    expect(result.failed).toEqual(["x", "y"]);
    expect(result.reason).toMatch(/No endpoint/);
  });

  it("uses caller-supplied gateways, and none by default", async () => {
    const { client } = fake({ gw: { body: bytes } });
    const without = await resolveDocument({ cid, endpoints: [], client });
    expect(without.ok).toBe(false);
    expect(client.requests).toHaveLength(0);
    const withGateway = await resolveDocument({ cid, endpoints: [], gateways: ["http://gw.test/"], client });
    expect(withGateway.ok).toBe(true);
    expect(withGateway.source).toBe("http://gw.test/");
    expect(client.requests[0]!.url).toBe(`http://gw.test/ipfs/${cid}`);
  });

  it("enforces the 1 MiB cap (declared length and streamed)", async () => {
    const huge = new Uint8Array(1_048_577);
    const { client } = fake({ declared: { body: huge, headers: { "content-length": String(huge.length) } }, streamed: { body: huge, delay: 3 } });
    const result = await resolveDocument({ cid, endpoints: [ep("declared"), ep("streamed")], client });
    expect(result.ok).toBe(false);
    expect(result.attempts.map((a) => a.status)).toEqual(["failed", "failed"]);
    expect(result.attempts[0]!.error).toMatch(/limit/);
  });

  it("rejects a malformed cid without any request, and honours an external abort", async () => {
    const { client } = fake({ a: { delay: 500 } });
    expect((await resolveDocument({ cid: "bad", endpoints: [ep("a")], client })).ok).toBe(false);
    expect(client.requests).toHaveLength(0);
    const controller = new AbortController();
    const pending = resolveDocument({ cid, endpoints: [ep("a")], client, signal: controller.signal });
    controller.abort();
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.attempts[0]!.status).toBe("cancelled");
  });
});
