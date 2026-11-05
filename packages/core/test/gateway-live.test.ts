import { describe, expect, it } from "vitest";
import { cidFor, resolveDocument } from "../src/index";

/**
 * Live read-only check against a public IPFS gateway. Skipped unless ZD_LIVE=1 so CI and offline
 * runs stay deterministic. Reads only; nothing is published to the public network.
 */
const live = process.env.ZD_LIVE === "1";
const KNOWN_CID = "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku";
const GATEWAYS = (process.env.ZD_GATEWAYS ?? "https://gateway.pinata.cloud,https://ipfs.io,https://dweb.link").split(",");

describe.skipIf(!live)("public gateway resolve (live)", () => {
  it("resolves a known raw CID and verifies the bytes against the CID", async () => {
    const result = await resolveDocument({ cid: KNOWN_CID, endpoints: [], gateways: GATEWAYS, maxBytes: 1_048_576 });
    expect(result.ok).toBe(true);
    expect(cidFor(result.bytes!)).toBe(KNOWN_CID);
    console.log("resolved via", result.source, "attempts", JSON.stringify(result.attempts.map((a) => [a.status])));
  }, 40_000);

  it("never accepts a gateway answer for the wrong CID", async () => {
    const wrong = "bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy"; // sha256 of the empty input
    const result = await resolveDocument({ cid: wrong, endpoints: [], gateways: GATEWAYS, maxBytes: 1_048_576 });
    if (result.ok) expect(cidFor(result.bytes!)).toBe(wrong);
  }, 40_000);
});
