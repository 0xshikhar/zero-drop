/**
 * Network boundary for @zerodrop/core.
 *
 * TRUST STATUS (keep this honest; the UI reads it through statusLabels() in mode.ts):
 * - `network` (the module singleton) STARTS in DIRECT mode: globalThis.fetch from the machine running
 *   this code, so the RPC endpoint and the sidecar see that machine's IP address. The app must call
 *   `configureNetwork({ mode: "anon", ... })` at startup to route through Anon-RPC. Nothing switches
 *   mode by itself, and nothing falls back from anon to direct by itself.
 * - AnonRpcTransport drives @anon-rpc/browser-harness 0.4.0 (AnonRpcWorker): a hash-pinned anon-client
 *   (the Tor client, "tor-js") runs in a Web Worker inside a null-origin sandboxed iframe and exposes an
 *   anonymised `fetch`. When the worker is not ready, fails to boot, or times out, requests REJECT with
 *   an AnonRpcError. They are never sent directly. Direct is only used when the mode is explicitly
 *   "direct".
 * - NOT TESTED HERE: the sandbox this was written in has no Tor, no browser and no network, so the real
 *   boot (specifier read, bundle fetch + hash check, iframe, Tor bootstrap, circuits) has never run
 *   from this file. The tests inject a fake worker through `workerFactory`. Which anon-client bundle
 *   (specifier contract address) to use, and what `config` it expects, is deployment input that this
 *   repo does not contain yet.
 * - One unavoidable direct request: the harness reads the on-chain specifier through a "bootstrap" RPC
 *   provider BEFORE the anonymous worker exists. That one request (an eth_call, plus the fetch of the
 *   anon-client bundle by the harness itself) is not anonymous. configureNetwork() counts the eth_call
 *   as a direct request in the traffic meter. The harness's own bundle fetch is not visible to this
 *   code (it uses globalThis.fetch inside the library), so it is NOT in the meter; the page CSP is what
 *   limits where it can go.
 * - Isolation keys (`<role>:<session>`) are sent to the worker as `anonOptions.isolationKey` on every
 *   request. Per the anon-rpc spec (9.3) they only ask that different keys not be linkable; whether
 *   that is honoured depends on the anon-client bundle, which this code cannot check.
 * - The request log holds URLs with the query string removed, so RPC keys in query strings are not
 *   copied into the records.
 */

import type { PlainValue, RpcProvider } from "@anon-rpc/browser-harness";

export type RequestRole = "source" | "reader" | "issuer";
/** How a request left this machine. Only "anonymous" hides the IP address. */
export type Route = "direct" | "anonymous";
export type NetworkMode = "anon" | "direct";

/** Identifies who a request is for. `isolationKey` is always `<role>:<session>`, never per call. */
export type RequestContext = { role: RequestRole; session: string; isolationKey: string };
export type Transport = (input: RequestInfo | URL, init?: RequestInit, ctx?: RequestContext) => Promise<Response>;

export const DEFAULT_TIMEOUT_MS = 60_000;
/** How long the anon worker may take to become ready before boot is declared failed. A guess: Tor can need a while. */
export const DEFAULT_READY_TIMEOUT_MS = 120_000;

/** Thrown by transports that are declared but not configured. */
export class NotConfiguredError extends Error {
  readonly code = "NOT_CONFIGURED" as const;
  constructor(message = "Anon-RPC is not configured (no specifier address)") {
    super(message);
    this.name = "NotConfiguredError";
  }
}

export type AnonErrorCode = "ANON_BOOT_TIMEOUT" | "ANON_BOOT_FAILED" | "ANON_UNAVAILABLE" | "ANON_CLOSED";

/** `anonOptions` is the harness' per-call extension of RequestInit (anon-rpc spec 9.3). */
type AnonInit = RequestInit & { anonOptions?: { isolationKey?: string } };

/** The anonymous path is not usable. The request was NOT sent anywhere. */
export class AnonRpcError extends Error {
  readonly code: AnonErrorCode;
  constructor(code: AnonErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AnonRpcError";
    this.code = code;
  }
}

