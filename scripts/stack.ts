/**
 * One-command local stack: chain, mock deployment, demo group, pinner, optional offline Kubo, web dev server.
 *
 *   pnpm stack:up [--no-kubo] [--no-web]
 *   pnpm stack:status
 *   pnpm stack:down
 *
 * What `up` does, in order. Every step checks first and does nothing when the work is already done:
 *   1. Prerequisites: node, forge, anvil (required); ipfs (optional).
 *   2. anvil on 127.0.0.1:8545 unless something already answers eth_chainId there (it must be chain 31337).
 *   3. `forge build` when contracts/out is missing.
 *   4. The MOCK deployment (scripts/deploy.ts --mock --out config/local-mock.json) unless ZeroDrop in
 *      config/local-mock.json has code on the chain (eth_getCode).
 *   5. A demo group (scripts/seed-group.ts) unless .local/demo-members.local-mock.json exists and its group is on chain.
 *   6. The zerodrop pinner on the first free port from 8787 upward.
 *   7. apps/web/.env.local with VITE_ZERODROP_PINNER_URL (gitignored by apps/web/.gitignore).
 *   8. An OFFLINE Kubo node (repo .local/kubo, API 15001, gateway 18080, --offline, no bootstrap, no DHT) when `ipfs` exists.
 *   9. The vite dev server on the first free port from 5173 upward.
 *
 * Everything binds to 127.0.0.1. Processes this script starts are recorded in .local/stack.pids and are the only ones
 * `down` stops: anvil, Kubo or a pinner that were already running are reused and never killed. Logs: .local/logs/.
 */
