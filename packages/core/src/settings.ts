/**
 * Persisted user settings (docs/features.md F12, F13; docs/architecture.md section 7).
 *
 * Storage: localStorage under one key, every access inside try/catch. When localStorage is missing or
 * throws (private mode, blocked storage, Node, tests), settings live in memory for the session only.
 * Values read back from storage are re-validated; anything malformed falls back to the default for
 * that field, so a hand-edited or old record cannot crash the app.
 *
 * Privacy note for the UI: `rpcUrls`, `sidecarUrls` and `pinnerEndpoints` are stored in clear text in
 * the browser profile. If an URL carries an API key, so does the stored copy.
 */

import type { PinnerEndpoint } from "./pin";

export type SettingsNetworkMode = "anon" | "direct";

export type Settings = {
  /** Readers talk to the RPC directly. Fast, leaks the reader's IP to the RPC. */
  directRpcForReader: boolean;
  /** Submit immediately instead of after a random delay. */
  skipRandomDelay: boolean;
  /** Send to one sidecar instead of fanning out to several. */
  singleSidecar: boolean;
  /** "anon" routes through Anon-RPC. "direct" is for local dev chains and exposes the machine's IP. */
  networkMode: SettingsNetworkMode;
  rpcUrls: string[];
  sidecarUrls: string[];
  pinnerEndpoints: PinnerEndpoint[];
  /** Upper bound of the random submission delay, in minutes. */
  maxDelayMinutes: number;
};

export const SETTINGS_STORAGE_KEY = "zerodrop.settings.v1";
export const MAX_DELAY_MINUTES_LIMIT = 24 * 60;

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  directRpcForReader: false,
  skipRandomDelay: false,
  singleSidecar: false,
  networkMode: "anon",
  rpcUrls: [],
  sidecarUrls: [],
  pinnerEndpoints: [],
  maxDelayMinutes: 5,
});

export type SettingsListener = (settings: Settings) => void;

// ---------------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------------

function cleanBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** Trims, drops non-http(s) and duplicate entries, keeps order. */
function cleanUrls(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return [...fallback];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const url = item.trim();
    if (!isHttpUrl(url) || seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

function cleanPinners(value: unknown, fallback: PinnerEndpoint[]): PinnerEndpoint[] {
  if (!Array.isArray(value)) return fallback.map((p) => ({ ...p }));
  const ids = new Set<string>();
  const out: PinnerEndpoint[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) continue;
    const { id, kind, url, gatewayUrl } = item as Record<string, unknown>;
    if (typeof id !== "string" || id.trim() === "" || ids.has(id)) continue;
    if (kind !== "kubo" && kind !== "zerodrop") continue;
    if (typeof url !== "string" || !isHttpUrl(url.trim())) continue;
    ids.add(id);
    // Kubo serves its read gateway on a different port, so the gateway URL has to survive a save/load round trip.
    const gateway = typeof gatewayUrl === "string" && isHttpUrl(gatewayUrl.trim()) ? gatewayUrl.trim() : undefined;
    out.push({ id, kind, url: url.trim(), ...(gateway ? { gatewayUrl: gateway } : {}) });
  }
  return out;
}

function cleanDelay(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(value, 0), MAX_DELAY_MINUTES_LIMIT);
}

function cleanMode(value: unknown, fallback: SettingsNetworkMode): SettingsNetworkMode {
  return value === "anon" || value === "direct" ? value : fallback;
}

/** Merges `input` over `base`, validating each field; invalid fields keep the value from `base`. */
function sanitize(input: unknown, base: Settings): Settings {
  const raw = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
  return {
    directRpcForReader: cleanBoolean(raw.directRpcForReader, base.directRpcForReader),
    skipRandomDelay: cleanBoolean(raw.skipRandomDelay, base.skipRandomDelay),
    singleSidecar: cleanBoolean(raw.singleSidecar, base.singleSidecar),
    networkMode: cleanMode(raw.networkMode, base.networkMode),
    rpcUrls: "rpcUrls" in raw ? cleanUrls(raw.rpcUrls, base.rpcUrls) : [...base.rpcUrls],
    sidecarUrls: "sidecarUrls" in raw ? cleanUrls(raw.sidecarUrls, base.sidecarUrls) : [...base.sidecarUrls],
    pinnerEndpoints: "pinnerEndpoints" in raw ? cleanPinners(raw.pinnerEndpoints, base.pinnerEndpoints) : base.pinnerEndpoints.map((p) => ({ ...p })),
    maxDelayMinutes: cleanDelay(raw.maxDelayMinutes, base.maxDelayMinutes),
  };
}