export type RequestRecord = {
  /** Origin and path only. The query string is dropped. */
  url: string;
  method: string;
  role: RequestRole;
  session: string;
  /** `<role>:<session>`. Sent to the anon worker as anonOptions.isolationKey. */
  isolationKey: string;
  route: Route;
  startedAt: number;
  durationMs: number;
  ok: boolean;
  error?: string;
};

export type TrafficSummary = { total: number; anonymous: number; direct: number };

export function isolationKeyFor(role: RequestRole, session = "default"): string {
  return `${role}:${session}`;
}

function describeUrl(input: RequestInfo | URL): string {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  try {
    const url = new URL(raw);
    return `${url.origin}${url.pathname}`;
  } catch {
    return raw.split("?")[0] ?? raw;
  }
}

/**
 * Wraps a transport so that a request which does not finish within `timeoutMs` is aborted.
 * A signal already present in `init` is honoured too.
 */
export function withTimeout(transport: Transport, timeoutMs = DEFAULT_TIMEOUT_MS): Transport {
  return async (input, init = {}, ctx) => {
    const controller = new AbortController();
    const outer = init.signal ?? undefined;
    const onOuterAbort = () => controller.abort(outer?.reason);
    if (outer?.aborted) controller.abort(outer.reason);
    outer?.addEventListener("abort", onOuterAbort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error(`Request timed out after ${timeoutMs} ms`)), timeoutMs);
    try {
      return await transport(input, { ...init, signal: controller.signal }, ctx);
    } finally {
      clearTimeout(timer);
      outer?.removeEventListener("abort", onOuterAbort);
    }
  };
}

/** Direct transport: globalThis.fetch with a 60 s timeout. Looked up at call time so tests can stub it. */
export const directTransport: Transport = withTimeout((input, init) => globalThis.fetch(input, init));

// ---------------------------------------------------------------------------------------------------
// Boot state
// ---------------------------------------------------------------------------------------------------

export type BootState =
  | { status: "idle" }
  /** `step` is the last worker log line (or a fixed label before the first line). `percent` is parsed from log lines when one contains "NN%". */
  | { status: "booting"; step: string; percent?: number; startedAt: number }
  | { status: "ready"; readyAt: number; bootMs: number }
  | { status: "failed"; reason: string; code: AnonErrorCode | "NOT_CONFIGURED"; at: number };

export type BootListener = (state: BootState) => void;

export type BootLogEntry = { at: number; level: string; text: string };

/** What AnonRpcTransport needs from a worker. @anon-rpc/browser-harness' AnonRpcWorker satisfies it. */
export interface AnonWorkerLike {
  ready: Promise<void>;
  fetch(input: RequestInfo | URL, init?: AnonInit): Promise<Response>;
  /** Next worker log line; rejects once the worker has failed or closed. Optional: a worker without it just reports no progress. */
  acceptLog?(opts?: { signal?: AbortSignal }): Promise<{ level: string; args: unknown[] }>;
  close(): void;
}

export type AnonWorkerInit = {
  address: string;
  config?: PlainValue;
  iframeUrl?: string;
  preExisting: { rpcProvider: RpcProvider };
};

export type AnonRpcOptions = {
  /** Address of the IWorkerSpecifier contract that pins the anon-client bundle hash. Required to boot. */
  address?: string;
  /** Opaque, plain-value config delivered to the worker as `anonRpcWorker.config` (schema belongs to the bundle). */
  config?: PlainValue;
  /**
   * Same-origin URL of a bootstrap page (see the harness README, "Strict Content Security Policies").
   * Leave unset to use the harness' default `srcdoc` iframe, which is what the single-file build uses.
   */
  iframeUrl?: string;
  /** EIP-1193-style provider used ONLY to read the specifier, before the anonymous worker exists. Not anonymous. */
  rpcProvider?: RpcProvider;
  /** Alternative to `rpcProvider`: a JSON-RPC HTTP URL. Not anonymous, see the file header. */
  bootstrapRpcUrl?: string;
  /** fetch used for `bootstrapRpcUrl`. Defaults to globalThis.fetch. configureNetwork() passes one that counts as direct traffic. */
  bootstrapFetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  /** Ready timeout. Default 120 s. */
  readyTimeoutMs?: number;
  /** Per-request timeout once ready. Default 60 s. */
  requestTimeoutMs?: number;
  /** Test seam: builds the worker. The default dynamically imports @anon-rpc/browser-harness (browser only). */
  workerFactory?: (init: AnonWorkerInit) => AnonWorkerLike | Promise<AnonWorkerLike>;
};