import { execFileSync, spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { zeroAddress } from "viem";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const localDir = resolve(root, ".local");
const logDir = resolve(localDir, "logs");
const pidFile = resolve(localDir, "stack.pids");
const kuboRepo = resolve(localDir, "kubo");
const envLocal = resolve(root, "apps/web/.env.local");
const ENV_MARK = "# Written by scripts/stack.ts (pnpm stack:up). Removed by pnpm stack:down.";
// Test knobs (defaults are what everyone should use): STACK_ANVIL_PORT, STACK_CONFIG, STACK_KUBO_API_PORT, STACK_KUBO_GATEWAY_PORT.
const configRel = process.env.STACK_CONFIG ?? "config/local-mock.json";
const configPath = resolve(root, configRel);
const demoRel = `.local/demo-members.${basename(configRel, ".json")}.json`;
const demoPath = resolve(root, demoRel);

const HOST = "127.0.0.1";
const ANVIL_PORT = Number(process.env.STACK_ANVIL_PORT ?? 8545);
const LOCAL_CHAIN_ID = 31337;
const PINNER_START = 8787;
const VITE_START = 5173;
const KUBO_API = Number(process.env.STACK_KUBO_API_PORT ?? 15001);
const KUBO_GATEWAY = Number(process.env.STACK_KUBO_GATEWAY_PORT ?? 18080);

type Proc = { pid: number; port: number; started: string; cmd: string };
type StackState = {
  anvil?: Proc;
  pinner?: Proc;
  kubo?: Proc;
  vite?: Proc;
  /** Components that were already running and were reused. Never killed. */
  reused: Partial<Record<"anvil" | "kubo", number>>;
  /** Last ports chosen, so a restart prefers the same ones. */
  ports: { pinner?: number; vite?: number };
};

// --- output ----------------------------------------------------------------------------------

const say = (line = "") => console.log(line);
const step = (name: string, detail: string) => console.log(`  ${name.padEnd(10)} ${detail}`);
function fail(message: string): never {
  console.error(`\nstack: ${message}`);
  process.exit(1);
}

// --- state file ------------------------------------------------------------------------------

function readState(): StackState {
  try {
    const parsed = JSON.parse(readFileSync(pidFile, "utf8")) as Partial<StackState>;
    return { reused: {}, ports: {}, ...parsed };
  } catch {
    return { reused: {}, ports: {} };
  }
}

function writeState(state: StackState): void {
  mkdirSync(localDir, { recursive: true });
  writeFileSync(pidFile, `${JSON.stringify(state, null, 2)}\n`);
}

// --- process helpers -------------------------------------------------------------------------

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The command line of a pid, or "" when it does not exist. */
function commandOf(pid: number): string {
  try {
    return execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

/** True only when the pid is alive and still looks like the process we recorded (guards against pid reuse). */
function isOurs(proc: Proc | undefined): proc is Proc {
  if (!proc || !alive(proc.pid)) return false;
  return commandOf(proc.pid).includes(proc.cmd);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(check: () => Promise<boolean>, what: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(250);
  }
  fail(`${what} did not become ready within ${Math.round(timeoutMs / 1000)}s. See ${logDir}/ for its log.`);
}

function startDetached(name: string, command: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): number {
  mkdirSync(logDir, { recursive: true });
  const out = openSync(resolve(logDir, `${name}.log`), "a");
  const child = spawn(command, args, {
    cwd: opts.cwd ?? root,
    env: opts.env ?? process.env,
    detached: true,
    stdio: ["ignore", out, out],
  });
  closeSync(out);
  child.on("error", (e) => console.error(`stack: could not start ${name}: ${e.message}`));
  child.unref();
  if (!child.pid) fail(`could not start ${name}`);
  return child.pid;
}

/** Stops a process group we started. SIGTERM, then SIGKILL after 4 s. */
async function stopProc(label: string, proc: Proc | undefined): Promise<boolean> {
  if (!proc) return false;
  const owned: boolean = isOurs(proc);
  if (!owned) {
    step(label, `pid ${proc.pid} is gone (or no longer the process we started); nothing to stop`);
    return false;
  }
  const signal = (sig: NodeJS.Signals) => {
    try {
      process.kill(-proc.pid, sig); // the whole group: vite and tsx spawn children
    } catch {
      try {
        process.kill(proc.pid, sig);
      } catch {
        // already gone
      }
    }
  };
  signal("SIGTERM");
  for (let i = 0; i < 16 && alive(proc.pid); i++) await sleep(250);
  if (alive(proc.pid)) signal("SIGKILL");
  step(label, `stopped pid ${proc.pid}`);
  return true;
}

// --- network helpers -------------------------------------------------------------------------

async function timed(url: string, init: RequestInit = {}, ms = 1500): Promise<Response | undefined> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
  } catch {
    return undefined;
  }
}

async function rpc<T = string>(method: string, params: unknown[] = []): Promise<T | undefined> {
  const res = await timed(`http://${HOST}:${ANVIL_PORT}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res?.ok) return undefined;
  try {
    const body = (await res.json()) as { result?: T };
    return body.result;
  } catch {
    return undefined;
  }
}

function connects(port: number, host: string): Promise<boolean> {
  return new Promise((resolveConnect) => {
    const socket = net.connect({ port, host });
    const done = (ok: boolean) => {
      socket.destroy();
      resolveConnect(ok);
    };
    socket.setTimeout(500, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

function canBind(port: number): Promise<boolean> {
  return new Promise((resolveBind) => {
    const server = net.createServer();
    server.once("error", () => resolveBind(false));
    server.listen(port, HOST, () => server.close(() => resolveBind(true)));
  });
}

/** Free means: nothing accepts connections on loopback (v4 or v6) and we can bind it. */
async function portFree(port: number): Promise<boolean> {
  if ((await connects(port, HOST)) || (await connects(port, "::1"))) return false;
  return canBind(port);
}

async function firstFreePort(from: number, prefer?: number): Promise<number> {
  if (prefer && (await portFree(prefer))) return prefer;
  for (let port = from; port < from + 200; port++) if (await portFree(port)) return port;
  fail(`no free port found from ${from} upward`);
}

function which(bin: string): string | undefined {
  try {
    return execFileSync("which", [bin], { encoding: "utf8" }).trim() || undefined;
  } catch {
    return undefined;
  }
}

function versionOf(bin: string, arg = "--version"): string {
  try {
    return execFileSync(bin, [arg], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split("\n")[0]?.trim() ?? "";
  } catch {
    return "";
  }
}

/** Environment for child scripts: pinned to the local anvil, never inheriting a real deployer key or RPC. */
function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.DEPLOYER_PRIVATE_KEY;
  delete env.CONFIG;
  delete env.VERIFIER;
  env.RPC_URL = `http://${HOST}:${ANVIL_PORT}`;
  return { ...env, ...extra };
}

function runScript(label: string, args: string[], extraEnv: Record<string, string> = {}): void {
  say(`    $ ${args.join(" ")}`);
  try {
    execFileSync(resolve(root, "node_modules/.bin/tsx"), args, { cwd: root, env: childEnv(extraEnv), stdio: ["ignore", "inherit", "inherit"] });
  } catch {
    fail(`${label} failed (see its output above).`);
  }
}

// --- steps -----------------------------------------------------------------------------------

function checkPrerequisites(wantKubo: boolean): { ipfs: boolean } {
  const need = [
    { bin: "node", arg: "--version" },
    { bin: "forge", arg: "--version" },
    { bin: "anvil", arg: "--version" },
  ];
  const missing: string[] = [];
  for (const { bin, arg } of need) {
    if (which(bin)) step(bin, versionOf(bin, arg) || "found");
    else {
      step(bin, "MISSING");
      missing.push(bin);
    }
  }
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 20) missing.push(`node >= 20 (you have ${process.versions.node})`);
  if (!existsSync(resolve(root, "node_modules/.bin/tsx"))) missing.push("installed dependencies (run `pnpm install`)");
  if (!existsSync(resolve(root, "apps/web/node_modules/.bin/vite"))) missing.push("web app dependencies (run `pnpm install`)");
  let ipfs = false;
  if (wantKubo) {
    if (which("ipfs")) {
      step("ipfs", `${versionOf("ipfs")} (optional)`);
      ipfs = true;
    } else step("ipfs", "not installed (optional): continuing without a Kubo node");
  } else step("ipfs", "skipped (--no-kubo)");
  if (missing.length) {
    fail(
      `missing prerequisites: ${missing.join(", ")}.\n` +
        "  Foundry (forge, anvil): https://book.getfoundry.sh/getting-started/installation\n" +
        "  Node 20+ and pnpm: https://pnpm.io/installation",
    );
  }
  return { ipfs };
}

async function ensureAnvil(state: StackState): Promise<void> {
  const chainId = await rpc("eth_chainId");
  if (chainId !== undefined) {
    if (parseInt(chainId, 16) !== LOCAL_CHAIN_ID) {
      fail(`something on ${HOST}:${ANVIL_PORT} answers as chain ${parseInt(chainId, 16)}, not anvil's ${LOCAL_CHAIN_ID}. Stop it or free the port.`);
    }
    if (isOurs(state.anvil)) step("anvil", `running, started by stack:up (pid ${state.anvil.pid})`);
    else {
      step("anvil", `already running on ${HOST}:${ANVIL_PORT} (chain ${LOCAL_CHAIN_ID}); reusing it. stack:down will not stop it`);
      state.reused.anvil = ANVIL_PORT;
      state.anvil = undefined;
    }
    return;
  }
  if (!(await portFree(ANVIL_PORT))) fail(`port ${ANVIL_PORT} is in use by something that is not a JSON-RPC node. Free it and retry.`);
  const pid = startDetached("anvil", "anvil", ["--host", HOST, "--port", String(ANVIL_PORT)]);
  state.anvil = { pid, port: ANVIL_PORT, started: new Date().toISOString(), cmd: "anvil" };
  delete state.reused.anvil;
  writeState(state);
  await waitFor(async () => (await rpc("eth_chainId")) !== undefined, "anvil", 15_000);
  step("anvil", `started on ${HOST}:${ANVIL_PORT} (pid ${pid}), a fresh chain`);
}

function ensureContractsBuilt(): void {
  if (existsSync(resolve(root, "contracts/out"))) {
    step("contracts", "contracts/out exists; not rebuilding");
    return;
  }
  step("contracts", "contracts/out missing: running forge build");
  try {
    execFileSync("forge", ["build"], { cwd: resolve(root, "contracts"), stdio: ["ignore", "inherit", "inherit"] });
  } catch {
    fail("forge build failed (see its output above).");
  }
}

type LocalConfig = { contracts: { zeroDrop: string } };

async function hasCode(address: string): Promise<boolean> {
  const code = await rpc("eth_getCode", [address, "latest"]);
  return typeof code === "string" && code !== "0x" && code.length > 2;
}

function readConfig(): LocalConfig | undefined {
  try {
    return JSON.parse(readFileSync(configPath, "utf8")) as LocalConfig;
  } catch {
    return undefined;
  }
}

/** Returns true when a new deployment was made. */
async function ensureDeployment(): Promise<boolean> {
  const config = readConfig();
  const address = config?.contracts?.zeroDrop;
  if (address && (await hasCode(address))) {
    step("deploy", `${configRel}: ZeroDrop ${address} has code on the chain; reusing it`);
    return false;
  }
  step("deploy", address ? `${configRel}: ZeroDrop ${address} has no code on this chain; deploying the mock deployment` : `${configRel} missing; deploying the mock deployment`);
  runScript("deploy", ["scripts/deploy.ts", "--mock", "--out", configRel]);
  const after = readConfig();
  if (!after?.contracts?.zeroDrop || !(await hasCode(after.contracts.zeroDrop))) fail(`deploy finished but ${configRel} does not point at a contract with code.`);
  step("deploy", `ZeroDrop at ${after.contracts.zeroDrop}`);
  return true;
}

async function groupOnChain(zeroDrop: string, groupId: string, root256: string): Promise<boolean> {
  // groups(uint256) returns (address issuer, uint32 size, uint32 minSize, uint256 root); a missing group has issuer 0.
  const { createPublicClient, http } = await import("viem");
  const { zeroDropAbi } = await import("../packages/core/src/abi.ts");
  try {
    const client = createPublicClient({ transport: http(`http://${HOST}:${ANVIL_PORT}`) });
    const [issuer, , , onChainRoot] = (await client.readContract({
      address: zeroDrop as `0x${string}`,
      abi: zeroDropAbi,
      functionName: "groups",
      args: [BigInt(groupId)],
    })) as readonly [string, number, number, bigint];
    return issuer !== zeroAddress && onChainRoot === BigInt(root256);
  } catch {
    return false;
  }
}

async function ensureGroup(redeployed: boolean): Promise<void> {
  const zeroDrop = readConfig()?.contracts.zeroDrop as string;
  if (!redeployed && existsSync(demoPath)) {
    try {
      const demo = JSON.parse(readFileSync(demoPath, "utf8")) as { groupId?: string; root?: string; members?: string[] };
      if (demo.groupId && demo.root && (await groupOnChain(zeroDrop, demo.groupId, demo.root))) {
        step("group", `${demoRel}: group ${demo.groupId} is on chain with the same root; reusing it`);
        return;
      }
      step("group", "demo members file does not match a group on this chain; seeding a new group");
    } catch {
      step("group", "demo members file is unreadable; seeding a new group");
    }
  } else step("group", existsSync(demoPath) ? "new deployment: seeding a new group" : "no demo members file: seeding a group");
  runScript("seed-group", ["scripts/seed-group.ts", "4", "3"], { CONFIG: configRel });
}

async function pinnerHealthy(port: number): Promise<boolean> {
  const res = await timed(`http://${HOST}:${port}/health`);
  if (!res?.ok) return false;
  try {
    return ((await res.json()) as { ok?: boolean }).ok === true;
  } catch {
    return false;
  }
}

async function ensurePinner(state: StackState): Promise<number> {
  if (isOurs(state.pinner) && (await pinnerHealthy(state.pinner.port))) {
    step("pinner", `running on ${HOST}:${state.pinner.port} (pid ${state.pinner.pid}); reusing it`);
    return state.pinner.port;
  }
  if (state.pinner && isOurs(state.pinner)) await stopProc("pinner", state.pinner); // alive but unhealthy
  const port = await firstFreePort(PINNER_START, state.ports.pinner);
  const pid = startDetached("pinner", resolve(root, "node_modules/.bin/tsx"), ["scripts/pinner.ts", "--port", String(port), "--host", HOST]);
  state.pinner = { pid, port, started: new Date().toISOString(), cmd: "pinner.ts" };
  state.ports.pinner = port;
  writeState(state);
  await waitFor(() => pinnerHealthy(port), "the pinner");
  const note = port === PINNER_START ? "" : port - 1 === PINNER_START ? ` (${PINNER_START} is busy)` : ` (${PINNER_START}-${port - 1} include busy ports)`;
  step("pinner", `started on ${HOST}:${port}${note} (pid ${pid})`);
  return port;
}

/** Writes apps/web/.env.local when it is ours or absent. Returns true when the file changed. */
function writeEnvLocal(pinnerPort: number): boolean {
  const lines = [ENV_MARK, `VITE_ZERODROP_PINNER_URL=http://${HOST}:${pinnerPort}`];
  if (KUBO_API !== 15001) lines.push(`VITE_KUBO_API_URL=http://${HOST}:${KUBO_API}`);
  if (KUBO_GATEWAY !== 18080) lines.push(`VITE_KUBO_GATEWAY_URL=http://${HOST}:${KUBO_GATEWAY}`);
  const body = `${lines.join("\n")}\n`;
  if (existsSync(envLocal)) {
    const current = readFileSync(envLocal, "utf8");
    if (!current.startsWith(ENV_MARK)) {
      step("web env", "apps/web/.env.local exists and was not written by stack:up; leaving it. Make sure it sets:");
      say(`             VITE_ZERODROP_PINNER_URL=http://${HOST}:${pinnerPort}`);
      return false;
    }
    if (current === body) return false;
  }
  writeFileSync(envLocal, body);
  step("web env", `wrote apps/web/.env.local: VITE_ZERODROP_PINNER_URL=http://${HOST}:${pinnerPort}`);
  return true;
}

async function kuboUp(): Promise<boolean> {
  const res = await timed(`http://${HOST}:${KUBO_API}/api/v0/id`, { method: "POST" });
  return !!res?.ok;
}

async function ensureKubo(state: StackState, vitePort: number): Promise<void> {
  if (await kuboUp()) {
    if (isOurs(state.kubo)) step("kubo", `running, started by stack:up (pid ${state.kubo.pid}), offline`);
    else {
      step("kubo", `a Kubo API already answers on ${HOST}:${KUBO_API}; reusing it. stack:down will not stop it`);
      state.reused.kubo = KUBO_API;
      state.kubo = undefined;
      const peers = await timed(`http://${HOST}:${KUBO_API}/api/v0/swarm/peers`, { method: "POST" });
      if (peers?.ok) step("kubo", "WARNING: that node answers swarm/peers, so it is probably ONLINE. A disclosure pinned there is announced to the network. Restart it with --offline.");
    }
    return;
  }
  if (!(await portFree(KUBO_API)) || !(await portFree(KUBO_GATEWAY))) {
    step("kubo", `ports ${KUBO_API}/${KUBO_GATEWAY} are in use by something that is not Kubo; skipping the Kubo node`);
    return;
  }
  const env: NodeJS.ProcessEnv = { ...process.env, IPFS_PATH: kuboRepo };
  const ipfs = (...args: string[]) => execFileSync("ipfs", args, { env, stdio: ["ignore", "ignore", "inherit"] });
  if (!existsSync(resolve(kuboRepo, "config"))) {
    mkdirSync(kuboRepo, { recursive: true });
    ipfs("init", "--empty-repo");
    step("kubo", `initialised repo ${kuboRepo}`);
  }
  // Re-applied on every start so the repo can never drift to a networked configuration.
  const origins = JSON.stringify([`http://${HOST}:${vitePort}`, `http://localhost:${vitePort}`]);
  ipfs("config", "Addresses.API", `/ip4/${HOST}/tcp/${KUBO_API}`);
  ipfs("config", "Addresses.Gateway", `/ip4/${HOST}/tcp/${KUBO_GATEWAY}`);
  ipfs("config", "--json", "Addresses.Swarm", `["/ip4/${HOST}/tcp/0"]`);
  ipfs("config", "--json", "Bootstrap", "[]");
  ipfs("config", "--json", "Discovery.MDNS.Enabled", "false");
  ipfs("config", "--json", "Swarm.DisableNatPortMap", "true");
  ipfs("config", "Routing.Type", "none");
  ipfs("config", "--json", "API.HTTPHeaders.Access-Control-Allow-Origin", origins);
  ipfs("config", "--json", "API.HTTPHeaders.Access-Control-Allow-Methods", '["PUT","POST","GET"]');
  const pid = startDetached("kubo", "ipfs", ["daemon", "--offline"], { env });
  state.kubo = { pid, port: KUBO_API, started: new Date().toISOString(), cmd: "ipfs daemon" };
  writeState(state);
  await waitFor(kuboUp, "the Kubo node");
  step("kubo", `started OFFLINE (no bootstrap peers, no DHT) on API ${HOST}:${KUBO_API}, gateway ${HOST}:${KUBO_GATEWAY} (pid ${pid}); repo ${kuboRepo}`);
}

async function viteUp(port: number): Promise<boolean> {
  const res = await timed(`http://${HOST}:${port}/`);
  return !!res?.ok;
}

async function ensureVite(state: StackState, restart: boolean, preferred: number): Promise<number> {
  if (isOurs(state.vite) && (await viteUp(state.vite.port))) {
    if (!restart) {
      step("web", `dev server running on ${HOST}:${state.vite.port} (pid ${state.vite.pid}); reusing it`);
      return state.vite.port;
    }
    await stopProc("web", state.vite);
    await sleep(500);
  } else if (state.vite && isOurs(state.vite)) await stopProc("web", state.vite);
  const port = (await portFree(preferred)) ? preferred : await firstFreePort(VITE_START);
  const vite = resolve(root, "apps/web/node_modules/.bin/vite");
  const pid = startDetached("vite", vite, ["--host", HOST, "--port", String(port), "--strictPort"], { cwd: resolve(root, "apps/web") });
  state.vite = { pid, port, started: new Date().toISOString(), cmd: "vite" };
  state.ports.vite = port;
  writeState(state);
  await waitFor(() => viteUp(port), "the vite dev server", 40_000);
  step("web", `dev server started on ${HOST}:${port} (pid ${pid})`);
  return port;
}

// --- commands --------------------------------------------------------------------------------

async function up(flags: Set<string>): Promise<void> {
  const state = readState();
  say("ZeroDrop local stack");
  say("Prerequisites");
  const { ipfs } = checkPrerequisites(!flags.has("--no-kubo"));
  say("Chain");
  await ensureAnvil(state);
  ensureContractsBuilt();
  const redeployed = await ensureDeployment();
  await ensureGroup(redeployed);
  say("Services");
  const pinnerPort = await ensurePinner(state);
  const envChanged = writeEnvLocal(pinnerPort);
  const vitePort = isOurs(state.vite) ? state.vite.port : await firstFreePort(VITE_START, state.ports.vite);
  let webPort = vitePort;
  if (ipfs) await ensureKubo(state, vitePort);
  if (!flags.has("--no-web")) {
    // A new deployment changes config/*.json, which vite reads at startup, so restart a running dev server.
    webPort = await ensureVite(state, redeployed || envChanged, vitePort);
  }
  writeState(state);
  const config = readConfig();
  say();
  say("Ready");
  if (!flags.has("--no-web")) say(`  Web app          http://${HOST}:${webPort}/`);
  say(`  Chain RPC        http://${HOST}:${ANVIL_PORT} (chain ${LOCAL_CHAIN_ID}, mock verifier, ZeroDrop ${config?.contracts.zeroDrop})`);
  say(`  Pinner           http://${HOST}:${pinnerPort}  (health: /health)`);
  say(`  Web env          VITE_ZERODROP_PINNER_URL=http://${HOST}:${pinnerPort}   (in apps/web/.env.local)`);
  if (ipfs && (await kuboUp())) say(`  Kubo (offline)   API http://${HOST}:${KUBO_API}  gateway http://${HOST}:${KUBO_GATEWAY}`);
  say("  Demo identity    open the app in dev mode and use \"Load demo identity (dev only)\" on the Post page");
  say("  Mock proofs      this deployment accepts any proof; nothing here is a membership proof");
  say(`  Logs             ${logDir}/   Stop: pnpm stack:down   Status: pnpm stack:status`);
}

async function status(): Promise<void> {
  const state = readState();
  say("ZeroDrop local stack");
  const row = (name: string, up: boolean, detail: string) => say(`  ${name.padEnd(12)} ${up ? "UP  " : "DOWN"} ${detail}`);

  const chainId = await rpc("eth_chainId");
  const anvilUp = chainId !== undefined;
  row("anvil", anvilUp, anvilUp ? `${HOST}:${ANVIL_PORT} chain ${parseInt(chainId, 16)}, ${isOurs(state.anvil) ? `started by stack:up (pid ${state.anvil.pid})` : "not started by stack:up"}` : `${HOST}:${ANVIL_PORT}`);

  const address = readConfig()?.contracts?.zeroDrop;
  if (address) row("contract", anvilUp && (await hasCode(address)), `ZeroDrop ${address} (${configRel})`);
  else row("contract", false, `${configRel} missing`);
  row("demo group", existsSync(demoPath), existsSync(demoPath) ? demoRel : "not seeded");

  const pinnerPort = state.pinner?.port;
  const pinnerOk = pinnerPort ? await pinnerHealthy(pinnerPort) : false;
  row("pinner", pinnerOk, pinnerPort ? `${HOST}:${pinnerPort}${isOurs(state.pinner) ? ` (pid ${state.pinner?.pid})` : " (recorded process is gone)"}` : "not started by stack:up");

  const kubo = await kuboUp();
  row("kubo", kubo, kubo ? `API ${HOST}:${KUBO_API}, ${isOurs(state.kubo) ? `started by stack:up (pid ${state.kubo.pid})` : "not started by stack:up"}` : `API ${HOST}:${KUBO_API} (optional)`);

  const vitePort = state.vite?.port;
  const viteOk = vitePort ? await viteUp(vitePort) : false;
  row("web", viteOk, vitePort ? `http://${HOST}:${vitePort}/${isOurs(state.vite) ? ` (pid ${state.vite?.pid})` : " (recorded process is gone)"}` : "not started by stack:up");

  const reused = Object.keys(state.reused);
  if (reused.length) say(`  Reused (never stopped by stack:down): ${reused.join(", ")}`);
}

async function down(): Promise<void> {
  const state = readState();
  say("Stopping what stack:up started");
  // Reverse order of start.
  let any = false;
  for (const [name, proc] of [
    ["web", state.vite],
    ["kubo", state.kubo],
    ["pinner", state.pinner],
    ["anvil", state.anvil],
  ] as const) {
    if (!proc) continue;
    any = (await stopProc(name, proc)) || any;
  }
  if (!any) say("  nothing recorded in .local/stack.pids is running");
  if (state.reused.anvil || state.reused.kubo) say(`  left running (not started by stack:up): ${Object.keys(state.reused).join(", ")}`);
  if (existsSync(envLocal) && readFileSync(envLocal, "utf8").startsWith(ENV_MARK)) {
    rmSync(envLocal);
    say("  removed apps/web/.env.local (written by stack:up)");
  }
  rmSync(pidFile, { force: true });
  say("Done.");
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2).filter((a, i) => !(i === 0 && a === "--"));
  const flags = new Set(rest);
  switch (command) {
    case "up":
      return up(flags);
    case "down":
      return down();
    case "status":
      return status();
    default:
      say("usage: tsx scripts/stack.ts <up|down|status> [--no-kubo] [--no-web]");
      process.exit(command ? 1 : 0);
  }
}

main().catch((error) => {
  console.error(`stack: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
