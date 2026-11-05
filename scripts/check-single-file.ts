/**
 * Asserts that the web build is ONE self-contained HTML file.
 *
 *   pnpm tsx scripts/check-single-file.ts [path/to/index.html]      (default: apps/web/dist/index.html)
 *
 * Fails (exit 1) when
 *   - the dist directory holds anything besides the one HTML file;
 *   - a markup element loads something by URL that is not inline: <script src>, <link href> (stylesheet, icon,
 *     preload ...), <img|source|video|audio|track|iframe|embed src>, <object data>, <use href> to a file,
 *     <meta http-equiv="refresh">, any http(s):// or protocol-relative // target, or a relative file path;
 *   - an inline <style> pulls a url(...) or @import that is not a data: / blob: / fragment URI;
 *   - there is no inline <script>.
 *
 * Reports but does not fail on
 *   - http(s) URL strings that appear inside the inlined JavaScript or CSS text (they are constants such as
 *     default endpoints or links; whether the app ever requests them is enforced by the CSP, not by this check);
 *   - CSP weaknesses ('unsafe-inline' / 'unsafe-eval' in script-src, a missing connect-src, wildcard sources).
 *
 * This is a static text check. It does not execute the page (that is `file://` in a browser: see evidence/ipfs-pin.md).
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const file = resolve(process.argv[2] ?? resolve(root, "apps/web/dist/index.html"));

const violations: string[] = [];
const notes: string[] = [];

const html = readFileSync(file, "utf8");
const dir = dirname(file);

// 1. The directory must hold only this file.
const siblings = readdirSync(dir).filter((n) => n !== basename(file));
if (siblings.length > 0) violations.push(`dist directory has other entries next to ${basename(file)}: ${siblings.join(", ")}`);

// Strip the bodies of inline <script> and <style> so the tag scan sees markup only.
const markup = html
  .replace(/(<script\b[^>]*>)[\s\S]*?(<\/script>)/gi, "$1$2")
  .replace(/(<style\b[^>]*>)[\s\S]*?(<\/style>)/gi, "$1$2");

const isInlineUri = (value: string) => /^(data:|blob:|#|about:blank$)/i.test(value.trim());
const isRemote = (value: string) => /^(https?:)?\/\//i.test(value.trim());

function attr(tag: string, name: string): string | undefined {
  const m = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  return m ? (m[2] ?? m[3] ?? m[4]) : undefined;
}

const LOADS: Array<{ tag: string; attrs: string[] }> = [
  { tag: "script", attrs: ["src"] },
  { tag: "link", attrs: ["href", "imagesrcset"] },
  { tag: "img", attrs: ["src", "srcset"] },
  { tag: "source", attrs: ["src", "srcset"] },
  { tag: "video", attrs: ["src", "poster"] },
  { tag: "audio", attrs: ["src"] },
  { tag: "track", attrs: ["src"] },
  { tag: "iframe", attrs: ["src"] },
  { tag: "embed", attrs: ["src"] },
  { tag: "object", attrs: ["data"] },
  { tag: "input", attrs: ["src"] },
  { tag: "image", attrs: ["href", "xlink:href"] },
  { tag: "use", attrs: ["href", "xlink:href"] },
];

let checkedTags = 0;
for (const { tag, attrs } of LOADS) {
  for (const m of markup.matchAll(new RegExp(`<${tag}\\b[^>]*>`, "gi"))) {
    checkedTags += 1;
    for (const name of attrs) {
      const value = attr(m[0], name);
      if (value === undefined || value === "") continue;
      if (isInlineUri(value)) continue;
      const kind = isRemote(value) ? "REMOTE" : "external file";
      violations.push(`<${tag} ${name}="${value.length > 80 ? value.slice(0, 77) + "..." : value}"> is an ${kind} reference`);
    }
  }
}

for (const m of markup.matchAll(/<meta\b[^>]*>/gi)) {
  if (/http-equiv\s*=\s*["']?refresh/i.test(m[0])) violations.push(`meta refresh found: ${m[0]}`);
}
for (const m of markup.matchAll(/<base\b[^>]*>/gi)) violations.push(`<base> tag found: ${m[0]}`);

// 2. Inline <style>: url() and @import.
for (const m of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
  const css = m[1] ?? "";
  for (const u of css.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi)) {
    const value = (u[2] ?? "").trim();
    if (!isInlineUri(value)) violations.push(`inline CSS url(${value.slice(0, 80)}) is not a data: URI`);
  }
  for (const i of css.matchAll(/@import\s+(?:url\()?\s*['"]?([^'")\s;]+)/gi)) {
    violations.push(`inline CSS @import ${i[1]}`);
  }
}

// 3. There must be an inline script (otherwise this is not the single-file build).
const inlineScripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].filter((m) => !/\bsrc\s*=/.test(m[1] ?? ""));
if (inlineScripts.length === 0) violations.push("no inline <script> found: this is not the single-file build");
const inlineBytes = inlineScripts.reduce((n, m) => n + Buffer.byteLength(m[2] ?? ""), 0);

// 4. Informational: URL strings inside the inlined code.
const urls = new Set<string>();
for (const m of html.matchAll(/https?:\/\/[A-Za-z0-9._~:/?#@!$&'()*+,;=%[\]-]+/g)) urls.add(m[0].replace(/[),.;'"`$]+$/, ""));
const hosts = new Map<string, number>();
for (const u of urls) {
  try {
    const host = new URL(u).host;
    hosts.set(host, (hosts.get(host) ?? 0) + 1);
  } catch {
    /* template fragments such as http://${host} are not parseable: ignore */
  }
}

