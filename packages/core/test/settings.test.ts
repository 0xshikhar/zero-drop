import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SETTINGS,
  SETTINGS_STORAGE_KEY,
  _reloadSettingsForTests,
  describeTradeoff,
  getSettings,
  randomDelayMs,
  resetSettings,
  runDelayed,
  subscribe,
  updateSettings,
  type TradeoffKey,
} from "../src/settings";

class MemoryStorage {
  data = new Map<string, string>();
  getItem(k: string) {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.data.set(k, v);
  }
  removeItem(k: string) {
    this.data.delete(k);
  }
}

const realStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

function installStorage(storage: unknown) {
  Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true, writable: true });
}

afterEach(() => {
  if (realStorage) Object.defineProperty(globalThis, "localStorage", realStorage);
  else delete (globalThis as { localStorage?: unknown }).localStorage;
  vi.useRealTimers();
});

describe("settings store", () => {
  let storage: MemoryStorage;
  beforeEach(() => {
    storage = new MemoryStorage();
    installStorage(storage);
    resetSettings();
    _reloadSettingsForTests();
  });

  it("has the documented defaults", () => {
    expect(getSettings()).toEqual({
      directRpcForReader: false,
      skipRandomDelay: false,
      singleSidecar: false,
      networkMode: "anon",
      rpcUrls: [],
      sidecarUrls: [],
      pinnerEndpoints: [],
      maxDelayMinutes: 5,
    });
    expect(DEFAULT_SETTINGS.networkMode).toBe("anon");
  });

  it("persists updates to localStorage and reads them back after a reload", () => {
    updateSettings({
      skipRandomDelay: true,
      networkMode: "direct",
      rpcUrls: ["http://127.0.0.1:8545"],
      pinnerEndpoints: [{ id: "p1", kind: "kubo", url: "http://127.0.0.1:5001" }],
      maxDelayMinutes: 10,
    });
    expect(JSON.parse(storage.getItem(SETTINGS_STORAGE_KEY)!)).toMatchObject({ skipRandomDelay: true, networkMode: "direct" });
    _reloadSettingsForTests();
    expect(getSettings()).toMatchObject({
      skipRandomDelay: true,
      networkMode: "direct",
      rpcUrls: ["http://127.0.0.1:8545"],
      pinnerEndpoints: [{ id: "p1", kind: "kubo", url: "http://127.0.0.1:5001" }],
      maxDelayMinutes: 10,
    });
  });

  it("returns copies: mutating a result changes nothing", () => {
    const first = getSettings();
    first.rpcUrls.push("http://evil.example");
    first.directRpcForReader = true;
    expect(getSettings().rpcUrls).toEqual([]);
    expect(getSettings().directRpcForReader).toBe(false);
  });

  it("validates fields: bad values are ignored, urls are cleaned, the delay is clamped", () => {
    updateSettings({
      rpcUrls: [" https://a.example/rpc ", "https://a.example/rpc", "ftp://x.example", "not a url", 5 as unknown as string],
      sidecarUrls: ["javascript:alert(1)", "http://localhost:3000"],
      pinnerEndpoints: [
        { id: "ok", kind: "zerodrop", url: "https://pin.example" },
        { id: "ok", kind: "kubo", url: "https://dup.example" },
        { id: "bad-kind", kind: "s3" as never, url: "https://x.example" },
        { id: "bad-url", kind: "kubo", url: "file:///etc/passwd" },
      ],
      networkMode: "tor" as never,
      directRpcForReader: "yes" as never,
      maxDelayMinutes: 99_999,
    });
    expect(getSettings()).toMatchObject({
      rpcUrls: ["https://a.example/rpc"],
      sidecarUrls: ["http://localhost:3000"],
      pinnerEndpoints: [{ id: "ok", kind: "zerodrop", url: "https://pin.example" }],
      networkMode: "anon",
      directRpcForReader: false,
      maxDelayMinutes: 24 * 60,
    });
    updateSettings({ maxDelayMinutes: -3 });
    expect(getSettings().maxDelayMinutes).toBe(0);
    updateSettings({ maxDelayMinutes: Number.NaN });
    expect(getSettings().maxDelayMinutes).toBe(0);
  });

  it("falls back to defaults for corrupt or hostile stored data", () => {
    storage.setItem(SETTINGS_STORAGE_KEY, "{not json");
    _reloadSettingsForTests();
    expect(getSettings()).toEqual(DEFAULT_SETTINGS);
    storage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ networkMode: 7, rpcUrls: "x", maxDelayMinutes: "9", singleSidecar: true }));
    _reloadSettingsForTests();
    expect(getSettings()).toMatchObject({ networkMode: "anon", rpcUrls: [], maxDelayMinutes: 5, singleSidecar: true });
  });

  it("notifies subscribers on update and reset, and stops after unsubscribe", () => {
    const seen: boolean[] = [];
    const off = subscribe((s) => seen.push(s.singleSidecar));
    updateSettings({ singleSidecar: true });
    resetSettings();
    off();
    updateSettings({ singleSidecar: true });
    expect(seen).toEqual([true, false]);
  });

  it("a throwing subscriber does not stop the others", () => {
    const seen: number[] = [];
    const offA = subscribe(() => {
      throw new Error("bad listener");
    });
    const offB = subscribe(() => seen.push(1));
    updateSettings({ singleSidecar: true });
    expect(seen).toEqual([1]);
    offA();
    offB();
  });

  it("resetSettings restores defaults and removes the stored record", () => {
    updateSettings({ skipRandomDelay: true });
    resetSettings();
    expect(getSettings()).toEqual(DEFAULT_SETTINGS);
    expect(storage.getItem(SETTINGS_STORAGE_KEY)).toBeNull();
  });
});