const MAX_LOG_ENTRIES = 100;
const BOOT_STEP_INITIAL = "Starting the sandboxed Anon-RPC worker";

function httpRpcProvider(url: string, doFetch: NonNullable<AnonRpcOptions["bootstrapFetch"]>): RpcProvider {
  let id = 0;
  return {
    async request({ method, params }) {
      const response = await doFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params: params ?? [] }),
      });
      if (!response.ok) throw new Error(`bootstrap RPC answered HTTP ${response.status}`);
      const json = (await response.json()) as { result?: unknown; error?: { message?: string } };
      if (json.error) throw new Error(json.error.message ?? "bootstrap RPC error");
      return json.result;
    },
  };
}

async function defaultWorkerFactory(init: AnonWorkerInit): Promise<AnonWorkerLike> {
  const { AnonRpcWorker } = await import("@anon-rpc/browser-harness");
  return new AnonRpcWorker(init);
}

function renderLogArg(arg: unknown): string {
  if (typeof arg === "string") return arg;
  if (arg instanceof Uint8Array) return `<${arg.byteLength} bytes>`;
  try {
    return JSON.stringify(arg) ?? String(arg);
  } catch {
    return String(arg);
  }
}

/** Pulls a bootstrap percentage out of a worker log line ("Bootstrapped 45% (loading_descriptors)"). Heuristic. */
export function parseBootPercent(text: string): number | undefined {
  const match = /(\d{1,3})\s*%/.exec(text);
  if (!match) return undefined;
  const value = Number(match[1]);
  return value >= 0 && value <= 100 ? value : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("aborted", "AbortError");
}

/** Rejects early if `signal` aborts; does not cancel the underlying promise. */
function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal | null): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Anonymous transport over the Anon-RPC browser harness. Lazy: nothing boots until `boot()` or the first
 * `fetch`. A failed boot is sticky (every request rejects with the same reason) until `retry()`.
 * Requests are never sent anywhere else.
 */
export class AnonRpcTransport {
  readonly route: Route = "anonymous";

  private _state: BootState = { status: "idle" };
  private listeners = new Set<BootListener>();
  private logEntries: BootLogEntry[] = [];
  private worker?: AnonWorkerLike;
  private bootPromise?: Promise<AnonWorkerLike>;
  private generation = 0;
  private closed = false;

  constructor(private readonly options: AnonRpcOptions = {}) {}

  get state(): BootState {
    return this._state;
  }

  /** Recent worker log lines (up to 100), oldest first. Reading the worker's logs stops the harness echoing them to the console. */
  logs(): readonly BootLogEntry[] {
    return this.logEntries;
  }

