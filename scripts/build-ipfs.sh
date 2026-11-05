#!/usr/bin/env bash
# Build the single-file app, check it is one self-contained file, print its identity, and (optionally) pin it
# into a LOCAL, OFFLINE Kubo node and read it back through that node's gateway.
#
#   scripts/build-ipfs.sh                 build, check, print sha256 and CIDs (hash only, nothing is stored)
#   scripts/build-ipfs.sh --no-build      same, for the dist/index.html that is already there
#   scripts/build-ipfs.sh --repro         build twice from a clean dist and compare the bytes (F17)
#   scripts/build-ipfs.sh --pin           also `ipfs add --pin` into the local node and compare the gateway bytes
#
# Environment
#   IPFS_API      Kubo API multiaddr.  Default /ip4/127.0.0.1/tcp/15001  (the throwaway offline node of this repo's dev setup)
#   IPFS_GATEWAY  gateway base URL.    Default http://127.0.0.1:18080
#
# Safety. --pin refuses to run unless (a) the API is a loopback address and (b) the node is OFFLINE (`ipfs swarm
# peers` must answer "must be run in online mode"). An offline node never announces to the DHT. Nothing in this
# script publishes to the public network.
#
# About the two CIDs. `cidFor` (packages/core, the CID the app uses for documents) is CIDv1, raw codec, sha2-256 of
# the whole file as ONE block. Kubo's default chunker (256 KiB) and the commonly quoted maximum (1 MiB) split a
# 1.2 MB file into several blocks, so `ipfs add --cid-version=1` prints a different CID: a UnixFS DAG root
# (bafybei...). That DAG CID is the one that public gateways and bitswap handle. Kubo 0.43 accepts a chunk size up to
# 2096896 bytes, so with `--raw-leaves --chunker=size-2096896` it produces the SAME single-block CID as `cidFor`.
# A block above 1 MiB is not accepted by many public gateways, so do not rely on the raw-leaf CID being fetchable
# from third-party infrastructure. Both are computed and (with --pin) both are pinned locally.
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
DIST="$ROOT/apps/web/dist"
FILE="$DIST/index.html"
IPFS_API="${IPFS_API:-/ip4/127.0.0.1/tcp/15001}"
IPFS_GATEWAY="${IPFS_GATEWAY:-http://127.0.0.1:18080}"
MAX_RAW_CHUNK=2096896

DO_BUILD=1 DO_REPRO=0 DO_PIN=0
for arg in "$@"; do
  case "$arg" in
    --no-build) DO_BUILD=0 ;;
    --repro) DO_REPRO=1 ;;
    --pin) DO_PIN=1 ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

sha() { shasum -a 256 "$1" | cut -d' ' -f1; }

# Fingerprint of everything that feeds the build, to tell "not reproducible" from "the sources changed meanwhile".
source_fingerprint() {
  ( find apps/web/src apps/web/index.html apps/web/vite.config.ts apps/web/package.json packages/core/src packages/core/package.json pnpm-lock.yaml -type f 2>/dev/null \
      | LC_ALL=C sort | xargs shasum -a 256 | shasum -a 256 | cut -d' ' -f1 )
}

clean_build() {
  # The previous dist is kept aside and restored if every attempt fails, so a half-edited source tree
  # (someone else is working in apps/web or packages/core) does not leave the directory empty.
  local attempt backup=""
  if [ -d "$DIST" ]; then backup="$(mktemp -d)"; cp -R "$DIST/." "$backup/"; fi
  for attempt in 1 2 3; do
    rm -rf "$DIST"
    if pnpm build >/tmp/zerodrop-build.$$.log 2>&1; then
      rm -f /tmp/zerodrop-build.$$.log
      [ -n "$backup" ] && rm -rf "$backup"
      return 0
    fi
    echo "build attempt $attempt failed (the web app may be mid-change); error:" >&2
    grep -v '^ *at ' /tmp/zerodrop-build.$$.log | tail -n 6 >&2
    sleep 3
  done
  if [ -n "$backup" ]; then mkdir -p "$DIST"; cp -R "$backup/." "$DIST/"; rm -rf "$backup"; echo "restored the previous dist" >&2; fi
  echo "build failed three times" >&2
  return 1
}