function cloneSettings(settings: Settings): Settings {
  return {
    ...settings,
    rpcUrls: [...settings.rpcUrls],
    sidecarUrls: [...settings.sidecarUrls],
    pinnerEndpoints: settings.pinnerEndpoints.map((p) => ({ ...p })),
  };
}

// ---------------------------------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------------------------------

function storage(): Storage | undefined {
  try {
    return globalThis.localStorage ?? undefined;
  } catch {
    return undefined;
  }
}

let current: Settings | undefined;
const listeners = new Set<SettingsListener>();
let storageHooked = false;

function load(): Settings {
  const base = cloneSettings(DEFAULT_SETTINGS as Settings);
  try {
    const raw = storage()?.getItem(SETTINGS_STORAGE_KEY);
    if (raw) return sanitize(JSON.parse(raw), base);
  } catch {
    // unreadable storage or corrupt JSON: use defaults
  }
  return base;
}

function persist(settings: Settings): void {
  try {
    storage()?.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // storage full or blocked: the in-memory copy still holds the value for this session
  }
}

function notify(): void {
  const snapshot = cloneSettings(current ?? load());
  for (const listener of [...listeners]) {
    try {
      listener(snapshot);
    } catch {
      // a broken listener must not break the others
    }
  }
}

/** Picks up changes made in another tab. Hooked once, only where `addEventListener` exists. */
function hookStorageEvents(): void {
  if (storageHooked) return;
  storageHooked = true;
  try {
    globalThis.addEventListener?.("storage", (event) => {
      if ((event as StorageEvent).key !== null && (event as StorageEvent).key !== SETTINGS_STORAGE_KEY) return;
      current = load();
      notify();
    });
  } catch {
    // no window
  }
}

/** The current settings (a copy: mutating it changes nothing). */
export function getSettings(): Settings {
  if (!current) current = load();
  return cloneSettings(current);
}

/**
 * Applies a partial update. Each field is validated; an invalid field is ignored and keeps its
 * previous value. Returns the new settings and notifies subscribers.
 */
export function updateSettings(patch: Partial<Settings>): Settings {
  if (!current) current = load();
  current = sanitize({ ...current, ...patch }, current);
  persist(current);
  notify();
  return cloneSettings(current);
}

/** Back to defaults, and removes the stored record. */
export function resetSettings(): Settings {
  current = cloneSettings(DEFAULT_SETTINGS as Settings);
  try {
    storage()?.removeItem(SETTINGS_STORAGE_KEY);
  } catch {
    // ignore
  }
  notify();
  return cloneSettings(current);
}

