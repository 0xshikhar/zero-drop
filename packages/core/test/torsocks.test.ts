import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPinnerServer } from "../../../scripts/pinner";
import { cidFor, digestOf } from "../src/content";
import { NetworkClient } from "../src/net";
import { publishDocument, type PinnerEndpoint } from "../src/pin";
import { resolveDocument } from "../src/resolve";
import { TorSocksError, torSocksTransport } from "../src/torsocks";

/**
 * Unit tests run the SOCKS transport's HTTP plumbing against a real local pinner, with a plain agent
 * injected in place of the SOCKS agent (no Tor needed). Live tests need a running Tor client:
 *   ZD_TOR_SOCKS=socks5h://127.0.0.1:9150 [ZD_ONION_PINNER=http://<host>.onion] pnpm --filter @zerodrop/core test torsocks
 */

const PLAIN = (_url: URL) => new http.Agent({ keepAlive: false });
const DUMMY_PROXY = "socks5h://127.0.0.1:1";

describe("torSocksTransport: validation", () => {
  it("refuses socks5 (no remote DNS) and other schemes", () => {
    expect(() => torSocksTransport({ socksUrl: "socks5://127.0.0.1:9050" })).toThrow(TorSocksError);
    expect(() => torSocksTransport({ socksUrl: "http://127.0.0.1:9050" })).toThrow(/socks5h/);
  });
});

describe("torSocksTransport: HTTP plumbing against a real pinner (no Tor)", () => {
  let server: http.Server;
  let base: string;
  let dir: string;
  const transport = torSocksTransport({ socksUrl: DUMMY_PROXY, agentFactory: PLAIN });
  const bytes = new TextEncoder().encode("through the transport\n");
  const cid = cidFor(bytes);

  beforeAll(async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    dir = mkdtempSync(join(tmpdir(), "zd-torsocks-"));
    server = createPinnerServer(dir);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("PUTs a body and reads it back with GET, status and bytes intact", async () => {
    const put = await transport(`${base}/pin/${cid}`, { method: "PUT", body: bytes, headers: { "content-type": "application/octet-stream" } });
    expect(put.status).toBeLessThan(300);
    const got = await transport(`${base}/ipfs/${cid}`);
    expect(got.status).toBe(200);
    expect(digestOf(new Uint8Array(await got.arrayBuffer()))).toBe(digestOf(bytes));
  });

  it("passes error statuses through without throwing", async () => {
    const bad = await transport(`${base}/ipfs/bafkreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`);
    expect(bad.status).toBeGreaterThanOrEqual(400);
  });

  it("sends multipart FormData with its boundary (the Kubo add shape)", async () => {
    const form = new FormData();
    form.append("file", new Blob([bytes]), "document");
    const seen = await new Promise<{ ct: string; len: number }>((resolve) => {
      const probe = http.createServer((req, res) => {
        let n = 0;
        req.on("data", (c: Buffer) => (n += c.length));
        req.on("end", () => {
          res.end("{}");
          resolve({ ct: String(req.headers["content-type"]), len: n });
        });
      });
      probe.listen(0, "127.0.0.1", async () => {
        const port = (probe.address() as AddressInfo).port;
        await transport(`http://127.0.0.1:${port}/api/v0/add`, { method: "POST", body: form });
        probe.close();
      });
    });
    expect(seen.ct).toMatch(/^multipart\/form-data; boundary=/);
    expect(seen.len).toBeGreaterThan(bytes.length);
  });

  it("works end to end through network.useTransport with publish and resolve", async () => {
    const doc = new TextEncoder().encode(`publish via tor transport ${Date.now()}\n`);
    const docCid = cidFor(doc);
    const endpoint: PinnerEndpoint = { id: "local", kind: "zerodrop", url: base };
    const client = new NetworkClient();
    client.useTransport(transport, "anonymous");
    const pub = await publishDocument({ bytes: doc, cid: docCid, endpoints: [endpoint], minPins: 1, client });
    expect(pub.ok).toBe(true);
    const res = await resolveDocument({ cid: docCid, endpoints: [endpoint], client });
    expect(res.ok).toBe(true);
    expect(client.summary().anonymous).toBeGreaterThan(0);
  });

  it("aborts a request when its signal fires", async () => {
    const controller = new AbortController();
    const pending = transport(`${base}/health`, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow();
  });
});

const live = process.env.ZD_TOR_SOCKS;
describe.skipIf(!live)("live Tor (needs a running Tor client)", () => {
  const transport = torSocksTransport({ socksUrl: live ?? DUMMY_PROXY, timeoutMs: 120_000 });

  it("exits through Tor (check.torproject.org reports IsTor)", async () => {
    const res = await transport("https://check.torproject.org/api/ip");
    const body = (await res.json()) as { IsTor: boolean };
    expect(body.IsTor).toBe(true);
  }, 150_000);

  it("reaches the PressProtocol onion gateway over Tor", async () => {
    const res = await transport("http://6wst2skhjdkaltwvy37clw2mzk75lteq66qu5qzg3ujhresdhloy63yd.onion/health");
    expect(res.status).toBe(200);
  }, 150_000);

  const onion = process.env.ZD_ONION_PINNER;
  it.skipIf(!onion)("publishes to and resolves from our own onion pinner over Tor", async () => {
    const doc = new TextEncoder().encode(`tor onion roundtrip ${Date.now()}\n`);
    const cid = cidFor(doc);
    const endpoint: PinnerEndpoint = { id: "onion", kind: "zerodrop", url: onion! };
    const client = new NetworkClient();
    client.useTransport(transport, "anonymous");
    const pub = await publishDocument({ bytes: doc, cid, endpoints: [endpoint], minPins: 1, client });
    expect(pub.ok).toBe(true);
    const res = await resolveDocument({ cid, endpoints: [endpoint], client });
    expect(res.ok).toBe(true);
    expect(res.source).toBe(onion);
  }, 240_000);
});
