import { describe, expect, it } from "vitest";
import { cidFor, keepOnline, publishDocument, resolveDocument, type PinnerEndpoint } from "../src/index";

/**
 * Real Kubo node check. Skipped unless ZD_KUBO_API is set, e.g.
 *   ipfs daemon --offline   (API 127.0.0.1:15001, gateway 127.0.0.1:18080 in our scratch repo)
 *   ZD_KUBO_API=http://127.0.0.1:15001 ZD_KUBO_GATEWAY=http://127.0.0.1:18080 pnpm --filter @zerodrop/core test kubo-live
 * Use an offline node: this publishes nothing to the public network.
 */
const api = process.env.ZD_KUBO_API;
const gateway = process.env.ZD_KUBO_GATEWAY;

describe.skipIf(!api || !gateway)("real Kubo node (live)", () => {
  const kubo: PinnerEndpoint = { id: "kubo", kind: "kubo", url: api!, gatewayUrl: gateway };
  const bytes = new TextEncoder().encode(`ZeroDrop kubo check ${Date.now()}\n`);
  const cid = cidFor(bytes);

  it("pins through the real add API and the returned CID equals our raw CIDv1", async () => {
    const result = await publishDocument({ bytes, cid, endpoints: [kubo], minPins: 1 });
    expect(result.results[0]?.error).toBeUndefined();
    expect(result.ok).toBe(true);
  });

  it("resolves the pinned bytes back through the Kubo gateway, hash-checked", async () => {
    const result = await resolveDocument({ cid, endpoints: [kubo] });
    expect(result.ok).toBe(true);
    expect(new TextDecoder().decode(result.bytes)).toContain("kubo check");
  });

  it("keepOnline re-pins a document", async () => {
    const other = new TextEncoder().encode(`reader re-pin ${Date.now()}\n`);
    const otherCid = cidFor(other);
    const result = await keepOnline({ bytes: other, cid: otherCid, endpoint: kubo });
    expect(result.ok).toBe(true);
  });

  it("a one-chunk-sized document (exactly 1 MiB) still produces our raw CID", async () => {
    const big = new Uint8Array(1_048_576).map((_, i) => (i * 31 + 7) & 255);
    const bigCid = cidFor(big);
    const result = await publishDocument({ bytes: big, cid: bigCid, endpoints: [kubo], minPins: 1 });
    expect(result.results[0]?.error).toBeUndefined();
    expect(result.ok).toBe(true);
  });
});