echo "== environment"
echo "node $(node --version), pnpm $(pnpm --version), kubo $(ipfs --version 2>/dev/null | awk '{print $3}' || echo 'not installed')"

if [ "$DO_BUILD" = 1 ]; then
  echo "== build"
  FP1="$(source_fingerprint)"
  clean_build
  FP1B="$(source_fingerprint)"
  if [ "$FP1" != "$FP1B" ]; then echo "NOTE: sources changed during the build (someone is editing apps/web or packages/core); the output may mix versions."; fi
fi
[ -f "$FILE" ] || { echo "missing $FILE (run without --no-build)" >&2; exit 1; }
SHA1="$(sha "$FILE")"

if [ "$DO_REPRO" = 1 ]; then
  echo "== reproducibility: second clean build (F17)"
  FIRST_COPY="$(mktemp)"; cp "$FILE" "$FIRST_COPY"
  FP_BEFORE="$(source_fingerprint)"
  clean_build
  FP_AFTER="$(source_fingerprint)"
  SHA2="$(sha "$FILE")"
  echo "build 1 sha256 $SHA1"
  echo "build 2 sha256 $SHA2"
  if [ "$SHA1" = "$SHA2" ]; then
    echo "REPRODUCIBLE: byte-identical across two clean builds (same machine, same path, same node/pnpm)"
  else
    echo "NOT byte-identical."
    if [ "$FP_BEFORE" != "$FP_AFTER" ]; then echo "  The sources changed between the builds, so this is inconclusive."; fi
    OFFSET="$(cmp "$FIRST_COPY" "$FILE" 2>&1 | sed -E 's/.*byte ([0-9]+).*/\1/' | head -n1)"
    echo "  differing bytes: $(cmp -l "$FIRST_COPY" "$FILE" 2>/dev/null | wc -l | tr -d ' '); first at byte $OFFSET"
    START=$(( OFFSET > 60 ? OFFSET - 60 : 0 ))
    echo "  build 1 around it: $(tail -c +$((START + 1)) "$FIRST_COPY" | head -c 140)"
    echo "  build 2 around it: $(tail -c +$((START + 1)) "$FILE" | head -c 140)"
  fi
  rm -f "$FIRST_COPY"
  SHA1="$SHA2"
fi

echo "== single-file check"
pnpm tsx scripts/check-single-file.ts "$FILE"

echo "== identity (our own cidFor, packages/core)"
pnpm tsx scripts/build-cid.ts "$FILE"
SIZE="$(wc -c <"$FILE" | tr -d ' ')"

echo "== Kubo (hash only, nothing stored)"
if ! command -v ipfs >/dev/null 2>&1; then
  echo "ipfs not installed: skipping Kubo CIDs"
  exit 0
fi
IPFS=(ipfs --api "$IPFS_API")
if ! "${IPFS[@]}" version >/dev/null 2>&1; then
  # No node to talk to: --only-hash still needs a repo, so fall back to a throwaway one.
  TMP_REPO="$(mktemp -d)"; export IPFS_PATH="$TMP_REPO"
  ipfs init --profile=test >/dev/null 2>&1 || true
  IPFS=(ipfs)
  echo "(no Kubo API at $IPFS_API; hashed with a temporary repo)"
