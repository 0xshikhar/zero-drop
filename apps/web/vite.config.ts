import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";

/**
 * CSP hardening for the single-file build (see the <meta http-equiv="Content-Security-Policy"> in index.html).
 *
 * vite-plugin-singlefile turns the app into inline <script>/<style>, which a CSP without 'unsafe-inline'
 * blocks. This plugin runs after it and replaces the placeholder hash in index.html with the sha256 of
 * every inline <script> and <style> in the final HTML, so the build runs with NO 'unsafe-inline' and
 * 'self' is removed from script-src/style-src (nothing external is loaded). In `vite dev` it allows
 * 'unsafe-inline' instead (the React refresh preamble is inline) and the HMR websocket.
 *
 * The Anon-RPC harness needs one more script hash. Its iframe is built from `srcdoc` with an inline
 * bootstrap script, and a srcdoc document inherits this page's CSP, so that exact script text must be
 * hash-allowed too. The text is read from the harness build (the very string host.js embeds), so the
 * hash follows the installed version. Everything else the harness needs (worker runtime, iframe boot
 * source) is embedded in host.js as strings: there are no separate asset files to ship.
 *
 * Environment knobs read at build/dev time:
 * - ZERODROP_CSP_CONNECT="https://rpc.example https://pin.example"  extra connect-src origins.
 * - ZERODROP_CSP_LOCAL=0  drop the http/ws://127.0.0.1:* and localhost:* entries (production hosting).
 * - ZERODROP_CSP_FIREFOX=1  add `data:` to script-src. Firefox refuses importScripts(blob:) in the
 *   harness' opaque-origin worker and falls back to a data: URL (harness README). Weakens script-src.
 */