  subscribe(listener: BootListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Starts the boot if it has not started. Resolves when the worker is ready; rejects with the failure reason. */
  async boot(): Promise<void> {
    await this.ensureWorker();
  }

  /** Throws away a failed (or running) worker and boots again. */
  retry(): Promise<void> {
    this.teardown();
    this.closed = false;
    this.setState({ status: "idle" });
    return this.boot();
  }

  /** Closes the worker. Later requests reject with ANON_CLOSED until `retry()`. */
  close(): void {
    this.teardown();
    this.closed = true;
    this.setState({ status: "idle" });
  }

  /** The transport function. Bound, so it can be passed around as a free function. */
  readonly fetch: Transport = async (input, init = {}, ctx) => {
    const worker = await raceAbort(this.ensureWorker(), init.signal);
    // One key per role and session. Never random, never per call: a fresh circuit per call stalls Tor.
    const given = (init as AnonInit).anonOptions?.isolationKey;
    const isolationKey = ctx?.isolationKey ?? given ?? isolationKeyFor("reader");
    const send: Transport = (url, requestInit) =>
      worker.fetch(url, { ...requestInit, anonOptions: { ...(requestInit as AnonInit | undefined)?.anonOptions, isolationKey } });
    return withTimeout(send, this.options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS)(input, init, ctx);
  };

  // -------------------------------------------------------------------------------------------------

  private ensureWorker(): Promise<AnonWorkerLike> {
    if (this.closed) {
      return Promise.reject(new AnonRpcError("ANON_CLOSED", "Anon-RPC was closed; request not sent"));
    }
    if (this._state.status === "failed" && this.bootPromise === undefined) {
      // The worker died after it was ready (see pumpLogs). Stay failed until retry().
      return Promise.reject(this.unavailable("ANON_UNAVAILABLE", this._state.reason));
    }
    if (!this.bootPromise) {
      this.bootPromise = this.startBoot();
      // The promise is returned to callers, who observe the rejection. This branch only keeps it from
      // being reported as unhandled if nobody is waiting.
      this.bootPromise.catch(() => {});
    }
    return this.bootPromise.catch((error: unknown) => {
      if (error instanceof NotConfiguredError) throw error;
      if (error instanceof AnonRpcError) {
        if (error.code === "ANON_CLOSED") throw error;
        throw this.unavailable(error.code, error.message, error);
      }
      throw this.unavailable("ANON_BOOT_FAILED", errorMessage(error), error);
    });
  }

  private unavailable(code: AnonErrorCode, reason: string, cause?: unknown): AnonRpcError {
    return new AnonRpcError(
      code,
      `Anon-RPC is unavailable (${reason}). The request was NOT sent: this app does not fall back to a direct ` +
        `connection. Retry, or switch the network mode to "direct" in settings (that exposes your IP address).`,
      { cause },
    );
  }

  private async startBoot(): Promise<AnonWorkerLike> {
    const generation = ++this.generation;
    const startedAt = Date.now();
    const { address } = this.options;
    if (!address) {
      const error = new NotConfiguredError();
      this.fail(generation, "NOT_CONFIGURED", error.message);
      throw error;
    }
    this.setState({ status: "booting", step: BOOT_STEP_INITIAL, startedAt });

    const provider =
      this.options.rpcProvider ??
      (this.options.bootstrapRpcUrl
        ? httpRpcProvider(this.options.bootstrapRpcUrl, this.options.bootstrapFetch ?? ((i, o) => globalThis.fetch(i, o)))
        : undefined);
    if (!provider) {
      const error = new NotConfiguredError("Anon-RPC needs a bootstrap RPC (rpcProvider or bootstrapRpcUrl) to read the specifier");
      this.fail(generation, "NOT_CONFIGURED", error.message);
      throw error;
    }

    let worker: AnonWorkerLike | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const factory = this.options.workerFactory ?? defaultWorkerFactory;
      const init: AnonWorkerInit = {
        address,
        preExisting: { rpcProvider: provider },
        ...(this.options.config !== undefined ? { config: this.options.config } : {}),
        ...(this.options.iframeUrl ? { iframeUrl: this.options.iframeUrl } : {}),
      };
      worker = await factory(init);
      if (generation !== this.generation) {
        worker.close();
        throw new AnonRpcError("ANON_CLOSED", "Anon-RPC boot was superseded");
      }
      this.worker = worker;
      this.pumpLogs(worker, generation);

      const timeoutMs = this.options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new AnonRpcError("ANON_BOOT_TIMEOUT", `Anon-RPC did not become ready within ${Math.round(timeoutMs / 1000)} s`)),
          timeoutMs,
        );
      });
      await Promise.race([worker.ready, timeout]);
      if (generation !== this.generation) throw new AnonRpcError("ANON_CLOSED", "Anon-RPC boot was superseded");
      const readyAt = Date.now();
      this.setState({ status: "ready", readyAt, bootMs: readyAt - startedAt });
      return worker;
    } catch (error) {
      if (generation === this.generation) {
        try {
          worker?.close();
        } catch {
          // already dead
        }
        const code = error instanceof AnonRpcError ? error.code : "ANON_BOOT_FAILED";
        this.fail(generation, code, errorMessage(error));
      }
      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** Marks the boot failed. The failure stays until retry(): every request rejects. */
  private fail(generation: number, code: AnonErrorCode | "NOT_CONFIGURED", reason: string): void {
    if (generation !== this.generation) return;
    this.setState({ status: "failed", reason, code, at: Date.now() });
  }

  private teardown(): void {
    this.generation++;
    try {
      this.worker?.close();
    } catch {
      // already dead
    }
    this.worker = undefined;
    this.bootPromise = undefined;
  }

  /** Feeds worker log lines into progress and the log buffer; a rejection after ready means the worker died. */
  private pumpLogs(worker: AnonWorkerLike, generation: number): void {
    if (!worker.acceptLog) return;
    void (async () => {
      for (;;) {
        const entry = await worker.acceptLog!();
        if (generation !== this.generation) return;
        const text = entry.args.map(renderLogArg).join(" ");
        this.logEntries.push({ at: Date.now(), level: entry.level, text });
        if (this.logEntries.length > MAX_LOG_ENTRIES) this.logEntries.splice(0, this.logEntries.length - MAX_LOG_ENTRIES);
        const state = this._state;
        if (state.status === "booting") {
          const parsed = parseBootPercent(text);
          const percent = parsed === undefined ? state.percent : Math.max(parsed, state.percent ?? 0);
          this.setState({ status: "booting", step: text.slice(0, 160), percent, startedAt: state.startedAt });
        }
      }
    })().catch((error: unknown) => {
      if (generation !== this.generation) return;
      const status = this._state.status;
      if (status === "ready" || status === "booting") {
        // The harness' logs reject once the worker has failed or closed.
        this.bootPromise = undefined;
        this.fail(generation, "ANON_BOOT_FAILED", `worker stopped: ${errorMessage(error)}`);
      }
    });
  }

  private setState(next: BootState): void {
    const prev = this._state;
    if (
      prev.status === "booting" &&
      next.status === "booting" &&
      prev.step === next.step &&
      prev.percent === next.percent
    ) {
      return;
    }
    this._state = next;
    for (const listener of [...this.listeners]) {
      try {
        listener(next);
      } catch {
        // a broken listener must not break the transport
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------------
// NetworkClient
// ---------------------------------------------------------------------------------------------------

/** A transport the client can switch to, with boot state for the UI. AnonRpcTransport is one. */
export interface BootableTransport {
  readonly route: Route;
  readonly fetch: Transport;
  readonly state: BootState;
  subscribe(listener: BootListener): () => void;
  boot(): Promise<void>;
}

const MAX_RECORDS = 1000;

type ActiveTransport = { transport: Transport; route: Route; handle?: BootableTransport };

/** Injectable network boundary. Counts every request by route. */
export class NetworkClient {
  private records: RequestRecord[] = [];
  private totals: TrafficSummary = { total: 0, anonymous: 0, direct: 0 };
  private active: ActiveTransport;
  private bootListeners = new Set<BootListener>();
  private unsubscribeHandle?: () => void;

  constructor(
    transport: Transport = directTransport,
    options: { route?: Route } = {},
  ) {
    this.active = { transport, route: options.route ?? "direct" };
  }

  get route(): Route {
    return this.active.route;
  }

  get mode(): NetworkMode {
    return this.active.route === "anonymous" ? "anon" : "direct";
  }

  /** Boot state of the active transport. A plain (direct) transport has no boot and reports "idle". */
  get bootState(): BootState {
    return this.active.handle?.state ?? { status: "idle" };
  }

  /** The most recent requests (capped at 1000). Totals in summary() are never truncated. */
  get requests(): readonly RequestRecord[] {
    return this.records;
  }

  /**
   * Switches the active transport. Pass a plain function with the route it takes ("direct" unless you
   * know it is anonymous), or a BootableTransport such as AnonRpcTransport (its own route is used).
   * Requests already in flight finish on the transport they started on. Listeners are told the new state.
   */
  useTransport(transport: Transport | BootableTransport, route: Route = "direct"): void {
    this.unsubscribeHandle?.();
    this.unsubscribeHandle = undefined;
    if (typeof transport === "function") {
      this.active = { transport, route };
    } else {
      const handle = transport;
      this.active = { transport: handle.fetch, route: handle.route, handle };
      this.unsubscribeHandle = handle.subscribe((state) => this.emitBoot(state));
    }
    this.emitBoot(this.bootState);
  }

  /** Calls `listener` on every boot-state change of the active transport and when the transport is switched. Returns unsubscribe. */
  subscribe(listener: BootListener): () => void {
    this.bootListeners.add(listener);
    return () => this.bootListeners.delete(listener);
  }

  /** Boots the active transport now (e.g. when the app opens) instead of on the first request. No-op for direct. */
  async boot(): Promise<void> {
    await this.active.handle?.boot();
  }

  private emitBoot(state: BootState): void {
    for (const listener of [...this.bootListeners]) {
      try {
        listener(state);
      } catch {
        // a broken listener must not break the client
      }
    }
  }

  /**
   * Compatible with viem's `http(url, { fetchFn })` when wrapped as
   * `(input, init) => network.fetch(input, init, role, session)`. `role` and `session` select the
   * isolation key, which the anon transport forwards to the worker.
   */
  async fetch(
    input: RequestInfo | URL,
    init: RequestInit = {},
    role: RequestRole = "reader",
    session = "default",
  ): Promise<Response> {
    return this.send(this.active, input, init, role, session);
  }

  /**
   * Always a direct request, counted as direct, whatever the active mode is. Only for the few requests
   * that cannot be anonymous (the Anon-RPC bootstrap read). Application code should use fetch().
   */
  fetchDirect(input: RequestInfo | URL, init: RequestInit = {}, role: RequestRole = "reader", session = "bootstrap"): Promise<Response> {
    return this.send({ transport: directTransport, route: "direct" }, input, init, role, session);
  }

  private async send(
    active: ActiveTransport,
    input: RequestInfo | URL,
    init: RequestInit,
    role: RequestRole,
    session: string,
  ): Promise<Response> {
    const startedAt = performance.now();
    const isolationKey = isolationKeyFor(role, session);
    const record: Omit<RequestRecord, "durationMs" | "ok" | "error"> = {
      url: describeUrl(input),
      method: init.method ?? "GET",
      role,
      session,
      isolationKey,
      route: active.route,
      startedAt,
    };
    this.totals.total += 1;
    if (active.route === "anonymous") this.totals.anonymous += 1;
    else this.totals.direct += 1;

    let ok = false;
    let error: string | undefined;
    try {
      const response = await active.transport(input, init, { role, session, isolationKey });
      ok = response.ok;
      return response;
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
      throw caught;
    } finally {
      this.records.push({ ...record, durationMs: performance.now() - startedAt, ok, error });
      if (this.records.length > MAX_RECORDS) this.records.splice(0, this.records.length - MAX_RECORDS);
    }
  }

  /**
   * Counters for the traffic meter: every request, and how many were routed anonymously or directly.
   * "anonymous" means "handed to the anon transport", including requests it then rejected (those
   * never left the machine at all); see records[].ok for failures.
   */
  summary(): TrafficSummary {
    return { ...this.totals };
  }

  reset(): void {
    this.records = [];
    this.totals = { total: 0, anonymous: 0, direct: 0 };
  }
}

export const network = new NetworkClient();

// ---------------------------------------------------------------------------------------------------
// configureNetwork
// ---------------------------------------------------------------------------------------------------

export type NetworkConfig =
  | { mode: "direct" }
  /** `anon` is an AnonRpcTransport you built, or options for one. Omit it to reuse the previous one (or an unconfigured one that rejects everything). */
  | { mode: "anon"; anon?: AnonRpcTransport | AnonRpcOptions };

let ownedAnon: AnonRpcTransport | undefined;

/**
 * Switches `client` (default: the module singleton) between direct and anonymous routing.
 * - "direct": globalThis.fetch. Exposes this machine's IP address to every endpoint.
 * - "anon": AnonRpcTransport. Boot is lazy; use `client.subscribe` / `client.bootState` for progress.
 *   With no usable configuration every request rejects (NotConfiguredError). It never goes direct.
 * Passing options builds a new transport and closes the previous one this function built. Passing
 * nothing re-selects the previous transport without re-booting it.
 */
export function configureNetwork(config: NetworkConfig, client: NetworkClient = network): void {
  if (config.mode === "direct") {
    client.useTransport(directTransport, "direct");
    return;
  }
  const given = config.anon;
  if (given instanceof AnonRpcTransport) {
    client.useTransport(given);
    return;
  }
  if (given) {
    ownedAnon?.close();
    ownedAnon = new AnonRpcTransport({
      bootstrapFetch: (input, init) => client.fetchDirect(input, init, "reader", "bootstrap"),
      ...given,
    });
  } else {
    ownedAnon ??= new AnonRpcTransport();
  }
  client.useTransport(ownedAnon);
}