describe("settings without usable storage", () => {
  it("keeps working in memory when localStorage throws on every access", () => {
    const hostile = {
      getItem() {
        throw new Error("denied");
      },
      setItem() {
        throw new Error("denied");
      },
      removeItem() {
        throw new Error("denied");
      },
    };
    installStorage(hostile);
    resetSettings();
    _reloadSettingsForTests();
    expect(getSettings()).toEqual(DEFAULT_SETTINGS);
    updateSettings({ skipRandomDelay: true });
    expect(getSettings().skipRandomDelay).toBe(true);
    expect(resetSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it("keeps working when the localStorage getter itself throws", () => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new Error("SecurityError");
      },
    });
    _reloadSettingsForTests();
    updateSettings({ singleSidecar: true });
    expect(getSettings().singleSidecar).toBe(true);
  });

  it("keeps working when there is no localStorage at all", () => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
    _reloadSettingsForTests();
    updateSettings({ maxDelayMinutes: 2 });
    expect(getSettings().maxDelayMinutes).toBe(2);
  });
});

describe("describeTradeoff", () => {
  const keys: TradeoffKey[] = ["directRpcForReader", "skipRandomDelay", "singleSidecar", "networkMode"];

  it("describes every toggle with an effect and a leak, and is pure", () => {
    for (const key of keys) {
      const t = describeTradeoff(key);
      expect(t.key).toBe(key);
      expect(t.effect.length).toBeGreaterThan(20);
      expect(t.leaks.length).toBeGreaterThan(20);
      t.leaks = "mutated";
      expect(describeTradeoff(key).leaks).not.toBe("mutated");
    }
    expect(describeTradeoff("directRpcForReader").leaks).toMatch(/IP address/);
    expect(describeTradeoff("skipRandomDelay").leaks).toMatch(/timing/);
    expect(describeTradeoff("networkMode").safeValue).toBe("anon");
    expect(describeTradeoff("singleSidecar").safeValue).toBe(false);
  });
});

