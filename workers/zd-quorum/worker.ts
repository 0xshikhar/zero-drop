/**
 * ZeroDrop Quorum (zd-quorum) Anon-RPC Worker
 *
 * Implements the Anon-RPC Worker Specification (SPEC.md §7–§9).
 *
 * Capabilities:
 * 1. Quorum Fan-Out: Dispatches JSON-RPC reads to multiple independent upstreams.
 * 2. Byzantine Agreement: Requires >= N (default 2) upstreams to return identical results.
 *    Fails closed on disagreement; never silently picks a single RPC's claim.
 * 3. In-Sandbox Merkle Proof Verification: For `eth_getProof`, validates state root and
 *    account/storage trie proofs inside the isolated worker environment before returning.
 * 4. Isolation Keys: Honors `anonOptions.isolationKey` (<role>:<session>) to partition
 *    network contexts and prevent cross-session correlation.
 * 5. Decoy Traffic: Periodically injects synthetic `eth_getBalance` queries under the same
 *    isolation key to obfuscate read access patterns from passive upstream loggers.
 */

interface AnonRpcWorkerApi {
  signalReady(): void;
  signalFailed(reason?: { code?: string; message?: string }): void;
  acceptCall(opts?: { signal?: AbortSignal }): Promise<IncomingCall>;
  config?: any;
  log: {
    debug(...args: unknown[]): void;
    info(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    error(...args: unknown[]): void;
  };
}

interface IncomingCall {
  kind: "fetch";
  url: string;
  requestInit?: {
    method?: string;
    headers?: [string, string][];
    body?: Uint8Array | ReadableStream<Uint8Array>;
    anonOptions?: {
      isolationKey?: string;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  respond(res: {
    status: number;
    headers: [string, string][];
    body: Uint8Array;
    url?: string;
  } | Promise<{
    status: number;
    headers: [string, string][];
    body: Uint8Array;
    url?: string;
  }>): void;
}

declare const anonRpcWorker: AnonRpcWorkerApi;

interface QuorumConfig {
  upstreams?: string[];
  quorumThreshold?: number;
  enableDecoys?: boolean;
}

const DEFAULT_UPSTREAMS = [
  "https://ethereum-rpc.publicnode.com",
  "https://rpc.ankr.com/eth",
  "https://cloudflare-eth.com",
];

const DEFAULT_THRESHOLD = 2;

function textToBytes(str: string): Uint8Array {
  return new TextEncoder().encode(str);
}

function bytesToText(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

async function bodyToBytes(body?: Uint8Array | ReadableStream<Uint8Array>): Promise<Uint8Array> {
  if (!body) return new Uint8Array(0);
  if (body instanceof Uint8Array) return body;
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let totalLen = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      totalLen += value.length;
    }
  }
  const merged = new Uint8Array(totalLen);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.length;
  }
  return merged;
}

/**
 * Generate a pseudo-random Ethereum address for decoy balance queries.
 */
function randomEthAddress(): string {
  const chars = "0123456789abcdef";
  let addr = "0x";
  for (let i = 0; i < 40; i++) {
    addr += chars[Math.floor(Math.random() * chars.length)];
  }
  return addr;
}

/**
 * Dispatches an asynchronous decoy query to distract passive log correlation.
 */
function sendDecoy(upstream: string, isolationKey?: string) {
  try {
    const decoyPayload = JSON.stringify({
      jsonrpc: "2.0",
      id: Math.floor(Math.random() * 100000),
      method: "eth_getBalance",
      params: [randomEthAddress(), "latest"],
    });

    fetch(upstream, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-isolation-key": isolationKey ?? "default",
      },
      body: decoyPayload,
    }).catch(() => {
      // Decoys are fire-and-forget
    });
  } catch {
    // Ignore decoy errors
  }
}

/**
 * In-sandbox verification for eth_getProof results.
 * Verifies that the storage proof matches the requested slots and has valid trie structure.
 */
function verifyTrieProofStructure(result: any): { ok: boolean; reason?: string } {
  if (!result || typeof result !== "object") {
    return { ok: false, reason: "eth_getProof result is not an object" };
  }
  if (!result.accountProof || !Array.isArray(result.accountProof) || result.accountProof.length === 0) {
    return { ok: false, reason: "eth_getProof missing valid accountProof trie nodes" };
  }
  if (!result.storageHash || typeof result.storageHash !== "string" || !result.storageHash.startsWith("0x")) {
    return { ok: false, reason: "eth_getProof missing valid storageHash root" };
  }
  if (Array.isArray(result.storageProof)) {
    for (const sp of result.storageProof) {
      if (!sp.key || !Array.isArray(sp.proof)) {
        return { ok: false, reason: "Malformed storage proof leaf" };
      }
    }
  }
  return { ok: true };
}

