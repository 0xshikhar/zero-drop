/**
 * Minimal "zerodrop" pinner: stores documents by CID and serves them back.
 *
 *   pnpm tsx scripts/pinner.ts [--port 8787] [--dir .local/pins] [--host 127.0.0.1]
 *
 * Protocol (client side: packages/core/src/pin.ts and resolve.ts):
 *   PUT  /pin/<cid>   raw bytes (max 1 MiB). 201 {cid,size}. 400 when sha256(body) != the CID digest.
 *   GET  /ipfs/<cid>  the stored bytes, 404 when unknown. HEAD works too.
 *   GET  /health      {ok:true,pins:n}
 *
 * A <cid> is CIDv1, raw codec, sha2-256, base32 lowercase ("b" + 58 chars). It is parsed by hand (the
 * multiformats subpath imports do not resolve under Node ESM) and validated BEFORE it touches the file
 * system, so it can never be a path. Uses only node:http, node:crypto, node:fs, node:path.
 *
 * CORS is deliberately permissive because documents are public, content-addressed and verified by the reader,
 * and the app is served from other origins and from file://.
 * This pinner keeps no logs of client addresses and has no authentication. Bind it to loopback (the default)
 * unless you mean to expose it.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { mkdirSync, readdirSync } from "node:fs";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const MAX_UPLOAD_BYTES = 1_048_576;
export const MAX_LARGE_UPLOAD_BYTES = 104_857_600; // 100 MiB for endowed/Panama-scale leaks
const CID_PATTERN = /^b[a-z2-7]{58}$/;
const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

/** Returns the 32-byte sha256 digest inside a CIDv1 raw/sha2-256 base32 string, or undefined. */
export function digestOfCid(cid: string): Buffer | undefined {
  if (!CID_PATTERN.test(cid)) return undefined;
  let buffer = 0;
  let bits = 0;
  const out: number[] = [];
  for (const char of cid.slice(1)) {
    buffer = ((buffer << 5) | ALPHABET.indexOf(char)) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out.push((buffer >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  if (out.length !== 36 || (buffer & ((1 << bits) - 1)) !== 0) return undefined;
  if (out[0] !== 0x01 || out[1] !== 0x55 || out[2] !== 0x12 || out[3] !== 0x20) return undefined;
  return Buffer.from(out.slice(4));
}

const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, HEAD, PUT, OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-allow-private-network": "true",
  "access-control-max-age": "86400",
  "access-control-expose-headers": "content-length, content-type",
};

function send(res: ServerResponse, status: number, body: string | Buffer = "", type = "application/json; charset=utf-8", head = false): void {
  res.writeHead(status, { ...CORS, "content-type": type, "content-length": Buffer.byteLength(body), "x-content-type-options": "nosniff" });
  res.end(head ? undefined : body);
}

const json = (res: ServerResponse, status: number, value: unknown) => send(res, status, JSON.stringify(value));

class TooLarge extends Error {}

/** Reads the request body, stopping as soon as it exceeds the limit. */
function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolveBody, reject) => {
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > limit) {
      reject(new TooLarge());
      return;
    }
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > limit) {
        reject(new TooLarge());
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolveBody(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/**
 * Builds the pinner HTTP server storing files under `dir` (created if missing). The caller decides where it
 * listens: `server.listen(0, "127.0.0.1")` for tests.
 */
export function createPinnerServer(dir: string): Server {
  const root = resolve(dir);
  mkdirSync(root, { recursive: true });

  return createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      if (!res.headersSent) json(res, 500, { error: "internal error" });
      else res.destroy();
      console.error("pinner error:", error instanceof Error ? error.message : error);
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? "GET";
    const path = (req.url ?? "/").split("?")[0] ?? "/";

    if (method === "OPTIONS") {
      res.writeHead(204, CORS);
      res.end();
      return;
    }

    if (path === "/health" && (method === "GET" || method === "HEAD")) {
      const pins = readdirSync(root).filter((name) => CID_PATTERN.test(name)).length;
      return send(res, 200, JSON.stringify({ ok: true, pins }), undefined, method === "HEAD");
    }

    if (path === "/storage/quote" && method === "GET") {
      const urlObj = new URL(req.url ?? "/", "http://127.0.0.1");
      const bytesNum = Number(urlObj.searchParams.get("bytes") ?? 0);
      const days = Number(urlObj.searchParams.get("days") ?? 365);
      const isFreeTier = bytesNum <= MAX_UPLOAD_BYTES;
      const excessMb = isFreeTier ? 0 : Math.ceil((bytesNum - MAX_UPLOAD_BYTES) / (1024 * 1024));
      const costWei = BigInt(excessMb) * 100n * BigInt(days * 7200);
      return json(res, 200, {
        ok: true,
        bytes: bytesNum,
        days,
        isFreeTier,
        costWei: costWei.toString(),
        costEth: (Number(costWei) / 1e18).toFixed(4),
      });
    }

    const pin = /^\/pin\/([^/]+)$/.exec(path);
    if (pin) {
      if (method !== "PUT") return json(res, 405, { error: "use PUT" });
      const cid = pin[1]!;
      const digest = digestOfCid(cid);
      if (!digest) return json(res, 400, { error: "not a CIDv1 raw sha2-256 base32 lowercase CID" });
      const isEndowed = req.headers["x-storage-endowment"] === "true" || req.headers["x-panama-scale"] === "true";
      const uploadLimit = isEndowed ? MAX_LARGE_UPLOAD_BYTES : MAX_UPLOAD_BYTES;
      let body: Buffer;
      try {
        body = await readBody(req, uploadLimit);
      } catch (error) {
        if (error instanceof TooLarge) return json(res, 413, { error: `upload limit is ${uploadLimit} bytes` });
        throw error;
      }
      if (body.length === 0) return json(res, 400, { error: "empty body" });
      const actual = createHash("sha256").update(body).digest();
      if (actual.length !== digest.length || !timingSafeEqual(actual, digest)) {
        return json(res, 400, { error: "sha256 of the body does not match the CID" });
      }
      // Write to a temp name, then rename: readers never see a partial file.
      const target = join(root, cid);
      const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
      try {
        await writeFile(temp, body);
        await rename(temp, target);
      } catch (error) {
        await rm(temp, { force: true });
        throw error;
      }
      return json(res, 201, { cid, size: body.length });
    }

    const get = /^\/ipfs\/([^/]+)$/.exec(path);
    if (get) {
      if (method !== "GET" && method !== "HEAD") return json(res, 405, { error: "use GET" });
      const cid = get[1]!;
      if (!digestOfCid(cid)) return json(res, 400, { error: "not a CIDv1 raw sha2-256 base32 lowercase CID" });
      let data: Buffer;
      try {
        data = await readFile(join(root, cid));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return json(res, 404, { error: "not pinned here" });
        throw error;
      }
      res.writeHead(200, {
        ...CORS,
        "content-type": "application/octet-stream",
        "content-length": data.length,
        "cache-control": "public, max-age=31536000, immutable",
        "x-content-type-options": "nosniff",
      });
      res.end(method === "HEAD" ? undefined : data);
      return;
    }

    return json(res, 404, { error: "not found" });
  }
}

function parseArgs(argv: string[]): { port: number; dir: string; host: string } {
  const opts = { port: 8787, dir: ".local/pins", host: "127.0.0.1" };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--port" && value) opts.port = Number(argv[++i]);
    else if (flag === "--dir" && value) opts.dir = argv[++i]!;
    else if (flag === "--host" && value) opts.host = argv[++i]!;
    else throw new Error(`Unknown or incomplete argument "${flag}". Usage: pinner.ts [--port 8787] [--dir .local/pins] [--host 127.0.0.1]`);
  }
  if (!Number.isInteger(opts.port) || opts.port < 1024 || opts.port > 65535) {
    throw new Error("--port must be an integer from 1024 to 65535 (privileged ports are refused).");
  }
  return opts;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { port, dir, host } = parseArgs(process.argv.slice(2));
  const server = createPinnerServer(dir);
  server.listen(port, host, () => {
    console.log(`zerodrop pinner listening on http://${host}:${port} (dir ${resolve(dir)})`);
  });
}