// 5. Informational: CSP.
const cspMatch = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"/i.exec(html);
let csp = "(none)";
if (!cspMatch) {
  notes.push("WARN no Content-Security-Policy <meta> found");
} else {
  csp = (cspMatch[1] ?? "").replace(/\s+/g, " ").trim();
  const directives = new Map<string, string[]>();
  for (const part of csp.split(";")) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name) directives.set(name.toLowerCase(), sources);
  }
  const script = directives.get("script-src") ?? directives.get("default-src") ?? [];
  if (script.includes("'unsafe-inline'")) notes.push("WARN script-src allows 'unsafe-inline'");
  if (script.includes("'unsafe-eval'")) notes.push("WARN script-src allows 'unsafe-eval'");
  if (script.includes("data:")) notes.push("WARN script-src allows data: (the Firefox harness workaround weakens script-src)");
  if (script.includes("'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='")) notes.push("WARN script-src still has the placeholder hash");
  const connect = directives.get("connect-src");
  if (!connect) notes.push("WARN no connect-src directive");
  else {
    if (connect.includes("*")) notes.push("WARN connect-src has a bare wildcard");
    const local = connect.filter((s) => /127\.0\.0\.1|localhost/.test(s));
    if (local.length) notes.push(`INFO connect-src allows loopback origins: ${local.join(" ")}`);
    const remote = connect.filter((s) => /^https?:\/\/(?!127\.0\.0\.1|localhost)/.test(s));
    if (remote.length) notes.push(`INFO connect-src allows remote origins: ${remote.join(" ")}`);
  }
}

const size = statSync(file).size;
console.log(`file            ${file}`);
console.log(`size            ${size} bytes`);
console.log(`inline scripts  ${inlineScripts.length} (${inlineBytes} bytes of code)`);
console.log(`tags checked    ${checkedTags} loading elements outside inline script/style bodies`);
console.log(`CSP             ${csp}`);
console.log(`URL strings     ${urls.size} distinct http(s) strings inside the inlined code, ${hosts.size} hosts (strings, not loads; the CSP governs requests)`);
for (const [host, n] of [...hosts].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`                  ${host} (${n})`);
for (const n of notes) console.log(n);

if (violations.length > 0) {
  console.log(`\nFAIL: not a single self-contained file (${violations.length} problem${violations.length === 1 ? "" : "s"})`);
  for (const v of violations) console.log(`  - ${v}`);
  process.exit(1);
}
console.log("\nOK: one HTML file, no external script/link/img/iframe/css references");
