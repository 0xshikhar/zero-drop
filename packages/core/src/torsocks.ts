/**
 * Tor egress for Node (scripts, the pinner tooling, tests). A `Transport` that sends every request
 * through a SOCKS5 proxy, normally a local Tor client at socks5h://127.0.0.1:9050. The `h` in
 * socks5h matters: the hostname (including a `.onion` name) is resolved by Tor, never by the local
 * resolver.
 *
 * This is NOT the browser path. Browsers cannot open SOCKS sockets; the browser uses the Anon-RPC
 * worker (net.ts `AnonRpcTransport`) and that is still unconfigured and never run. Use this transport
 * with `network.useTransport(torSocksTransport(url), "anonymous")` so the traffic meter counts it as
 * anonymous.
 *
 * Failure behaviour: a dead proxy rejects the request. Nothing falls back to a direct connection.
 */
import http from "node:http";
import https from "node:https";
import { Readable } from "node:stream";
import { SocksProxyAgent } from "socks-proxy-agent";
import { DEFAULT_TIMEOUT_MS, type Transport } from "./net";

export class TorSocksError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TorSocksError";
  }
}

export type TorSocksOptions = {
  /** e.g. "socks5h://127.0.0.1:9050". Must be socks5h so onion names resolve inside Tor. */
  socksUrl: string;
  timeoutMs?: number;
  /** Test seam: replaces the SOCKS agent, e.g. a plain agent to exercise the HTTP plumbing without Tor. */
  agentFactory?: (url: URL) => http.Agent;
};

/** Normalises a body into bytes and a content type. Handles strings, bytes, Blob and FormData. */
async function materialiseBody(body: RequestInit["body"]): Promise<{ bytes?: Buffer; contentType?: string }> {
  if (body === undefined || body === null) return {};
  if (typeof body === "string") return { bytes: Buffer.from(body, "utf8"), contentType: "text/plain;charset=UTF-8" };
  if (body instanceof Uint8Array) return { bytes: Buffer.from(body) };
  if (body instanceof ArrayBuffer) return { bytes: Buffer.from(body) };
  // Blob and FormData: let the Fetch API serialise them, then copy the bytes and its content type
  // (FormData carries its multipart boundary in the content type).
  const encoded = new Response(body as BodyInit);
  const bytes = Buffer.from(await encoded.arrayBuffer());
  return { bytes, contentType: encoded.headers.get("content-type") ?? undefined };
}

function headersToRecord(init: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!init) return out;
  new Headers(init).forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

/** A Transport that sends each request through the SOCKS proxy. */
export function torSocksTransport(options: TorSocksOptions): Transport {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const proxy = new URL(options.socksUrl);
  if (proxy.protocol !== "socks5h:") {
    throw new TorSocksError(`socksUrl must use socks5h:// so onion names resolve inside Tor (got ${proxy.protocol})`);
  }
  const agentFor = (url: URL): http.Agent =>
    options.agentFactory ? options.agentFactory(url) : new SocksProxyAgent(options.socksUrl, { timeout: timeoutMs });

  return async (input, init = {}, _ctx) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new TorSocksError(`unsupported scheme ${url.protocol}`);
    }
    const method = (init.method ?? "GET").toUpperCase();
    const { bytes, contentType } = await materialiseBody(init.body);
    const headers = headersToRecord(init.headers);
    if (contentType && !("content-type" in lowerKeys(headers))) headers["content-type"] = contentType;
    if (bytes) headers["content-length"] = String(bytes.byteLength);

    const requester = url.protocol === "https:" ? https.request : http.request;
    return new Promise<Response>((resolve, reject) => {
      const req = requester(
        url,
        { method, headers, agent: agentFor(url) },
        (res) => {
          const status = res.statusCode ?? 0;
          const responseHeaders = new Headers();
          for (const [key, value] of Object.entries(res.headers)) {
            if (value === undefined) continue;
            for (const v of Array.isArray(value) ? value : [value]) responseHeaders.append(key, v);
          }
          // 204/304 must not carry a body in the Fetch Response constructor.
          const noBody = status === 204 || status === 205 || status === 304;
          const body = noBody ? null : (Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>);
          resolve(new Response(body, { status, statusText: res.statusMessage ?? "", headers: responseHeaders }));
        },
      );
      req.setTimeout(timeoutMs, () => req.destroy(new TorSocksError(`no response within ${timeoutMs} ms`)));
      req.on("error", (error) => reject(new TorSocksError(`request through ${proxy.protocol}//${proxy.host} failed: ${error.message}`)));
      const signal = init.signal;
      if (signal) {
        if (signal.aborted) req.destroy(new TorSocksError("aborted"));
        else signal.addEventListener("abort", () => req.destroy(new TorSocksError("aborted")), { once: true });
      }
      if (bytes) req.end(bytes);
      else req.end();
    });
  };
}

function lowerKeys(record: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(record)) out[key.toLowerCase()] = record[key]!;
  return out;
}
