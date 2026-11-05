import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AnonRpcError,
  AnonRpcTransport,
  NetworkClient,
  NotConfiguredError,
  configureNetwork,
  directTransport,
  isolationKeyFor,
  parseBootPercent,
  type AnonWorkerInit,
  type AnonWorkerLike,
  type BootState,
} from "../src/net";

const ok = (body = "{}") => new Response(body, { status: 200 });

/** A controllable stand-in for AnonRpcWorker. No Tor, no iframe: only the API surface the transport uses. */
class FakeWorker implements AnonWorkerLike {
  ready: Promise<void>;
  resolveReady!: () => void;
  rejectReady!: (e: unknown) => void;
  calls: { url: string; init: any }[] = [];
  closed = false;
  private logWaiters: { resolve: (e: any) => void; reject: (e: unknown) => void }[] = [];
  private logQueue: { level: string; args: unknown[] }[] = [];
  private logError?: unknown;

  constructor(readonly init: AnonWorkerInit) {
    this.ready = new Promise((res, rej) => {
      this.resolveReady = res;
      this.rejectReady = rej;
    });
    this.ready.catch(() => {});
  }

  fetch = vi.fn(async (input: RequestInfo | URL, init?: any) => {
    this.calls.push({ url: String(input), init });
    return ok(JSON.stringify({ via: "worker" }));
  });

  acceptLog = (): Promise<{ level: string; args: unknown[] }> => {
    const queued = this.logQueue.shift();
    if (queued) return Promise.resolve(queued);
    if (this.logError !== undefined) return Promise.reject(this.logError);
    return new Promise((resolve, reject) => this.logWaiters.push({ resolve, reject }));
  };

  log(...args: unknown[]) {
    const entry = { level: "info", args };
    const waiter = this.logWaiters.shift();
    if (waiter) waiter.resolve(entry);
    else this.logQueue.push(entry);
  }

  die(error: unknown) {
    this.logError = error;
    for (const w of this.logWaiters.splice(0)) w.reject(error);
  }

  close() {
    this.closed = true;
  }
}

function setup(options: Partial<ConstructorParameters<typeof AnonRpcTransport>[0]> = {}) {
  const workers: FakeWorker[] = [];
  const transport = new AnonRpcTransport({
    address: "0x00000000000000000000000000000000000000aa",
    rpcProvider: { request: async () => "0x" },
    workerFactory: (init) => {
      const worker = new FakeWorker(init);
      workers.push(worker);
      return worker;
    },
    ...options,
  });
  const states: BootState[] = [];
  transport.subscribe((s) => states.push(s));
  return { transport, workers, states };
}