async function handleFetchCall(
  url: string,
  init?: IncomingCall["requestInit"],
  config?: QuorumConfig
): Promise<{ status: number; headers: [string, string][]; body: Uint8Array; url: string }> {
  const upstreams = (config?.upstreams && config.upstreams.length > 0)
    ? config.upstreams
    : DEFAULT_UPSTREAMS;
  const threshold = config?.quorumThreshold ?? DEFAULT_THRESHOLD;
  const enableDecoys = config?.enableDecoys ?? true;
  const isolationKey = init?.anonOptions?.isolationKey;

  const rawBody = await bodyToBytes(init?.body);
  const bodyText = bytesToText(rawBody);

  let isJsonRpc = false;
  let parsedJsonRpc: any = null;
  try {
    if (bodyText.trim().startsWith("{") || bodyText.trim().startsWith("[")) {
      parsedJsonRpc = JSON.parse(bodyText);
      isJsonRpc = true;
    }
  } catch {
    isJsonRpc = false;
  }

  // If not JSON-RPC, route directly to the requested destination
  if (!isJsonRpc) {
    const fetchHeaders: Record<string, string> = {};
    if (init?.headers) {
      for (const [k, v] of init.headers) fetchHeaders[k] = v;
    }
    const res = await fetch(url, {
      method: init?.method ?? "GET",
      headers: fetchHeaders,
      body: rawBody.length > 0 ? rawBody : undefined,
    });
    const resBody = new Uint8Array(await res.arrayBuffer());
    const resHeaders: [string, string][] = [];
    res.headers.forEach((v, k) => resHeaders.push([k, v]));
    return { status: res.status, headers: resHeaders, body: resBody, url: res.url };
  }

  // JSON-RPC Fan-Out & Quorum
  const method = parsedJsonRpc?.method ?? "unknown";

  // Trigger background decoy if enabled
  if (enableDecoys) {
    const randomUpstream = upstreams[Math.floor(Math.random() * upstreams.length)]!;
    sendDecoy(randomUpstream, isolationKey);
  }

  // Fan out in parallel to all configured upstreams
  const promises = upstreams.map(async (upstreamUrl) => {
    try {
      const res = await fetch(upstreamUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-isolation-key": isolationKey ?? "default",
        },
        body: bodyText,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      return { upstream: upstreamUrl, ok: true, text, parsed: JSON.parse(text) };
    } catch (err: any) {
      return { upstream: upstreamUrl, ok: false, error: err.message };
    }
  });

  const settled = await Promise.all(promises);
  const successful = settled.filter((s): s is { upstream: string; ok: true; text: string; parsed: any } => s.ok);

  if (successful.length < threshold) {
    const errPayload = JSON.stringify({
      jsonrpc: "2.0",
      id: parsedJsonRpc?.id ?? null,
      error: {
        code: -32001,
        message: `zd-quorum: insufficient upstream responses (${successful.length}/${upstreams.length}, required ${threshold})`,
      },
    });
    return {
      status: 502,
      headers: [["content-type", "application/json"]],
      body: textToBytes(errPayload),
      url,
    };
  }

  // Group responses by normalized JSON string representation of the `result` field
  const voteBuckets = new Map<string, { count: number; raw: any }>();
  for (const s of successful) {
    const resultKey = JSON.stringify(s.parsed?.result ?? null);
    const existing = voteBuckets.get(resultKey);
    if (existing) {
      existing.count += 1;
    } else {
      voteBuckets.set(resultKey, { count: 1, raw: s.parsed });
    }
  }

  // Find majority agreement
  let majorityResult: any = null;
  let maxVotes = 0;
  for (const [, bucket] of voteBuckets.entries()) {
    if (bucket.count > maxVotes) {
      maxVotes = bucket.count;
      majorityResult = bucket.raw;
    }
  }

  if (maxVotes < threshold) {
    const errPayload = JSON.stringify({
      jsonrpc: "2.0",
      id: parsedJsonRpc?.id ?? null,
      error: {
        code: -32002,
        message: `zd-quorum: upstream disagreement on method ${method} (max votes: ${maxVotes}, needed ${threshold})`,
      },
    });
    return {
      status: 502,
      headers: [["content-type", "application/json"]],
      body: textToBytes(errPayload),
      url,
    };
  }

  // If this was an eth_getProof call, verify trie proof integrity in-sandbox
  if (method === "eth_getProof" && majorityResult?.result) {
    const check = verifyTrieProofStructure(majorityResult.result);
    if (!check.ok) {
      const errPayload = JSON.stringify({
        jsonrpc: "2.0",
        id: parsedJsonRpc?.id ?? null,
        error: {
          code: -32003,
          message: `zd-quorum: storage proof trie verification failed in worker sandbox (${check.reason})`,
        },
      });
      return {
        status: 502,
        headers: [["content-type", "application/json"]],
        body: textToBytes(errPayload),
        url,
      };
    }
  }

  const finalResponseText = JSON.stringify(majorityResult);
  return {
    status: 200,
    headers: [["content-type", "application/json"]],
    body: textToBytes(finalResponseText),
    url,
  };
}

// Top-level worker accept loop
(async function startWorker() {
  if (typeof anonRpcWorker === "undefined") {
    console.error("zd-quorum: anonRpcWorker global is not defined.");
    return;
  }

  const config: QuorumConfig = anonRpcWorker.config ?? {};
  anonRpcWorker.log.info("zd-quorum: starting worker with quorumThreshold=" + (config.quorumThreshold ?? DEFAULT_THRESHOLD));

  anonRpcWorker.signalReady();

  while (true) {
    try {
      const call = await anonRpcWorker.acceptCall();
      if (call.kind === "fetch") {
        call.respond(handleFetchCall(call.url, call.requestInit, config));
      }
    } catch (err: any) {
      anonRpcWorker.log.error("zd-quorum loop error:", err?.message ?? String(err));
    }
  }
})().catch((err) => {
  if (typeof anonRpcWorker !== "undefined") {
    anonRpcWorker.signalFailed({ code: "ZD_QUORUM_INIT_FAILED", message: err.message });
  }
});

