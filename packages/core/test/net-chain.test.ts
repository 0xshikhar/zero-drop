import { describe, expect, it } from "vitest";
import type { PublicClient } from "viem";
import { fanOutRead, makePublicClient } from "../src/chain";
import { AnonRpcTransport, DEFAULT_TIMEOUT_MS, NetworkClient, NotConfiguredError, withTimeout } from "../src/net";

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

describe("NetworkClient traffic accounting", () => {
  it("counts direct requests and records isolation keys without the query string", async () => {
    const net = new NetworkClient(async () => jsonResponse({ jsonrpc: "2.0", id: 1, result: "0x1" }));
    await net.fetch("https://rpc.example/x?key=secret", { method: "POST" }, "source", "s1");
    await net.fetch("https://rpc.example/y");

    expect(net.summary()).toEqual({ total: 2, anonymous: 0, direct: 2 });
    expect(net.requests[0]).toMatchObject({
      url: "https://rpc.example/x",
      method: "POST",
      role: "source",
      session: "s1",
      isolationKey: "source:s1",
      route: "direct",
      ok: true,
    });
    expect(net.requests[1]?.isolationKey).toBe("reader:default");
    expect(JSON.stringify(net.requests)).not.toContain("secret");
  });

  it("records a rejected transport as a failed request and rethrows", async () => {
    const net = new NetworkClient(async () => {
      throw new Error("socket hang up");
    });
    await expect(net.fetch("https://rpc.example/z")).rejects.toThrow("socket hang up");
    expect(net.requests[0]).toMatchObject({ ok: false, error: "socket hang up" });
    expect(net.summary()).toEqual({ total: 1, anonymous: 0, direct: 1 });
  });

  it("the anonymous placeholder throws NotConfiguredError and is counted as anonymous", async () => {
    const anon = new AnonRpcTransport();
    const net = new NetworkClient(anon.fetch, { route: "anonymous" });
    const attempt = net.fetch("https://rpc.example/anon");
    await expect(attempt).rejects.toBeInstanceOf(NotConfiguredError);
    await expect(attempt).rejects.toThrow("Anon-RPC worker is not integrated in this build");
    expect(net.summary()).toEqual({ total: 1, anonymous: 1, direct: 0 });
  });

  it("reset clears counters and records", async () => {
    const net = new NetworkClient(async () => jsonResponse({}));
    await net.fetch("https://rpc.example/a");
    net.reset();
    expect(net.summary()).toEqual({ total: 0, anonymous: 0, direct: 0 });
    expect(net.requests).toHaveLength(0);
  });

  it("withTimeout aborts a request that does not finish", async () => {
    const hanging = (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    await expect(withTimeout(hanging, 10)("https://rpc.example/slow")).rejects.toThrow(/timed out after 10 ms/);
  });

  it("the default timeout is 60 seconds", () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(60_000);
  });
});

describe("makePublicClient", () => {
  it("returns one client per URL and routes viem requests through network.fetch", async () => {
    const calls: { url: string; method: string }[] = [];
    const net = new NetworkClient(async (input, init) => {
      const body = JSON.parse(String(init?.body));
      calls.push({ url: String(input), method: body.method });
      return jsonResponse({ jsonrpc: "2.0", id: body.id, result: "0x10" });
    });

    const clients = makePublicClient({
      rpcUrls: ["http://127.0.0.1:8545", "http://127.0.0.1:8546"],
      chainId: 31337,
      role: "reader",
      session: "abc",
      net,
    });
    expect(clients).toHaveLength(2);

    const height = await clients[0]!.getBlockNumber();
    expect(height).toBe(16n);
    expect(calls).toEqual([{ url: "http://127.0.0.1:8545/", method: "eth_blockNumber" }]);
    expect(net.requests[0]?.isolationKey).toBe("reader:abc");
    expect(net.summary()).toEqual({ total: 1, anonymous: 0, direct: 1 });
  });

  it("refuses an empty endpoint list", () => {
    expect(() => makePublicClient({ rpcUrls: [], chainId: 31337, role: "reader" })).toThrow(/no RPC endpoints/);
  });
});

describe("fanOutRead quorum", () => {
  const client = (answer: () => Promise<unknown>) => ({ answer }) as unknown as PublicClient;
  const ask = (c: PublicClient) => (c as unknown as { answer: () => Promise<unknown> }).answer();

  it("returns the value when the quorum agrees", async () => {
    const clients = [client(async () => "a"), client(async () => "a"), client(async () => "b")];
    const result = await fanOutRead(clients, ask, { quorum: 2 });
    expect(result).toMatchObject({ ok: true, value: "a", agreeing: 2, total: 3 });
  });

  it("does not return a value when no quorum agrees", async () => {
    const clients = [client(async () => "a"), client(async () => "b"), client(async () => "c")];
    const result = await fanOutRead(clients, ask, { quorum: 2 });
    expect(result.ok).toBe(false);
    expect(result.value).toBeUndefined();
    expect(result.reason).toMatch(/no agreement: best answer has 1 of 3/);
  });

  it("counts failing endpoints as errors, not as votes", async () => {
    const clients = [
      client(async () => {
        throw new Error("HTTP 503");
      }),
      client(async () => "a"),
      client(async () => "a"),
    ];
    const result = await fanOutRead(clients, ask, { quorum: 2 });
    expect(result).toMatchObject({ ok: true, value: "a", agreeing: 2 });
    expect(result.errors).toEqual(["HTTP 503"]);
  });

  it("rejects a quorum larger than the endpoint count", async () => {
    const result = await fanOutRead([client(async () => "a")], ask, { quorum: 2 });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/exceeds the 1 configured endpoint/);
  });

  it("treats two different answers that each reach the quorum as ambiguous", async () => {
    const clients = [client(async () => "a"), client(async () => "a"), client(async () => "b"), client(async () => "b")];
    const result = await fanOutRead(clients, ask, { quorum: 2 });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/conflicting answers/);
  });

  it("compares bigint answers by value", async () => {
    const clients = [client(async () => 5n), client(async () => 5n)];
    const result = await fanOutRead(clients, ask, { quorum: 2 });
    expect(result).toMatchObject({ ok: true, value: 5n });
  });
});
