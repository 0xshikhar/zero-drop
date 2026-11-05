/**
 * Probes the public alt-mempool devnet with normal TLS verification and prints what it finds.
 *
 *   pnpm tsx scripts/check-devnet.ts [--json]
 *   DEVNET_RPC_URL=https://... SIDECAR_URL=https://.../rpc pnpm tsx scripts/check-devnet.ts
 *
 * Probes (all `eth_chainId`, expected 0x539 = 1337):
 *   - execution RPC (ethrex)             default https://altmempool.forshtat.com
 *   - sidecar / mempool RPC (primary)    default https://altmempool.forshtat.com/rpc
 *   - sidecar gateway (informational)    default https://altmempoolgateway.forshtat.com/rpc
 * URLs come from the environment, else from config/devnet.json (rpcUrl or rpcUrls[0], sidecarUrls[0]) when set, else the
 * documented defaults (docs.altmempool.wtf/guides/devnet).
 *
 * TLS is NEVER disabled for a request. When verification fails, a second connection is opened only to READ the
 * certificate dates (a bare handshake, no HTTP request, no payload, closed at once) so the report can say whether
 * the certificate is "not yet valid" and by how long. That inspection connection is the only place
 * certificate verification is skipped.
 *
 * After a successful chainId, three extra read-only calls are made against the reachable endpoints (block number,
 * code at the documented staking registry, `skandha_config`). Those extra calls have been exercised only against a
 * local stub server, not against the real devnet (which was unreachable when this was written).
 *
 * Exit code 0: the execution RPC and the primary sidecar both answered with chain 1337. Otherwise 1.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { connect as tlsConnect } from "node:tls";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEVNET_CHAIN_ID = 1337;
const DOCUMENTED_REGISTRY = "0xd51c04d7a0b01124e84de152f4e56d9eecb22d2f";
const json = process.argv.includes("--json");

interface Config {
  rpcUrl?: string;
  rpcUrls?: string[];
  sidecarUrls?: string[];
}
let config: Config = {};
try {
  config = JSON.parse(readFileSync(resolve(root, "config/devnet.json"), "utf8")) as Config;
} catch {
  /* optional */
}

const targets = [
  { name: "execution RPC (ethrex)", url: process.env.DEVNET_RPC_URL ?? config.rpcUrl ?? config.rpcUrls?.[0] ?? "https://altmempool.forshtat.com", primary: true },
  { name: "sidecar /rpc (primary)", url: process.env.SIDECAR_URL ?? config.sidecarUrls?.[0] ?? "https://altmempool.forshtat.com/rpc", primary: true },
  { name: "sidecar gateway", url: process.env.SIDECAR_GATEWAY_URL ?? "https://altmempoolgateway.forshtat.com/rpc", primary: false },
];

type Outcome =
  | { kind: "ok"; chainId: number }
  | { kind: "wrong-chain"; chainId: number }
  | { kind: "tls-not-yet-valid"; notBefore?: string; notAfter?: string }
  | { kind: "tls-expired"; notBefore?: string; notAfter?: string }
  | { kind: "tls-other"; code: string; message: string }
  | { kind: "network"; code: string; message: string }
  | { kind: "http"; status: number; body: string }
  | { kind: "bad-response"; body: string };

interface Probe {
  name: string;
  url: string;
  primary: boolean;
  outcome: Outcome;
  extra?: Record<string, unknown>;
}

async function rpc(url: string, method: string, params: unknown[] = []): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { http: { status: res.status, body: text.slice(0, 200) } });
  let parsed: { result?: unknown; error?: { message?: string } };
  try {
    parsed = JSON.parse(text);
  } catch {
    throw Object.assign(new Error("not JSON"), { badBody: text.slice(0, 200) });
  }
  if (parsed.error) throw new Error(`${method}: ${parsed.error.message ?? JSON.stringify(parsed.error)}`);
  return parsed.result;
}

/** Reads the certificate validity dates over a bare handshake. Verification is skipped here, and only here. No request is sent. */
function readCertificateDates(url: string): Promise<{ notBefore?: string; notAfter?: string }> {
  const u = new URL(url);
  return new Promise((resolveDates) => {
    const socket = tlsConnect({ host: u.hostname, port: Number(u.port || 443), servername: u.hostname, rejectUnauthorized: false, timeout: 10_000 }, () => {
      const cert = socket.getPeerCertificate();
      socket.end();
      resolveDates({ notBefore: cert?.valid_from, notAfter: cert?.valid_to });
    });
    socket.on("error", () => resolveDates({}));
    socket.on("timeout", () => {
      socket.destroy();
      resolveDates({});
    });
  });
}

function errorCode(err: unknown): string {
  const e = err as { code?: string; cause?: { code?: string; message?: string } };
  return e.cause?.code ?? e.code ?? "UNKNOWN";
}

