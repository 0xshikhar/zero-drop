import { describe, expect, it } from "vitest";
import { cidFor } from "../src/content";
import { NetworkClient } from "../src/net";
import { digestFromCid, keepOnline, MAX_DOCUMENT_BYTES, PinInputError, publishDocument, type PinnerEndpoint } from "../src/pin";

const bytes = new TextEncoder().encode("a leaked memo");
const cid = cidFor(bytes);

type Seen = { url: string; method: string; body: unknown };

function fake(handler: (url: URL, init: RequestInit) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const client = new NetworkClient(async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    seen.push({ url: url.href, method: init.method ?? "GET", body: init.body });
    return handler(url, init);
  });
  return { client, seen };
}

const zd = (id: string): PinnerEndpoint => ({ id, kind: "zerodrop", url: `http://${id}.test` });
const kubo = (id: string): PinnerEndpoint => ({ id, kind: "kubo", url: `http://${id}.test/` });

describe("digestFromCid", () => {
  it("round-trips with cidFor and rejects anything that is not a raw sha2-256 CIDv1", () => {
    expect(digestFromCid(cid)).toMatch(/^0x[0-9a-f]{64}$/);
    expect(digestFromCid("bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku")).toBe(
      "0xe3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(digestFromCid(cid.toUpperCase())).toBeUndefined();
    expect(digestFromCid(cid.slice(0, -1))).toBeUndefined();
    expect(digestFromCid(`${cid}a`)).toBeUndefined();
    expect(digestFromCid("QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG")).toBeUndefined();
    expect(digestFromCid("../../etc/passwd")).toBeUndefined();
    // Last character carries padding bits; a non-canonical tail must not parse.
    expect(digestFromCid(`${cid.slice(0, -1)}${cid.endsWith("a") ? "b" : "a"}`)).not.toBe(digestFromCid(cid));
  });
});

describe("publishDocument", () => {
  it("meets the quorum when two of three zerodrop pinners store it, and reports the failure", async () => {
    const { client, seen } = fake((url) => (url.hostname === "bad.test" ? new Response("disk full", { status: 507 }) : new Response(JSON.stringify({ cid }), { status: 201 })));
    const result = await publishDocument({ bytes, cid, endpoints: [zd("a"), zd("b"), zd("bad")], client });
    expect(result.ok).toBe(true);
    expect(result.pinned).toBe(2);
    expect(result.minPins).toBe(2);
    expect(result.results.map((r) => [r.endpointId, r.ok])).toEqual([["a", true], ["b", true], ["bad", false]]);
    expect(result.results[2]!.error).toMatch(/507.*disk full/);
    expect(seen).toHaveLength(3);
    expect(seen.every((s) => s.method === "PUT" && s.url.endsWith(`/pin/${cid}`))).toBe(true);
    expect(client.requests.every((r) => r.role === "source")).toBe(true);
  });

  it("is not ok below minPins, and ok with minPins 1", async () => {
    const { client } = fake((url) => (url.hostname === "a.test" ? new Response("", { status: 201 }) : new Response("no", { status: 500 })));
    const endpoints = [zd("a"), zd("b"), zd("c")];
    expect((await publishDocument({ bytes, cid, endpoints, client })).ok).toBe(false);
    expect((await publishDocument({ bytes, cid, endpoints, client, minPins: 1 })).ok).toBe(true);
  });

  it("counts a thrown network error as one failed endpoint without throwing", async () => {
    const { client } = fake((url) => {
      if (url.hostname === "down.test") throw new TypeError("fetch failed");
      return new Response("", { status: 201 });
    });
    const result = await publishDocument({ bytes, cid, endpoints: [zd("a"), zd("down"), zd("b")], client });
    expect(result.ok).toBe(true);
    expect(result.results[1]).toMatchObject({ endpointId: "down", ok: false, error: "fetch failed" });
  });

  it("rejects a zerodrop pinner that echoes a different cid", async () => {
    const { client } = fake(() => new Response(JSON.stringify({ cid: cidFor(new Uint8Array([1])) }), { status: 201 }));
    const result = await publishDocument({ bytes, cid, endpoints: [zd("a")], client, minPins: 1 });
    expect(result.ok).toBe(false);
    expect(result.results[0]!.error).toMatch(/expected/);
  });

  it("kubo: posts multipart with the single-chunk raw-leaves options and accepts a matching Hash", async () => {
    const { client, seen } = fake(() => new Response(`${JSON.stringify({ Name: "document", Hash: cid, Size: "20" })}\n`));
    const result = await publishDocument({ bytes, cid, endpoints: [kubo("k1")], client, minPins: 1 });
    expect(result.ok).toBe(true);
    const url = new URL(seen[0]!.url);
    expect(url.pathname).toBe("/api/v0/add");
    expect(url.searchParams.get("cid-version")).toBe("1");
    expect(url.searchParams.get("raw-leaves")).toBe("true");
    expect(url.searchParams.get("pin")).toBe("true");
    expect(url.searchParams.get("chunker")).toBe("size-1048576");
    expect(seen[0]!.method).toBe("POST");
    expect(seen[0]!.body).toBeInstanceOf(FormData);
  });

  it("kubo: a Hash that differs from our cid is rejected", async () => {
    const other = cidFor(new TextEncoder().encode("something else"));
    const { client } = fake((url) => new Response(JSON.stringify({ Hash: url.hostname === "evil.test" ? other : cid })));
    const result = await publishDocument({ bytes, cid, endpoints: [kubo("evil"), kubo("good")], client, minPins: 1 });
    expect(result.results[0]).toMatchObject({ endpointId: "evil", ok: false });
    expect(result.results[0]!.error).toContain(other);
    expect(result.results[1]!.ok).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.pinned).toBe(1);
  });

  it("kubo: non-JSON and missing Hash are failures", async () => {
    const { client } = fake((url) => new Response(url.hostname === "html.test" ? "<html>" : "{}"));
    const result = await publishDocument({ bytes, cid, endpoints: [kubo("html"), kubo("empty")], client, minPins: 1 });
    expect(result.results.map((r) => r.ok)).toEqual([false, false]);
  });

  it("mixes kubo and zerodrop pinners", async () => {
    const { client } = fake((url) => (url.pathname.startsWith("/api/v0/add") ? new Response(JSON.stringify({ Hash: cid })) : new Response("", { status: 201 })));
    const result = await publishDocument({ bytes, cid, endpoints: [kubo("k"), zd("z")], client });
    expect(result.ok).toBe(true);
    expect(result.results.map((r) => r.kind)).toEqual(["kubo", "zerodrop"]);
  });

  it("refuses bad input before any request is made", async () => {
    const { client, seen } = fake(() => new Response("", { status: 201 }));
    const big = new Uint8Array(MAX_DOCUMENT_BYTES + 1).fill(7);
    await expect(publishDocument({ bytes: big, cid: cidFor(big), endpoints: [zd("a")], client })).rejects.toThrow(/1 MiB/);
    await expect(publishDocument({ bytes, cid: cidFor(new Uint8Array([9])), endpoints: [zd("a")], client })).rejects.toBeInstanceOf(PinInputError);
    await expect(publishDocument({ bytes, cid: "nope", endpoints: [zd("a")], client })).rejects.toThrow(/CIDv1/);
    await expect(publishDocument({ bytes: new Uint8Array(), cid, endpoints: [zd("a")], client })).rejects.toThrow(/empty/);
    expect(seen).toHaveLength(0);
  });

  it("accepts exactly 1 MiB", async () => {
    const edge = new Uint8Array(MAX_DOCUMENT_BYTES).fill(1);
    const { client } = fake(() => new Response("", { status: 201 }));
    const result = await publishDocument({ bytes: edge, cid: cidFor(edge), endpoints: [zd("a")], client, minPins: 1 });
    expect(result.ok).toBe(true);
  });
});

describe("keepOnline", () => {
  it("re-pins with role reader and returns the single result", async () => {
    const { client, seen } = fake(() => new Response("", { status: 201 }));
    const result = await keepOnline({ bytes, cid, endpoint: zd("mine"), client, session: "reader-1" });
    expect(result).toEqual({ endpointId: "mine", kind: "zerodrop", ok: true });
    expect(client.requests[0]).toMatchObject({ role: "reader", isolationKey: "reader:reader-1", method: "PUT" });
    expect(seen[0]!.url).toBe(`http://mine.test/pin/${cid}`);
  });

  it("will not push bytes that do not match the cid", async () => {
    const { client, seen } = fake(() => new Response("", { status: 201 }));
    await expect(keepOnline({ bytes: new Uint8Array([1, 2, 3]), cid, endpoint: zd("mine"), client })).rejects.toBeInstanceOf(PinInputError);
    expect(seen).toHaveLength(0);
  });

  it("reports a failing pinner instead of throwing", async () => {
    const { client } = fake(() => new Response("nope", { status: 400 }));
    const result = await keepOnline({ bytes, cid, endpoint: zd("mine"), client });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/400/);
  });
});
