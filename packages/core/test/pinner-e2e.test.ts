import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPinnerServer } from "../../../scripts/pinner";
import { cidFor } from "../src/content";
import { network } from "../src/net";
import { keepOnline, publishDocument, type PinnerEndpoint } from "../src/pin";
import { resolveDocument } from "../src/resolve";

// Real code paths: publishDocument/resolveDocument -> network.fetch (default direct transport) -> real
// node:http server from scripts/pinner.ts on 127.0.0.1. No fakes.

const bytes = new TextEncoder().encode("end to end document\n");
const cid = cidFor(bytes);

let dirs: string[] = [];
let servers: Server[] = [];
let endpoints: PinnerEndpoint[] = [];

function stop(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

async function start(name: string): Promise<{ server: Server; endpoint: PinnerEndpoint; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), `zerodrop-pins-${name}-`));
  const server = createPinnerServer(dir);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { server, dir, endpoint: { id: name, kind: "zerodrop", url: `http://127.0.0.1:${port}` } };
}

beforeAll(async () => {
  for (const name of ["p1", "p2"]) {
    const s = await start(name);
    servers.push(s.server);
    dirs.push(s.dir);
    endpoints.push(s.endpoint);
  }
});

afterAll(async () => {
  await Promise.all(servers.map(stop));
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("pinner server + publish/resolve over http://127.0.0.1", () => {
  it("publishes to two pinners and resolves the verified bytes", async () => {
    const before = network.summary().total;
    const published = await publishDocument({ bytes, cid, endpoints });
    expect(published.ok).toBe(true);
    expect(published.pinned).toBe(2);
    expect(readdirSync(dirs[0]!)).toEqual([cid]);

    const resolved = await resolveDocument({ cid, endpoints });
    expect(resolved.ok).toBe(true);
    expect(resolved.bytes).toEqual(bytes);
    expect(network.summary().total).toBeGreaterThanOrEqual(before + 3);
    expect(network.requests.at(-1)!.role).toBe("reader");
  });

  it("still resolves after one pinner is gone, and a reader re-pin restores redundancy (F19)", async () => {
    const third = await start("p3");
    dirs.push(third.dir);
    try {
      // Take p1 offline; its address now refuses connections.
      await stop(servers[0]!);
      expect((await resolveDocument({ cid, endpoints: endpoints })).source).toBe("p2");

      const repin = await keepOnline({ bytes, cid, endpoint: third.endpoint });
      expect(repin.ok).toBe(true);
      const afterRemoval = await resolveDocument({ cid, endpoints: [endpoints[0]!, third.endpoint] });
      expect(afterRemoval.ok).toBe(true);
      expect(afterRemoval.source).toBe("p3");
      expect(afterRemoval.failed).toEqual(["p1"]);
    } finally {
      await stop(third.server);
    }
  });

  it("server rejects bytes that do not match the CID, bad CIDs, path tricks and oversize uploads", async () => {
    const live = (await start("p4"));
    dirs.push(live.dir);
    const base = live.endpoint.url;
    const put = (path: string, body: Uint8Array) =>
      network.fetch(`${base}${path}`, { method: "PUT", body }, "source");
    try {
      const wrong = await put(`/pin/${cid}`, new TextEncoder().encode("different bytes"));
      expect(wrong.status).toBe(400);
      expect((await network.fetch(`${base}/ipfs/${cid}`, {}, "reader")).status).toBe(404);

      expect((await put("/pin/not-a-cid", bytes)).status).toBe(400);
      expect((await put(`/pin/${encodeURIComponent("../../etc/passwd")}`, bytes)).status).toBe(400);
      expect((await put(`/pin/${cid.toUpperCase()}`, bytes)).status).toBe(400);
      expect((await network.fetch(`${base}/ipfs/..%2F..%2Fetc%2Fpasswd`, {}, "reader")).status).toBe(400);

      const big = new Uint8Array(1_048_577).fill(3);
      expect((await put(`/pin/${cidFor(big)}`, big)).status).toBe(413);
      expect(readdirSync(live.dir)).toEqual([]);

      const edge = new Uint8Array(1_048_576).fill(4);
      expect((await put(`/pin/${cidFor(edge)}`, edge)).status).toBe(201);
    } finally {
      await stop(live.server);
    }
  });

  it("serves CORS headers, preflight, health and HEAD", async () => {
    const live = await start("p5");
    dirs.push(live.dir);
    const base = live.endpoint.url;
    try {
      const pre = await network.fetch(`${base}/pin/${cid}`, { method: "OPTIONS" }, "reader");
      expect(pre.status).toBe(204);
      expect(pre.headers.get("access-control-allow-origin")).toBe("*");
      expect(pre.headers.get("access-control-allow-methods")).toContain("PUT");

      const health = await network.fetch(`${base}/health`, {}, "reader");
      expect(await health.json()).toEqual({ ok: true, pins: 0 });

      await network.fetch(`${base}/pin/${cid}`, { method: "PUT", body: bytes }, "source");
      const got = await network.fetch(`${base}/ipfs/${cid}`, {}, "reader");
      expect(got.headers.get("access-control-allow-origin")).toBe("*");
      expect(new Uint8Array(await got.arrayBuffer())).toEqual(bytes);
      const head = await network.fetch(`${base}/ipfs/${cid}`, { method: "HEAD" }, "reader");
      expect(head.headers.get("content-length")).toBe(String(bytes.length));
    } finally {
      await stop(live.server);
    }
  });
});
