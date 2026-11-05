/**
 * Network boundary for @zerodrop/core.
 *
 * TRUST STATUS (keep this honest; the UI reads it through statusLabels() in mode.ts):
 * - The default transport is DIRECT: globalThis.fetch from the machine running this code. The RPC
 *   endpoint and the sidecar see that machine's IP address. Acceptable for local development only.
 * - Anonymous routing (Anon-RPC / Tor, see docs/architecture.md section 3.2) is NOT integrated in
 *   this build. AnonRpcTransport is a placeholder that throws NotConfiguredError. Nothing here
 *   routes anonymously.
 * - Isolation keys (`<role>:<session>`) are recorded on every request. They do not change the
 *   transport yet. Once Anon-RPC is wired they select a separate circuit per role and session.
 * - The request log holds URLs with the query string removed, so RPC keys in query strings are
 *   not copied into the records.
 */

export type RequestRole = "source" | "reader" | "issuer";
/** How a request left this machine. Only "anonymous" would hide the IP address (not yet available). */
export type Route = "direct" | "anonymous";
export type Transport = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export const DEFAULT_TIMEOUT_MS = 60_000;

/** Thrown by transports that are declared but not wired in this build. */
export class NotConfiguredError extends Error {
  readonly code = "NOT_CONFIGURED" as const;
  constructor(message = "Anon-RPC worker is not integrated in this build") {
    super(message);
    this.name = "NotConfiguredError";
  }
}

export type RequestRecord = {
  /** Origin and path only. The query string is dropped. */
  url: string;
  method: string;
  role: RequestRole;
  session: string;
  /** `<role>:<session>`. Recorded only; no behaviour depends on it yet. */
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
  return async (input, init = {}) => {
    const controller = new AbortController();
    const outer = init.signal ?? undefined;
    const onOuterAbort = () => controller.abort(outer?.reason);
    if (outer?.aborted) controller.abort(outer.reason);
    outer?.addEventListener("abort", onOuterAbort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error(`Request timed out after ${timeoutMs} ms`)), timeoutMs);
    try {
      return await transport(input, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
      outer?.removeEventListener("abort", onOuterAbort);
    }
  };
}

/** Direct transport: globalThis.fetch with a 60 s timeout. Looked up at call time so tests can stub it. */
export const directTransport: Transport = withTimeout((input, init) => globalThis.fetch(input, init));

/**
 * Placeholder for the Anon-RPC (Tor) transport. It does not import any @anon-rpc package and it never
 * falls back to a direct request: every call throws NotConfiguredError.
 */
export class AnonRpcTransport {
  readonly route: Route = "anonymous";
  readonly fetch: Transport = async () => {
    throw new NotConfiguredError("Anon-RPC worker is not integrated in this build");
  };
}

const MAX_RECORDS = 1000;

/** Injectable network boundary. Counts every request by route. */
export class NetworkClient {
  private records: RequestRecord[] = [];
  private totals: TrafficSummary = { total: 0, anonymous: 0, direct: 0 };

  constructor(
    private readonly transport: Transport = directTransport,
    private readonly options: { route?: Route } = {},
  ) {}

  get route(): Route {
    return this.options.route ?? "direct";
  }

  /** The most recent requests (capped at 1000). Totals in summary() are never truncated. */
  get requests(): readonly RequestRecord[] {
    return this.records;
  }

  /**
   * Compatible with viem's `http(url, { fetchFn })` when wrapped as
   * `(input, init) => network.fetch(input, init, role, session)`. `role` and `session` select the
   * isolation key recorded on the request.
   */
  async fetch(
    input: RequestInfo | URL,
    init: RequestInit = {},
    role: RequestRole = "reader",
    session = "default",
  ): Promise<Response> {
    const startedAt = performance.now();
    const route = this.route;
    const record: Omit<RequestRecord, "durationMs" | "ok" | "error"> = {
      url: describeUrl(input),
      method: init.method ?? "GET",
      role,
      session,
      isolationKey: isolationKeyFor(role, session),
      route,
      startedAt,
    };
    this.totals.total += 1;
    if (route === "anonymous") this.totals.anonymous += 1;
    else this.totals.direct += 1;

    let ok = false;
    let error: string | undefined;
    try {
      const response = await this.transport(input, init);
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

  /** Counters for the traffic meter: every request, and how many left directly or anonymously. */
  summary(): TrafficSummary {
    return { ...this.totals };
  }

  reset(): void {
    this.records = [];
    this.totals = { total: 0, anonymous: 0, direct: 0 };
  }
}

export const network = new NetworkClient();