const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("AnonRpcTransport boot", () => {
  it("is idle and lazy: no worker is built until the first use", () => {
    const { transport, workers } = setup();
    expect(transport.state).toEqual({ status: "idle" });
    expect(workers).toHaveLength(0);
  });

  it("goes idle -> booting -> ready and passes the init through to the worker factory", async () => {
    const { transport, workers, states } = setup({ config: { network: "mainnet" }, iframeUrl: "/anon.html" });
    const boot = transport.boot();
    await flush();
    expect(transport.state.status).toBe("booting");
    expect(workers[0]!.init.address).toBe("0x00000000000000000000000000000000000000aa");
    expect(workers[0]!.init.config).toEqual({ network: "mainnet" });
    expect(workers[0]!.init.iframeUrl).toBe("/anon.html");
    workers[0]!.resolveReady();
    await boot;
    expect(transport.state.status).toBe("ready");
    expect(states.map((s) => s.status)).toEqual(["booting", "ready"]);
  });

  it("boots once for many concurrent callers", async () => {
    const { transport, workers } = setup();
    const a = transport.fetch("https://rpc.example/a");
    const b = transport.fetch("https://rpc.example/b");
    await flush();
    workers[0]!.resolveReady();
    await Promise.all([a, b]);
    expect(workers).toHaveLength(1);
    expect(workers[0]!.calls).toHaveLength(2);
  });

  it("reports progress from worker log lines, with a monotonic percentage", async () => {
    const { transport, workers, states } = setup();
    void transport.boot().catch(() => {});
    await flush();
    workers[0]!.log("Bootstrapped 10% (conn_done)");
    await flush();
    workers[0]!.log("Bootstrapped 45% (loading_descriptors)");
    await flush();
    workers[0]!.log("circuit built"); // no percentage: keeps 45
    await flush();
    workers[0]!.log("Bootstrapped 30% (stale line)"); // lower: ignored for percent
    await flush();
    const booting = states.filter((s): s is Extract<BootState, { status: "booting" }> => s.status === "booting");
    expect(booting.map((s) => s.percent)).toEqual([undefined, 10, 45, 45, 45]);
    expect(booting.at(-1)?.step).toBe("Bootstrapped 30% (stale line)");
    expect(transport.logs().map((l) => l.text)).toContain("circuit built");
    workers[0]!.resolveReady();
  });

  it("fails with a timeout when the worker never becomes ready, closes the worker, and does not fetch", async () => {
    const { transport, workers, states } = setup({ readyTimeoutMs: 5_000 });
    const attempt = transport.fetch("https://rpc.example/x").then(
      () => "resolved",
      (e: unknown) => e,
    );
    await vi.advanceTimersByTimeAsync(5_001);
    const error = (await attempt) as AnonRpcError;
    expect(error).toBeInstanceOf(AnonRpcError);
    expect(error.code).toBe("ANON_BOOT_TIMEOUT");
    expect(error.message).toMatch(/did not become ready within 5 s/);
    expect(error.message).toMatch(/NOT sent/);
    expect(workers[0]!.closed).toBe(true);
    expect(workers[0]!.calls).toHaveLength(0);
    expect(transport.state).toMatchObject({ status: "failed", code: "ANON_BOOT_TIMEOUT" });
    expect(states.at(-1)?.status).toBe("failed");
  });

  it("a boot failure is sticky: later requests reject immediately and the worker is not asked", async () => {
    const { transport, workers } = setup();
    const first = transport.fetch("https://rpc.example/1").catch((e: unknown) => e);
    await flush();
    workers[0]!.rejectReady(new Error("specifier read failed"));
    const error = (await first) as AnonRpcError;
    expect(error).toBeInstanceOf(AnonRpcError);
    expect(error.code).toBe("ANON_BOOT_FAILED");
    expect(error.message).toMatch(/specifier read failed/);
    await expect(transport.fetch("https://rpc.example/2")).rejects.toMatchObject({ code: "ANON_BOOT_FAILED" });
    expect(workers).toHaveLength(1);
    expect(workers[0]!.calls).toHaveLength(0);
  });

  it("retry() builds a fresh worker after a failure", async () => {
    const { transport, workers } = setup();
    const first = transport.boot().catch((e: unknown) => e);
    await flush();
    workers[0]!.rejectReady(new Error("boom"));
    await first;
    const retry = transport.retry();
    await flush();
    expect(workers).toHaveLength(2);
    workers[1]!.resolveReady();
    await retry;
    expect(transport.state.status).toBe("ready");
  });

  it("a factory that throws is a boot failure", async () => {
    const transport = new AnonRpcTransport({
      address: "0x00000000000000000000000000000000000000aa",
      rpcProvider: { request: async () => "0x" },
      workerFactory: () => {
        throw new Error("no document");
      },
    });
    await expect(transport.fetch("https://rpc.example/x")).rejects.toMatchObject({ code: "ANON_BOOT_FAILED" });
    expect(transport.state).toMatchObject({ status: "failed", reason: "no document" });
  });

  it("is NotConfigured without a specifier address or bootstrap RPC, and never builds a worker", async () => {
    const factory = vi.fn();
    const noAddress = new AnonRpcTransport({ workerFactory: factory });
    await expect(noAddress.fetch("https://rpc.example/x")).rejects.toBeInstanceOf(NotConfiguredError);
    const noRpc = new AnonRpcTransport({ address: "0x01", workerFactory: factory });
    await expect(noRpc.fetch("https://rpc.example/x")).rejects.toBeInstanceOf(NotConfiguredError);
    expect(factory).not.toHaveBeenCalled();
    expect(noAddress.state).toMatchObject({ status: "failed", code: "NOT_CONFIGURED" });
  });

  it("a worker that dies after ready flips the state to failed and later requests reject", async () => {
    const { transport, workers } = setup();
    const boot = transport.boot();
    await flush();
    workers[0]!.resolveReady();
    await boot;
    workers[0]!.die(new Error("worker error: out of memory"));
    await flush();
    expect(transport.state).toMatchObject({ status: "failed", reason: "worker stopped: worker error: out of memory" });
    await expect(transport.fetch("https://rpc.example/x")).rejects.toMatchObject({ code: "ANON_UNAVAILABLE" });
    expect(workers[0]!.calls).toHaveLength(0);
  });

  it("close() closes the worker and rejects later requests", async () => {
    const { transport, workers } = setup();
    const boot = transport.boot();
    await flush();
    workers[0]!.resolveReady();
    await boot;
    transport.close();
    expect(workers[0]!.closed).toBe(true);
    await expect(transport.fetch("https://rpc.example/x")).rejects.toMatchObject({ code: "ANON_CLOSED" });
  });

  it("an abort signal ends the wait for boot without sending anything", async () => {
    const { transport, workers } = setup();
    const controller = new AbortController();
    const attempt = transport.fetch("https://rpc.example/x", { signal: controller.signal });
    await flush();
    controller.abort(new Error("user cancelled"));
    await expect(attempt).rejects.toThrow("user cancelled");
    expect(workers[0]!.calls).toHaveLength(0);
  });

  it("bootstrapRpcUrl builds an eth_call provider on the supplied bootstrap fetch", async () => {
    const bootstrapFetch = vi.fn(async () => ok(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0xabc" })));
    const workers: FakeWorker[] = [];
    const transport = new AnonRpcTransport({
      address: "0x01",
      bootstrapRpcUrl: "https://boot.example/rpc",
      bootstrapFetch,
      workerFactory: (init) => (workers[0] = new FakeWorker(init)),
    });
    void transport.boot().catch(() => {});
    await flush();
    const result = await workers[0]!.init.preExisting.rpcProvider.request({ method: "eth_call", params: [{ to: "0x01" }, "latest"] });
    expect(result).toBe("0xabc");
    expect(bootstrapFetch).toHaveBeenCalledWith("https://boot.example/rpc", expect.objectContaining({ method: "POST" }));
    workers[0]!.resolveReady();
  });
});

describe("AnonRpcTransport isolation keys and request timeout", () => {
  async function ready() {
    const ctx = setup();
    const boot = ctx.transport.boot();
    await flush();
    ctx.workers[0]!.resolveReady();
    await boot;
    return ctx;
  }

  it("sends role:session as anonOptions.isolationKey, the same for repeated calls", async () => {
    const { transport, workers } = await ready();
    const ctx = { role: "reader" as const, session: "s1", isolationKey: isolationKeyFor("reader", "s1") };
    await transport.fetch("https://rpc.example/a", { method: "POST", body: "{}" }, ctx);
    await transport.fetch("https://rpc.example/b", { method: "POST", body: "{}" }, ctx);
    await transport.fetch("https://rpc.example/c", {}, { role: "source", session: "post", isolationKey: "source:post" });
    expect(workers[0]!.calls.map((c) => c.init.anonOptions.isolationKey)).toEqual(["reader:s1", "reader:s1", "source:post"]);
    expect(workers[0]!.calls[0]!.init.method).toBe("POST");
  });

  it("a caller-supplied anonOptions key never overrides the context key and other options survive", async () => {
    const { transport, workers } = await ready();
    await transport.fetch(
      "https://rpc.example/a",
      { anonOptions: { isolationKey: "attacker:1", extra: 1 } } as RequestInit,
      { role: "reader", session: "s", isolationKey: "reader:s" },
    );
    expect(workers[0]!.calls[0]!.init.anonOptions).toEqual({ isolationKey: "reader:s", extra: 1 });
  });

  it("falls back to a fixed default key, not a random per-call one, when no context is given", async () => {
    const { transport, workers } = await ready();
    await transport.fetch("https://rpc.example/a");
    await transport.fetch("https://rpc.example/b");
    const keys = workers[0]!.calls.map((c) => c.init.anonOptions.isolationKey);
    expect(keys).toEqual(["reader:default", "reader:default"]);
  });

  it("aborts a request that outlives the request timeout", async () => {
    const { transport, workers } = setup({ requestTimeoutMs: 1_000 });
    const boot = transport.boot();
    await flush();
    workers[0]!.resolveReady();
    await boot;
    workers[0]!.fetch.mockImplementationOnce(
      (_input: RequestInfo | URL, init?: any) =>
        new Promise<Response>((_res, rej) => init.signal.addEventListener("abort", () => rej(init.signal.reason))),
    );
    const attempt = transport.fetch("https://rpc.example/slow").catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1_001);
    expect(String(await attempt)).toMatch(/timed out after 1000 ms/);
  });
});

describe("NetworkClient with the anonymous transport", () => {
  async function wired() {
    const ctx = setup();
    const client = new NetworkClient(directTransport);
    const direct = vi.fn(async () => ok());
    client.useTransport(direct, "direct");
    return { ...ctx, client, direct };
  }

  it("counts requests routed through the anon transport as anonymous and the others as direct", async () => {
    const { transport, workers, client, direct } = await wired();
    await client.fetch("https://rpc.example/direct-1");
    client.useTransport(transport);
    expect(client.mode).toBe("anon");
    const first = client.fetch("https://rpc.example/anon-1", {}, "source", "post");
    await flush();
    workers[0]!.resolveReady();
    await first;
    await client.fetch("https://rpc.example/anon-2", {}, "reader", "view");
    expect(client.summary()).toEqual({ total: 3, anonymous: 2, direct: 1 });
    expect(direct).toHaveBeenCalledTimes(1);
    expect(client.requests.map((r) => [r.route, r.isolationKey])).toEqual([
      ["direct", "reader:default"],
      ["anonymous", "source:post"],
      ["anonymous", "reader:view"],
    ]);
    expect(workers[0]!.calls.map((c) => c.init.anonOptions.isolationKey)).toEqual(["source:post", "reader:view"]);
  });

  it("does NOT fall back to the direct transport when anon fails; the failure is recorded", async () => {
    const { transport, workers, client, direct } = await wired();
    client.useTransport(transport);
    const attempt = client.fetch("https://rpc.example/anon").catch((e: unknown) => e);
    await flush();
    workers[0]!.rejectReady(new Error("tor unreachable"));
    expect(await attempt).toBeInstanceOf(AnonRpcError);
    expect(direct).not.toHaveBeenCalled();
    expect(workers[0]!.calls).toHaveLength(0);
    expect(client.summary()).toEqual({ total: 1, anonymous: 1, direct: 0 });
    expect(client.requests[0]).toMatchObject({ route: "anonymous", ok: false });
    expect(client.requests[0]!.error).toMatch(/tor unreachable/);
  });

  it("a timed-out boot never reaches the direct transport; only an explicit switch to direct does", async () => {
    const { transport, client, direct } = await wired();
    client.useTransport(transport);
    const attempt = client.fetch("https://rpc.example/a").catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(120_001); // default ready timeout
    expect(await attempt).toMatchObject({ code: "ANON_BOOT_TIMEOUT" });
    await expect(client.fetch("https://rpc.example/b")).rejects.toBeInstanceOf(AnonRpcError);
    expect(direct).not.toHaveBeenCalled();
    client.useTransport(direct, "direct");
    await client.fetch("https://rpc.example/c");
    expect(direct).toHaveBeenCalledTimes(1);
    expect(client.summary()).toEqual({ total: 3, anonymous: 2, direct: 1 });
  });

  it("subscribe sees boot-state changes, and the new state when the transport is switched", async () => {
    const { transport, workers, client } = await wired();
    const seen: string[] = [];
    const off = client.subscribe((s) => seen.push(s.status));
    client.useTransport(transport);
    expect(seen).toEqual(["idle"]);
    const boot = client.boot();
    await flush();
    workers[0]!.resolveReady();
    await boot;
    expect(seen).toEqual(["idle", "booting", "ready"]);
    expect(client.bootState.status).toBe("ready");
    client.useTransport(vi.fn(async () => ok()), "direct");
    expect(seen.at(-1)).toBe("idle");
    expect(client.mode).toBe("direct");
    off();
    client.useTransport(transport);
    expect(seen.at(-1)).toBe("idle");
    expect(seen).toHaveLength(4);
  });

  it("fetchDirect always counts as direct, even in anon mode", async () => {
    const real = globalThis.fetch;
    const stub = vi.fn(async () => ok());
    globalThis.fetch = stub as unknown as typeof fetch;
    try {
      const { transport, client } = await wired();
      client.useTransport(transport);
      await client.fetchDirect("https://boot.example/rpc", { method: "POST" });
      expect(client.summary()).toEqual({ total: 1, anonymous: 0, direct: 1 });
      expect(stub).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.fetch = real;
    }
  });
});

describe("configureNetwork", () => {
  it("switches between direct and anon, and anon without options never goes direct", async () => {
    const real = globalThis.fetch;
    const stub = vi.fn(async () => ok());
    globalThis.fetch = stub as unknown as typeof fetch;
    try {
      const client = new NetworkClient();
      expect(client.mode).toBe("direct");
      configureNetwork({ mode: "anon" }, client);
      expect(client.mode).toBe("anon");
      await expect(client.fetch("https://rpc.example/x")).rejects.toBeInstanceOf(NotConfiguredError);
      expect(stub).not.toHaveBeenCalled();
      configureNetwork({ mode: "direct" }, client);
      expect(client.mode).toBe("direct");
      await client.fetch("https://rpc.example/x");
      expect(stub).toHaveBeenCalledTimes(1);
      expect(client.summary()).toEqual({ total: 2, anonymous: 1, direct: 1 });
    } finally {
      globalThis.fetch = real;
    }
  });

  it("builds an AnonRpcTransport from options and routes the bootstrap read as a counted direct request", async () => {
    const real = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => ok(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x" }))) as unknown as typeof fetch;
    try {
      const client = new NetworkClient();
      const workers: FakeWorker[] = [];
      configureNetwork(
        {
          mode: "anon",
          anon: {
            address: "0x01",
            bootstrapRpcUrl: "https://boot.example/rpc",
            workerFactory: (init) => (workers[0] = new FakeWorker(init)),
          },
        },
        client,
      );
      void client.boot().catch(() => {});
      await flush();
      await workers[0]!.init.preExisting.rpcProvider.request({ method: "eth_call", params: [] });
      expect(client.summary()).toEqual({ total: 1, anonymous: 0, direct: 1 });
      workers[0]!.resolveReady();
    } finally {
      globalThis.fetch = real;
    }
  });
});

describe("parseBootPercent", () => {
  it("reads a percentage and ignores out-of-range numbers", () => {
    expect(parseBootPercent("Bootstrapped 45% (x)")).toBe(45);
    expect(parseBootPercent("progress 100 %")).toBe(100);
    expect(parseBootPercent("no number here")).toBeUndefined();
    expect(parseBootPercent("999%")).toBeUndefined();
  });
});