const PLACEHOLDER_HASH = "'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='";
const LOCAL_SOURCES = ["http://127.0.0.1:*", "http://localhost:*"];
const LOCAL_WS_SOURCES = ["ws://127.0.0.1:*", "ws://localhost:*"];
const CSP_META = /(<meta\s+http-equiv="Content-Security-Policy"\s+content=")([^"]*)(")/i;

const sha256 = (text: string) => `'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`;

/** The inline bootstrap script AnonRpcWorker puts in its srcdoc iframe, exactly as host.js embeds it. */
function harnessBootScript(): string {
  const corePackage = fileURLToPath(new URL("../../packages/core/package.json", import.meta.url));
  const require = createRequire(corePackage);
  const hostJs = readFileSync(require.resolve("@anon-rpc/browser-harness"), "utf8");
  const bootFile = readFileSync(require.resolve("@anon-rpc/browser-harness/iframe-boot.js"), "utf8");
  const embedded = /<script>\$\{('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")\}<\\\/script>/.exec(hostJs);
  if (!embedded) throw new Error("CSP: could not find the iframe bootstrap script in @anon-rpc/browser-harness host.js");
  // The match is a single string literal (the regex allows nothing else), so evaluating it only unescapes it.
  const text = new Function(`return ${embedded[1]}`)() as string;
  if (text !== bootFile) {
    console.warn("[csp] harness host.js embeds a bootstrap script that differs from dist/iframe-boot.js; hashing the embedded one");
  }
  return text;
}

function parsePolicy(policy: string): Map<string, string[]> {
  const directives = new Map<string, string[]>();
  for (const part of policy.split(";")) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name) directives.set(name.toLowerCase(), sources);
  }
  return directives;
}

const serializePolicy = (d: Map<string, string[]>) =>
  [...d].map(([name, sources]) => [name, ...sources].join(" ")).join("; ");

type Rewrite = { dev: boolean; scriptHashes: string[]; styleHashes: string[] };

function rewriteCsp(html: string, { dev, scriptHashes, styleHashes }: Rewrite): string {
  const match = CSP_META.exec(html);
  if (!match) throw new Error('index.html has no <meta http-equiv="Content-Security-Policy" content="..."> tag');
  const d = parsePolicy(match[2]!.replace(/\s+/g, " "));
  const get = (name: string) => d.get(name) ?? [];
  const without = (sources: string[], ...drop: string[]) => sources.filter((s) => !drop.includes(s));

  if (dev) {
    d.set("script-src", [...without(get("script-src"), PLACEHOLDER_HASH), "'unsafe-inline'"]);
    d.set("style-src", [...without(get("style-src"), PLACEHOLDER_HASH), "'unsafe-inline'"]);
    d.set("connect-src", [...get("connect-src"), ...LOCAL_WS_SOURCES]);
  } else {
    d.set("script-src", [...without(get("script-src"), PLACEHOLDER_HASH, "'self'"), ...scriptHashes]);
    d.set("style-src", [...without(get("style-src"), PLACEHOLDER_HASH, "'self'"), ...styleHashes]);
    if (styleHashes.length === 0) d.set("style-src", ["'none'"]);
  }
  if (process.env.ZERODROP_CSP_LOCAL === "0") {
    d.set("connect-src", get("connect-src").filter((s) => ![...LOCAL_SOURCES, ...LOCAL_WS_SOURCES].includes(s)));
  }
  const defaultConnect = [
    "https://ethereum-rpc.publicnode.com",
    "https://cdn.jsdelivr.net",
    "https://unpkg.com",
    "https://raw.githubusercontent.com",
    "https://altmempool.forshtat.com",
    "https://altmempoolgateway.forshtat.com",
    "https://ethereum-sepolia-rpc.publicnode.com",
    "https://gateway.pinata.cloud",
    "https://cloudflare-ipfs.com",
  ];
  const extra = (process.env.ZERODROP_CSP_CONNECT ?? "").split(/\s+/).filter(Boolean);
  d.set("connect-src", [...new Set([...get("connect-src"), ...defaultConnect, ...extra])]);
  if (process.env.ZERODROP_CSP_FIREFOX === "1") d.set("script-src", [...get("script-src"), "data:"]);

  return html.replace(CSP_META, (_m, open: string, _content: string, close: string) => `${open}${serializePolicy(d)}${close}`);
}

function inlineHashes(html: string): { scripts: string[]; styles: string[] } {
  const scripts = new Set<string>();
  const styles = new Set<string>();
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (!/\bsrc\s*=/.test(m[1] ?? "")) scripts.add(sha256(m[2] ?? ""));
  }
  for (const m of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) styles.add(sha256(m[1] ?? ""));
  return { scripts: [...scripts], styles: [...styles] };
}

export function zerodropCsp(): Plugin {
  let bootHash: string | undefined;
  return {
    name: "zerodrop:csp",
    // After vite-plugin-singlefile (listed before this one), so the HTML already holds the inlined code.
    enforce: "post",
    transformIndexHtml: {
      order: "post",
      handler(html, ctx) {
        // Dev server only. In a build the HTML is rewritten in generateBundle, after inlining.
        if (!ctx.server) return html;
        return rewriteCsp(html, { dev: true, scriptHashes: [], styleHashes: [] });
      },
    },
    generateBundle: {
      order: "post",
      handler(_options, bundle) {
        bootHash ??= sha256(harnessBootScript());
        for (const [name, chunk] of Object.entries(bundle)) {
          if (chunk.type !== "asset" || !/\.html?$/.test(name) || typeof chunk.source !== "string") continue;
          const { scripts, styles } = inlineHashes(chunk.source);
          if (scripts.length === 0) this.warn(`${name}: no inline <script> found; expected the single-file build`);
          chunk.source = rewriteCsp(chunk.source, { dev: false, scriptHashes: [...scripts, bootHash], styleHashes: styles });
        }
      },
    },
  };
}

export default defineConfig({
  plugins: [react(), viteSingleFile(), zerodropCsp()],
  build: { target: "es2022", cssCodeSplit: false, assetsInlineLimit: 100_000_000 },
});