async function classify(err: unknown, url: string): Promise<Outcome> {
  const e = err as { http?: { status: number; body: string }; badBody?: string; cause?: { message?: string }; message?: string };
  if (e.http) return { kind: "http", status: e.http.status, body: e.http.body };
  if (e.badBody !== undefined) return { kind: "bad-response", body: e.badBody };
  const code = errorCode(err);
  if (code === "CERT_NOT_YET_VALID") return { kind: "tls-not-yet-valid", ...(await readCertificateDates(url)) };
  if (code === "CERT_HAS_EXPIRED") return { kind: "tls-expired", ...(await readCertificateDates(url)) };
  if (/CERT|SSL|TLS|UNABLE_TO_VERIFY|SELF_SIGNED|DEPTH_ZERO|ERR_TLS/.test(code)) {
    return { kind: "tls-other", code, message: e.cause?.message ?? e.message ?? "" };
  }
  return { kind: "network", code, message: e.cause?.message ?? e.message ?? "" };
}

async function probe(t: (typeof targets)[number]): Promise<Probe> {
  try {
    const result = await rpc(t.url, "eth_chainId");
    const chainId = Number(BigInt(String(result)));
    if (chainId !== DEVNET_CHAIN_ID) return { ...t, outcome: { kind: "wrong-chain", chainId } };
    return { ...t, outcome: { kind: "ok", chainId } };
  } catch (err) {
    return { ...t, outcome: await classify(err, t.url) };
  }
}

async function extraProbes(execution: Probe | undefined, sidecar: Probe | undefined): Promise<void> {
  if (execution?.outcome.kind === "ok") {
    const extra: Record<string, unknown> = {};
    try {
      extra.blockNumber = Number(BigInt(String(await rpc(execution.url, "eth_blockNumber"))));
    } catch (e) {
      extra.blockNumberError = String((e as Error).message);
    }
    try {
      const code = String(await rpc(execution.url, "eth_getCode", [DOCUMENTED_REGISTRY, "latest"]));
      extra.stakingRegistryHasCode = code !== "0x";
      extra.stakingRegistry = DOCUMENTED_REGISTRY;
    } catch (e) {
      extra.stakingRegistryError = String((e as Error).message);
    }
    execution.extra = extra;
  }
  if (sidecar?.outcome.kind === "ok") {
    try {
      sidecar.extra = { skandhaConfig: await rpc(sidecar.url, "skandha_config") };
    } catch (e) {
      sidecar.extra = { skandhaConfigError: String((e as Error).message) };
    }
  }
}

function describe(o: Outcome, now: Date): string[] {
  switch (o.kind) {
    case "ok":
      return [`OK  eth_chainId = 0x${o.chainId.toString(16)} (${o.chainId})`];
    case "wrong-chain":
      return [`WRONG CHAIN  eth_chainId = ${o.chainId}, expected ${DEVNET_CHAIN_ID}`];
    case "tls-not-yet-valid": {
      const lines = ["TLS: certificate is NOT YET VALID (verification failed; no request was sent)"];
      if (o.notBefore) {
        const nb = new Date(o.notBefore);
        const hours = (nb.getTime() - now.getTime()) / 3_600_000;
        lines.push(`     certificate notBefore: ${nb.toISOString()}  (${o.notBefore})`);
        lines.push(`     certificate notAfter:  ${o.notAfter ? new Date(o.notAfter).toISOString() : "?"}`);
        lines.push(`     this machine's clock:  ${now.toISOString()}`);
        lines.push(
          hours > 0
            ? `     the certificate becomes valid in ${hours.toFixed(1)} h by this machine's clock (do not work around it with -k / NODE_TLS_REJECT_UNAUTHORIZED=0)`
            : "     by this clock the certificate is already valid; retry (the failure may have been transient)",
        );
      } else lines.push("     (could not read the certificate dates)");
      return lines;
    }
    case "tls-expired":
      return [`TLS: certificate has EXPIRED  notBefore ${o.notBefore ?? "?"}  notAfter ${o.notAfter ?? "?"}`];
    case "tls-other":
      return [`TLS: verification failed (${o.code}) ${o.message}`];
    case "network":
      return [`NETWORK: ${o.code} ${o.message}`];
    case "http":
      return [`HTTP ${o.status}: ${o.body}`];
    case "bad-response":
      return [`BAD RESPONSE (not JSON-RPC): ${o.body}`];
  }
}

async function main(): Promise<void> {
  const now = new Date();
  const probes = await Promise.all(targets.map(probe));
  await extraProbes(probes[0], probes[1]);
  const reachable = probes.filter((p) => p.primary).every((p) => p.outcome.kind === "ok");

  if (json) {
    console.log(JSON.stringify({ checkedAt: now.toISOString(), reachable, probes }, null, 2));
  } else {
    console.log(`checked at ${now.toISOString()} (this machine's clock), expected chain ${DEVNET_CHAIN_ID}`);
    for (const p of probes) {
      console.log(`\n${p.name}${p.primary ? "" : " [informational]"}\n  ${p.url}`);
      for (const line of describe(p.outcome, now)) console.log(`  ${line}`);
      if (p.extra) console.log(`  extra: ${JSON.stringify(p.extra)}`);
    }
    console.log(`\n${reachable ? "REACHABLE: execution RPC and primary sidecar answered with chain 1337" : "NOT REACHABLE: see the lines above"}`);
  }
  process.exit(reachable ? 0 : 1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