describe("randomDelayMs", () => {
  const fixed = (value: number) => (array: Uint32Array) => {
    array[0] = value;
    return array;
  };
  const settings = { skipRandomDelay: false, maxDelayMinutes: 5 };

  it("is 0 when skipRandomDelay is set, without consuming randomness", () => {
    const rng = vi.fn(fixed(123));
    expect(randomDelayMs({ ...settings, skipRandomDelay: true }, rng)).toBe(0);
    expect(rng).not.toHaveBeenCalled();
  });

  it("is 0 when the maximum is 0", () => {
    expect(randomDelayMs({ skipRandomDelay: false, maxDelayMinutes: 0 }, fixed(99))).toBe(0);
  });

  it("maps the random draw into [0, max] and can reach both ends", () => {
    const max = 5 * 60_000;
    expect(randomDelayMs(settings, fixed(0))).toBe(0);
    // the largest accepted draw lands on max
    const n = max + 1;
    const limit = Math.floor(0x1_0000_0000 / n) * n;
    expect(randomDelayMs(settings, fixed(limit - 1))).toBe(max);
    for (const draw of [1, 12345, 2 ** 31, limit - 2]) {
      const v = randomDelayMs(settings, fixed(draw));
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(max);
    }
  });

  it("rejects draws from the biased tail and redraws", () => {
    const max = 5 * 60_000;
    const n = max + 1;
    const limit = Math.floor(0x1_0000_0000 / n) * n;
    const draws = [0xffff_ffff, limit, 7];
    const rng = vi.fn((array: Uint32Array) => {
      array[0] = draws.shift()!;
      return array;
    });
    expect(randomDelayMs(settings, rng)).toBe(7);
    expect(rng).toHaveBeenCalledTimes(3);
  });

  it("is roughly uniform with the real crypto source", () => {
    const buckets = new Array(10).fill(0) as number[];
    const max = 5 * 60_000;
    for (let i = 0; i < 20_000; i++) {
      const v = randomDelayMs(settings);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(max);
      buckets[Math.min(9, Math.floor((v / max) * 10))]!++;
    }
    for (const count of buckets) expect(count).toBeGreaterThan(1500); // expected 2000, sd about 42
  });

  it("does not hang on a stuck rng", () => {
    expect(randomDelayMs(settings, fixed(0xffff_ffff))).toBeLessThanOrEqual(5 * 60_000);
  });
});

describe("runDelayed", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("counts down once a second and resolves after the delay", async () => {
    const ticks: number[] = [];
    let done = false;
    const run = runDelayed({ delayMs: 3_000, onTick: (left) => ticks.push(left) }).then(() => (done = true));
    expect(ticks).toEqual([3_000]);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(done).toBe(false);
    expect(ticks).toEqual([3_000, 2_000, 1_000]);
    await vi.advanceTimersByTimeAsync(1_000);
    await run;
    expect(done).toBe(true);
    expect(ticks.at(-1)).toBe(0);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(ticks.at(-1)).toBe(0); // no ticks after completion
  });

  it("rejects with an AbortError when cancelled and stops ticking", async () => {
    const controller = new AbortController();
    const ticks: number[] = [];
    const run = runDelayed({ delayMs: 10_000, onTick: (left) => ticks.push(left), signal: controller.signal });
    const assertion = expect(run).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(2_000);
    controller.abort();
    await assertion;
    const count = ticks.length;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(ticks).toHaveLength(count);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects immediately if the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(runDelayed({ delayMs: 1_000, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("resolves at once for a zero delay", async () => {
    const onTick = vi.fn();
    await runDelayed({ delayMs: 0, onTick });
    expect(onTick).toHaveBeenCalledWith(0, 0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("works with randomDelayMs", async () => {
    const delay = randomDelayMs({ skipRandomDelay: false, maxDelayMinutes: 1 }, (a) => ((a[0] = 30_000), a));
    expect(delay).toBe(30_000);
    const run = runDelayed({ delayMs: delay });
    await vi.advanceTimersByTimeAsync(30_000);
    await run;
  });
});
