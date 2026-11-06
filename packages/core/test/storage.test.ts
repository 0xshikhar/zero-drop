import { describe, expect, it } from "vitest";
import { calculateStorageQuote, formatDataSize, FREE_TIER_BYTES } from "../src/storage";

describe("storage endowment quotes (Panama scale)", () => {
  it("quotes 0 ETH for files under 1 MiB", () => {
    const q1 = calculateStorageQuote(500_000);
    expect(q1.isFreeTier).toBe(true);
    expect(q1.costWei).toBe(0n);
    expect(q1.costEthFormatted).toContain("Free Tier");

    const qExact = calculateStorageQuote(FREE_TIER_BYTES);
    expect(qExact.isFreeTier).toBe(true);
    expect(qExact.costWei).toBe(0n);
  });

  it("quotes proportional endowment for files above 1 MiB", () => {
    // 51 MB dataset: excess = 50 MB
    const q = calculateStorageQuote(51 * 1024 * 1024, 365);
    expect(q.isFreeTier).toBe(false);
    expect(q.excessMb).toBe(50);
    expect(q.costWei).toBeGreaterThan(0n);
  });

  it("formats data sizes nicely across scales", () => {
    expect(formatDataSize(512)).toBe("512 B");
    expect(formatDataSize(500 * 1024)).toBe("500.0 KB");
    expect(formatDataSize(15 * 1024 * 1024)).toBe("15.0 MB");
    expect(formatDataSize(2.5 * 1024 * 1024 * 1024)).toBe("2.50 GB");
  });
});