/** Calls `listener` after every change (including changes from another tab). Returns unsubscribe. */
export function subscribe(listener: SettingsListener): () => void {
  hookStorageEvents();
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export const subscribeSettings = subscribe;

/** Test seam: forget the cached copy so the next read reloads from storage. */
export function _reloadSettingsForTests(): void {
  current = undefined;
}

// ---------------------------------------------------------------------------------------------------
// What each toggle leaks (F13)
// ---------------------------------------------------------------------------------------------------

export type TradeoffKey = "directRpcForReader" | "skipRandomDelay" | "singleSidecar" | "networkMode";

export type Tradeoff = {
  key: TradeoffKey;
  title: string;
  /** The value of the setting that is the privacy-preserving default. */
  safeValue: boolean | SettingsNetworkMode;
  /** What turning the toggle on (or, for networkMode, choosing "direct") does. */
  effect: string;
  /** What it leaks, and to whom. Plain statements, no reassurance. */
  leaks: string;
  /** Rough size of the speed gain. Estimates from docs/architecture.md, not measurements. */
  speed?: string;
};

const TRADEOFFS: Readonly<Record<TradeoffKey, Tradeoff>> = {
  directRpcForReader: {
    key: "directRpcForReader",
    title: "Direct RPC for readers",
    safeValue: false,
    effect: "Reader checks (loading a disclosure, the on-chain proof) skip Anon-RPC and go straight to the RPC endpoint.",
    leaks:
      "The RPC operator sees the reader's IP address and which disclosure is being opened, and can link the two. Anyone watching the reader's network sees the same.",
    speed: "About 45 ms instead of about 1 s per call (estimate).",
  },
  skipRandomDelay: {
    key: "skipRandomDelay",
    title: "Skip the random delay",
    safeValue: false,
    effect: "The disclosure is submitted the moment the source confirms, with no waiting period.",
    leaks:
      "The time of posting stays close to the time the source joined the group or opened the app, which makes timing correlation easier for anyone who sees both events.",
    speed: "Posts immediately instead of after up to the configured maximum delay.",
  },
  singleSidecar: {
    key: "singleSidecar",
    title: "Single sidecar",
    safeValue: false,
    effect: "The transaction goes to one sidecar instead of several in parallel.",
    leaks:
      "One sidecar operator can see, delay or drop the submission, and learns the submission time. Fan-out to several sidecars limits that; with one there is no redundancy against censorship.",
    speed: "Less fan-out work; mainly for debugging.",
  },
  networkMode: {
    key: "networkMode",
    title: "Direct network (no Anon-RPC)",
    safeValue: "anon",
    effect: 'Choosing "direct" sends every request from this machine without Anon-RPC. Meant for local development chains.',
    leaks:
      "Every endpoint (RPC, sidecar, pinner) sees this machine's IP address, and a network observer sees who talks to them. Nothing hides the poster or the reader at the network level.",
    speed: "No Tor start-up wait and no circuit latency.",
  },
};

/** Pure: what a toggle does and leaks, for the settings screen. */
export function describeTradeoff(key: TradeoffKey): Tradeoff {
  return { ...TRADEOFFS[key] };
}

// ---------------------------------------------------------------------------------------------------
// Random submission delay (F12)
// ---------------------------------------------------------------------------------------------------

/** Same shape as crypto.getRandomValues for a Uint32Array. */
export type RandomFill = (array: Uint32Array) => Uint32Array;

const defaultRng: RandomFill = (array) => crypto.getRandomValues(array);

/** Uniform integer in [0, maxInclusive] from 32-bit draws, rejecting the biased tail. */
function uniformInt(maxInclusive: number, rng: RandomFill): number {
  if (maxInclusive <= 0) return 0;
  const n = maxInclusive + 1;
  const limit = Math.floor(0x1_0000_0000 / n) * n;
  const buffer = new Uint32Array(1);
  // The loop ends within a couple of draws for any sane rng; the cap only protects against a stuck one.
  for (let attempt = 0; attempt < 32; attempt++) {
    const draw = rng(buffer)[0] ?? 0;
    if (draw < limit) return draw % n;
  }
  return (buffer[0] ?? 0) % n;
}

/**
 * Delay before submission in ms: uniform over [0, maxDelayMinutes * 60_000], or 0 when
 * `skipRandomDelay` is set. `rng` defaults to crypto.getRandomValues.
 */
export function randomDelayMs(
  settings: Pick<Settings, "skipRandomDelay" | "maxDelayMinutes">,
  rng: RandomFill = defaultRng,
): number {
  if (settings.skipRandomDelay) return 0;
  const maxMs = Math.floor(Math.max(0, settings.maxDelayMinutes) * 60_000);
  return uniformInt(maxMs, rng);
}

export type RunDelayedOptions = {
  delayMs: number;
  /** Called once now and then about once a second with the time left (0 on the last call). */
  onTick?: (remainingMs: number, totalMs: number) => void;
  /** Aborting cancels the countdown and rejects with an AbortError. */
  signal?: AbortSignal;
};

const TICK_MS = 1000;

/**
 * Counts down `delayMs`, then resolves. Rejects with an AbortError DOMException if `signal` aborts first.
 * Remaining time is computed from the clock at each tick, so a throttled background tab shows the right
 * number when it wakes, but browsers may still fire the final timer late.
 */
export function runDelayed({ delayMs, onTick, signal }: RunDelayedOptions): Promise<void> {
  const totalMs = Math.max(0, Math.floor(delayMs));
  const aborted = () => new DOMException("The delay was cancelled", "AbortError");
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(aborted());
      return;
    }
    const deadline = Date.now() + totalMs;
    const remaining = () => Math.max(0, deadline - Date.now());
    onTick?.(totalMs, totalMs);
    if (totalMs === 0) {
      resolve();
      return;
    }
    const cleanup = () => {
      clearTimeout(done);
      clearInterval(ticker);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(aborted());
    };
    const done = setTimeout(() => {
      cleanup();
      onTick?.(0, totalMs);
      resolve();
    }, totalMs);
    const ticker = setInterval(() => {
      const left = remaining();
      if (left > 0) onTick?.(left, totalMs);
    }, TICK_MS);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
