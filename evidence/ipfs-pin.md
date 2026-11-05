# Single-file build, IPFS pin, `file://` load

Run on 2026-11-05 about 21:29 UTC (this machine's clock). Local only: the pin went into a throwaway **offline** Kubo 0.43.1 node (API `127.0.0.1:15001`, gateway `127.0.0.1:18080`). **Nothing was published to the public IPFS network and nothing was announced to the DHT**; the script refuses to pin into a node that is online or not on loopback. So there is **no public CID yet**.

The app was being edited by someone else while this ran, so the file changed between runs. Earlier runs the same hour: 1,223,470 bytes (sha256 `1840c439...`, CID `bafkreiayidcdsnqkfjkqhkjdi2mu7j47xnq7gup4czl4ap73uc5jic23dm`), also byte-identical across two clean builds and also pinned and read back. The record below is the last run.

## Command

`scripts/build-ipfs.sh --repro --pin`, then `pnpm tsx scripts/check-file-url.ts`.

## Output of `scripts/build-ipfs.sh --repro --pin`, verbatim

```
== environment
node v24.10.0, pnpm 10.0.0, kubo 0.43.1
== build
== reproducibility: second clean build (F17)
build 1 sha256 89d9c1925acd4a15de89f2fc5dd68be2d7aaf6b1610b52ca7d557f3c57cdfd2e
build 2 sha256 89d9c1925acd4a15de89f2fc5dd68be2d7aaf6b1610b52ca7d557f3c57cdfd2e
REPRODUCIBLE: byte-identical across two clean builds (same machine, same path, same node/pnpm)
== single-file check
file            /Users/shikharsingh/Downloads/code/realfi/eth-mumbai/apps/web/dist/index.html
size            1908985 bytes
inline scripts  1 (1891463 bytes of code)
tags checked    1 loading elements outside inline script/style bodies
CSP             default-src 'none'; script-src blob: 'wasm-unsafe-eval' 'sha256-COX+YdPk02PxlQ79ensUZBet+GBAughVD/w4tPEDuaI=' 'sha256-Ym3P8QZAOfAK6j+zXubnGqDWrzVmA+sAoh1BfdRj0+s='; style-src 'sha256-p3F1+D1EC0GnA7yPlaqIZ5osc44hssIXjFbcSU/YLl0='; connect-src 'self' data: blob: http://127.0.0.1:* http://localhost:*; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' blob:; worker-src blob:; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'
URL strings     34 distinct http(s) strings inside the inlined code, 18 hosts (strings, not loads; the CSP governs requests)
                  github.com (11)
                  www.w3.org (4)
                  feross.org (2)
                  react.dev (1)
                  abitype.dev (1)
                  docs.soliditylang.org (1)
                  viem.sh (1)
                  4byte.sourcify.dev (1)
                  oxlib.sh (1)
                  ipfs.io (1)
                  arweave.net (1)
                  ns.adobe.com (1)
INFO connect-src allows loopback origins: http://127.0.0.1:* http://localhost:*

OK: one HTML file, no external script/link/img/iframe/css references
== identity (our own cidFor, packages/core)
file          /Users/shikharsingh/Downloads/code/realfi/eth-mumbai/apps/web/dist/index.html
bytes         1908985
sha256        89d9c1925acd4a15de89f2fc5dd68be2d7aaf6b1610b52ca7d557f3c57cdfd2e
cidFor (v1 raw sha2-256, one block)  bafkreiej3hazewwnjik55cps7ro5nc7c26vpnmlbbnjmu7kvp46fptp5fy
== Kubo (hash only, nothing stored)
file size                      1908985 bytes
ipfs add --cid-version=1       bafybeic3dn4xhqxyjdsxonxwfcgu4o2mrlqlg6dctimk5y52rn6bdbk6zq    (default chunker; UnixFS DAG root: the portable CID)
ipfs add --raw-leaves --chunker=size-2096896  bafkreiej3hazewwnjik55cps7ro5nc7c26vpnmlbbnjmu7kvp46fptp5fy    (single raw block)
MATCH: Kubo's single-block CID equals cidFor (bafkreiej3hazewwnjik55cps7ro5nc7c26vpnmlbbnjmu7kvp46fptp5fy)
== pin into the local offline node and read back through its gateway
node is offline (swarm peers: "must be run in online mode")
pinned  bafybeic3dn4xhqxyjdsxonxwfcgu4o2mrlqlg6dctimk5y52rn6bdbk6zq (DAG)
pinned  bafkreiej3hazewwnjik55cps7ro5nc7c26vpnmlbbnjmu7kvp46fptp5fy (single raw block)
bafybeic3dn4xhqxyjdsxonxwfcgu4o2mrlqlg6dctimk5y52rn6bdbk6zq recursive
bafkreiej3hazewwnjik55cps7ro5nc7c26vpnmlbbnjmu7kvp46fptp5fy recursive
GET http://127.0.0.1:18080/ipfs/bafybeic3dn4xhqxyjdsxonxwfcgu4o2mrlqlg6dctimk5y52rn6bdbk6zq -> 200 1908985 bytes, content-type text/html
  bytes identical to /Users/shikharsingh/Downloads/code/realfi/eth-mumbai/apps/web/dist/index.html (sha256 89d9c1925acd4a15de89f2fc5dd68be2d7aaf6b1610b52ca7d557f3c57cdfd2e)
GET http://127.0.0.1:18080/ipfs/bafkreiej3hazewwnjik55cps7ro5nc7c26vpnmlbbnjmu7kvp46fptp5fy -> 200 1908985 bytes, content-type text/html
  bytes identical to /Users/shikharsingh/Downloads/code/realfi/eth-mumbai/apps/web/dist/index.html (sha256 89d9c1925acd4a15de89f2fc5dd68be2d7aaf6b1610b52ca7d557f3c57cdfd2e)
OK: pinned into /ip4/127.0.0.1/tcp/15001 (offline) and read back byte-for-byte from http://127.0.0.1:18080
```

## What it shows

- **Single file.** `dist/` holds only `index.html`; no `<script src>`, `<link href>`, `<img src>` or other loading element points at a file or URL; the CSS has no `url()` or `@import` to anything but data URIs. The http(s) strings in the inlined JavaScript are constants (library links, default URLs), not loads; the CSP governs requests (`default-src 'none'`, `connect-src` is `'self'`, `data:`, `blob:` and loopback only). This is a static text check, `scripts/check-single-file.ts`.
- **Reproducibility (F17).** Two builds, each from a deleted `dist/`, gave the same sha256. Scope: same machine, same checkout path, same Node 24.10.0 and pnpm 10.0.0, sources unchanged between the builds (the script compares a source fingerprint). Different machine, path, OS or a fresh `pnpm install` were not tested. No absolute path of this machine is in the bundle (`grep` for `/Users/` found 0 matches in the first build). There was nothing non-deterministic to fix in build config.
- **Our CID versus Kubo's.** `cidFor` (CIDv1, raw codec, sha2-256, whole file as one block) equals what Kubo prints for `ipfs add --cid-version=1 --raw-leaves --chunker=size-2096896`. This kubo accepts a chunk size up to 2,096,896 bytes (it rejects larger: "chunker parameters may not exceed the maximum chunk size of 2096896"), so a file up to that size is a single block. With `--chunker=size-1048576`, or by default, a file over 1 MiB becomes a UnixFS DAG with a different CID (`bafybei...`), which is the portable CID that public gateways and bitswap handle. Public gateways commonly refuse blocks over 1 MiB, so do not count on the single-block CID being fetchable from third-party infrastructure; this was not tested. If the file ever exceeds 2,096,896 bytes no Kubo CID can equal `cidFor`. The file is 1.9 MB now, close to that limit.
- **Pin and read back.** Both CIDs were pinned (`ipfs pin ls` lists both as recursive) and fetched through the local gateway; the bytes are identical to `dist/index.html` (cmp and sha256). The gateway serves it as `text/html`. This was a `curl`, not a browser load from the gateway.

## `file://` load

`scripts/check-file-url.ts` copies the file alone into a fresh temporary directory and opens it from `file://` in headless Chrome (Google Chrome on this Mac, `--headless=new`, 15 s of virtual time), then reads the DOM and Chrome's console log:

```
chrome          /Applications/Google Chrome.app/Contents/MacOS/Google Chrome
root rendered   true
page text       ZeroDrop / disclosures Post Read Groups Settings About Mock proof (not a membership proof) Direct transaction: poster address visible Not routed (direct) Chain ...
console lines   0
CSP violations  0
errors          0
```

Method check: the same console capture reported a CSP-blocked fetch and a `console.log` from a small test page, so zero lines means zero messages, not a broken capture.

Not done: the Browser pane tools refused every `file://` URL in this session ("the file may be missing, unreadable, or the user declined access"), so the load was not seen in that pane. Not tested: Firefox or Safari (the build notes say Firefox needs a CSP relaxation for the Anon-RPC worker), a load over `http://127.0.0.1:18080/ipfs/<cid>` in a browser, navigating the routes after load, any posting flow, and the walk-away rehearsal (taking the hosted site offline and posting through our own sidecar).