fi
DAG_CID="$("${IPFS[@]}" add --only-hash -Q --cid-version=1 "$FILE")"
echo "file size                      $SIZE bytes"
echo "ipfs add --cid-version=1       $DAG_CID    (default chunker; UnixFS DAG root: the portable CID)"
if [ "$SIZE" -le "$MAX_RAW_CHUNK" ]; then
  RAW_CID="$("${IPFS[@]}" add --only-hash -Q --cid-version=1 --raw-leaves --chunker=size-$MAX_RAW_CHUNK "$FILE")"
  OUR_CID="$(pnpm --silent tsx scripts/build-cid.ts --json "$FILE" | sed -E 's/.*"cidRawLeaf":"([^"]+)".*/\1/')"
  echo "ipfs add --raw-leaves --chunker=size-$MAX_RAW_CHUNK  $RAW_CID    (single raw block)"
  if [ "$RAW_CID" = "$OUR_CID" ]; then echo "MATCH: Kubo's single-block CID equals cidFor ($OUR_CID)"; else echo "MISMATCH: kubo $RAW_CID vs cidFor $OUR_CID"; exit 1; fi
else
  RAW_CID=""
  echo "file is larger than the Kubo single-chunk maximum ($MAX_RAW_CHUNK): no Kubo CID can equal cidFor; the DAG CID above is the IPFS identity"
fi

if [ "$DO_PIN" = 1 ]; then
  echo "== pin into the local offline node and read back through its gateway"
  case "$IPFS_API" in
    /ip4/127.0.0.1/*|/ip6/::1/*|/dns4/localhost/*|/dns/localhost/*) ;;
    *) echo "refusing to pin: IPFS_API=$IPFS_API is not a loopback address" >&2; exit 3 ;;
  esac
  case "$IPFS_GATEWAY" in
    http://127.0.0.1:*|http://localhost:*|http://\[::1\]:*) ;;
    *) echo "refusing to pin: IPFS_GATEWAY=$IPFS_GATEWAY is not a loopback URL" >&2; exit 3 ;;
  esac
  PEERS="$("${IPFS[@]}" swarm peers 2>&1 || true)"
  if ! printf '%s' "$PEERS" | grep -q "online mode"; then
    echo "refusing to pin: the node at $IPFS_API looks ONLINE (swarm peers answered: ${PEERS:0:120})." >&2
    echo "This script only pins into an offline node, so nothing is announced to the DHT." >&2
    exit 3
  fi
  echo "node is offline (swarm peers: \"must be run in online mode\")"
  PIN_DAG="$("${IPFS[@]}" add -Q --pin --cid-version=1 "$FILE")"
  echo "pinned  $PIN_DAG (DAG)"
  [ "$PIN_DAG" = "$DAG_CID" ] || { echo "pinned CID differs from the hash-only CID" >&2; exit 1; }
  CIDS=("$DAG_CID")
  if [ -n "$RAW_CID" ]; then
    PIN_RAW="$("${IPFS[@]}" add -Q --pin --cid-version=1 --raw-leaves --chunker=size-$MAX_RAW_CHUNK "$FILE")"
    echo "pinned  $PIN_RAW (single raw block)"
    CIDS+=("$PIN_RAW")
  fi
  "${IPFS[@]}" pin ls --type=recursive | grep -E "^($(IFS='|'; echo "${CIDS[*]}")) " || { echo "pin ls does not list the new pins" >&2; exit 1; }
  TMP_OUT="$(mktemp -d)"
  for cid in "${CIDS[@]}"; do
    URL="$IPFS_GATEWAY/ipfs/$cid"
    CODE="$(curl -sS -o "$TMP_OUT/$cid" -w '%{http_code} %{size_download} bytes, content-type %{content_type}' --max-time 30 "$URL" || true)"
    echo "GET $URL -> $CODE"
    if cmp -s "$FILE" "$TMP_OUT/$cid"; then echo "  bytes identical to $FILE (sha256 $(sha "$TMP_OUT/$cid"))"; else echo "  BYTES DIFFER or fetch failed for $cid" >&2; exit 1; fi
  done
  rm -rf "$TMP_OUT"
  echo "OK: pinned into $IPFS_API (offline) and read back byte-for-byte from $IPFS_GATEWAY"
fi
