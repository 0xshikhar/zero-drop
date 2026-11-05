/**
 * Opens the built single file from a file:// URL in headless Chrome and checks that
 *   - the app root rendered (#root has children, the page text contains "ZeroDrop"),
 *   - the browser logged no Content-Security-Policy violation and no uncaught error.
 *
 *   pnpm tsx scripts/check-file-url.ts [path/to/index.html]       (default: apps/web/dist/index.html)
 *   CHROME=/path/to/chrome pnpm tsx scripts/check-file-url.ts
 *
 * The file is copied to a fresh temporary directory first, so the page cannot find sibling files and the check
 * proves the single file works on its own. Console lines come from Chrome's `--enable-logging=stderr`. Needs a
 * Chrome or Chromium binary; exits 2 (not a failure of the app) when none is found.
 * It is a headless smoke test: no wallet, no chain, no Tor. It says nothing about the posting flow.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const file = resolve(process.argv[2] ?? resolve(root, "apps/web/dist/index.html"));

const candidates = [
  process.env.CHROME,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].filter((c): c is string => Boolean(c));
const chrome = candidates.find((c) => existsSync(c));
if (!chrome) {
  console.error("no Chrome/Chromium found (set CHROME=/path/to/binary)");
  process.exit(2);
}

const dir = mkdtempSync(join(tmpdir(), "zerodrop-file-"));
const profile = mkdtempSync(join(tmpdir(), "zerodrop-chrome-"));
try {
  const copy = join(dir, "index.html");
  copyFileSync(file, copy);
  const url = `file://${copy}`;
  const run = spawnSync(
    chrome,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      `--user-data-dir=${profile}`,
      "--enable-logging=stderr",
      "--v=0",
      "--virtual-time-budget=15000",
      "--dump-dom",
      url,
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 90_000 },
  );
  if (run.error) throw run.error;
  const dom = run.stdout ?? "";
  const consoleLines = (run.stderr ?? "").split("\n").filter((l) => l.includes(":CONSOLE"));
  const csp = consoleLines.filter((l) => /Content Security Policy|Refused to|violates the/i.test(l));
  const errors = consoleLines.filter((l) => /Uncaught|ERROR:CONSOLE|is not defined|Failed to load/i.test(l));

  const body = dom.slice(dom.lastIndexOf("<body")).replace(/<script\b[\s\S]*?<\/script>/gi, "").replace(/<style\b[\s\S]*?<\/style>/gi, "");
  const rootHasChildren = /<div id="root">\s*<[a-z]/i.test(body);
  const text = body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

  console.log(`chrome          ${chrome}`);
  console.log(`url             ${url} (copy of ${file})`);
  console.log(`root rendered   ${rootHasChildren}`);
  console.log(`page text       ${text.slice(0, 160)}${text.length > 160 ? "..." : ""}`);
  console.log(`console lines   ${consoleLines.length}`);
  for (const l of consoleLines.slice(0, 20)) console.log(`  ${l.replace(/^\[[^\]]*\]\s*/, "").slice(0, 240)}`);
  console.log(`CSP violations  ${csp.length}`);
  console.log(`errors          ${errors.length}`);

  const ok = rootHasChildren && /ZeroDrop/.test(text) && csp.length === 0 && errors.length === 0;
  console.log(ok ? "\nOK: renders from file:// with no CSP violation and no console error" : "\nFAIL");
  process.exit(ok ? 0 : 1);
} finally {
  rmSync(dir, { recursive: true, force: true });
  rmSync(profile, { recursive: true, force: true });
}
