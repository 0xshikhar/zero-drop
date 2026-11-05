#!/usr/bin/env bash
# Run your own alt-mempool sidecar for the EIP-8141 devnet.
#
#   sidecar/run.sh --check     list prerequisites, exit 1 if any is missing. Runs nothing else.
#   sidecar/run.sh             (same as --print) show the upstream commands for your setup. Executes nothing.
#   sidecar/run.sh --run       check the prerequisites, then execute the documented command.
#
# Options (combine with the actions above)
#   --docker | --bun           which documented runner to use. Default: docker if its daemon answers, else bun.
#   --node                     `node` mode (adds libp2p gossip, boot ENR of the public devnet). Default: `standalone`.
#
# Environment
#   ETHREX_RPC_URL        required. JSON-RPC URL of an EIP-8141-aware execution client (ethrex `eip8141-tracer`) for
#                         chain 1337. The public devnet's is https://altmempool.forshtat.com .
#   SIDECAR_REPO          required. Path to YOUR checkout of https://github.com/forshtat/mempool-workshop-sidecar.
#                         This script never clones or builds the upstream repo for you.
#   SKANDHA_RELAYERS      required for --run. The key(s) that submit transactions on chain (a throwaway devnet key).
#                         Read from the environment only; it is never written to a file and never printed.
#   STAKING_REGISTRY      optional. Default 0xd51c04d7a0b01124e84de152f4e56d9eecb22d2f (devnet NaiveStakingRegistry).
#   SIDECAR_PORT          optional. Default 14337.
#
# What this does NOT give you: the BUDGET-010 per-entity gas budgets or a BN254 precompile allowlist. See sidecar/README.md.
# Sources of every command below: docs.altmempool.wtf (guides/run-the-sidecar, reference/cli, reference/configuration,
# guides/devnet) and the README and deploy/devnet/devnet-readme.md of forshtat/mempool-workshop-sidecar (branch master),
# read 2026-11-06. Nothing here has been executed against a real sidecar.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="$HERE/.work"
CONFIG="$WORK/config.json"
ACTION=print RUNNER="" MODE=standalone
for arg in "$@"; do
  case "$arg" in
    --check) ACTION=check ;;
    --print) ACTION=print ;;
    --run) ACTION=run ;;
    --docker) RUNNER=docker ;;
    --bun) RUNNER=bun ;;
    --node) MODE=node ;;
    -h|--help) sed -n '2,26p' "$0"; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

REGISTRY="${STAKING_REGISTRY:-0xd51c04d7a0b01124e84de152f4e56d9eecb22d2f}"
PORT="${SIDECAR_PORT:-14337}"
# Boot ENR of the public devnet's sidecar, copied from deploy/devnet/devnet-readme.md section 7. It can go stale.
BOOT_ENR="enr:-J24QE4VOKvF8WltEOqNU4sqKlHVzEz7WV7BO-ORS94DfkePcMPk8ls3wUhxwO3BETKdlwtYS98Jd3DRAOEQwN1pzCUBiGNoYWluX2lkiDkFAAAAAAAAgmlkgnY0gmlwhCJDKZeJc2VjcDI1NmsxoQMQmr1qrPNfG8RDuHZ7COiKQhwOr03WtSxnHm9Xbwxu7IN0Y3CCEPGDdWRwghDx"

missing=0
ok()   { printf '  [ok]       %s\n' "$1"; }
bad()  { printf '  [MISSING]  %s\n' "$1"; missing=$((missing + 1)); }
note() { printf '  [info]     %s\n' "$1"; }

have_docker_cli=0 docker_daemon=0 have_bun=0
command -v docker >/dev/null 2>&1 && have_docker_cli=1
if [ "$have_docker_cli" = 1 ] && docker info >/dev/null 2>&1; then docker_daemon=1; fi
command -v bun >/dev/null 2>&1 && have_bun=1

if [ -z "$RUNNER" ]; then
  if [ "$docker_daemon" = 1 ]; then RUNNER=docker; elif [ "$have_bun" = 1 ]; then RUNNER=bun; else RUNNER=docker; fi
fi

echo "Prerequisites (runner: $RUNNER, mode: $MODE)"
if [ "$RUNNER" = docker ]; then
  if [ "$have_docker_cli" = 0 ]; then bad "docker CLI not installed"
  elif [ "$docker_daemon" = 0 ]; then bad "docker CLI found but the daemon does not answer (start Docker Desktop / dockerd)"
  else ok "docker daemon answers"; fi
else
  if [ "$have_bun" = 1 ]; then ok "bun $(bun --version)"; else bad "bun not installed (the sidecar builds with bun)"; fi
fi
if command -v cargo >/dev/null 2>&1; then
  note "cargo $(cargo --version | awk '{print $2}') found. Only needed to build ethrex from source; the docs read for this script give no cargo command, so none is printed."
else
  note "cargo not found. Only needed to build ethrex from source; not needed for the sidecar."
fi
if [ -n "${ETHREX_RPC_URL:-}" ]; then ok "ETHREX_RPC_URL=$ETHREX_RPC_URL"; else bad "ETHREX_RPC_URL is not set (execution client for chain 1337)"; fi
if [ -n "${SIDECAR_REPO:-}" ] && [ -f "${SIDECAR_REPO}/config.json.default" ]; then
  ok "SIDECAR_REPO=$SIDECAR_REPO (config.json.default found)"
elif [ -n "${SIDECAR_REPO:-}" ]; then
  bad "SIDECAR_REPO=$SIDECAR_REPO has no config.json.default (not a checkout of mempool-workshop-sidecar?)"
else
  bad "SIDECAR_REPO is not set (path to your checkout of github.com/forshtat/mempool-workshop-sidecar; this script does not clone it)"
fi
if [ -n "${SKANDHA_RELAYERS:-}" ]; then ok "SKANDHA_RELAYERS is set (value not shown)"; else bad "SKANDHA_RELAYERS is not set (needed for --run; the relayer key must be a throwaway devnet key)"; fi
if [ "${ETHREX_RPC_URL:-}" != "" ]; then
  case "$ETHREX_RPC_URL" in
    http://127.0.0.1*|http://localhost*|https://*) ;;
    *) note "ETHREX_RPC_URL is plain http to a non-local host; the sidecar's relay call is unauthenticated, so use only a node you trust" ;;
  esac
fi

if [ "$ACTION" = check ]; then
  echo
  if [ "$missing" -gt 0 ]; then echo "$missing prerequisite(s) missing."; exit 1; fi
  echo "All prerequisites present."; exit 0
fi

# ---------------------------------------------------------------------------------------------------------------
# The documented config (docs.altmempool.wtf reference/configuration): only fields shown in the docs.
# The relayer key is NOT written here; it travels through SKANDHA_RELAYERS.
# ---------------------------------------------------------------------------------------------------------------
config_json() {
  cat <<EOF
{
  "entryPoints": ["0x00000000000000000000000000000000000000aa"],
  "canonicalEntryPoint": "0x00000000000000000000000000000000000000aa",
  "standardMempoolId": "QmcFZKUX9qoo3StwVycJTAhwdiqbEjcwNvQVK246p3z1rk",
  "supportedMempools": [
    {
      "mempoolId": "QmcFZKUX9qoo3StwVycJTAhwdiqbEjcwNvQVK246p3z1rk",
      "entryPoint": "0x00000000000000000000000000000000000000aa"
    }
  ],
  "rpcEndpoint": "${ETHREX_RPC_URL:-http://localhost:8545}",
  "rpcEndpointSubmit": "${ETHREX_RPC_URL:-http://localhost:8545}",
  "stakingRegistryAddress": "$REGISTRY"
}
EOF
}

NODE_FLAGS=""
if [ "$MODE" = node ]; then NODE_FLAGS=" --p2p.bootEnrs \"$BOOT_ENR\""; fi

show_commands() {
  echo
  echo "Config (written to $CONFIG by --run; contains no key):"
  config_json | sed 's/^/    /'
  echo
  echo "Upstream commands (docs.altmempool.wtf/guides/run-the-sidecar and the sidecar README), run inside your checkout:"
  if [ "$RUNNER" = docker ]; then
    cat <<EOF
    cd "\$SIDECAR_REPO"
    docker build -t skandha .
    docker run \\
      --mount type=bind,source="$CONFIG",target=/usr/app/config.json,readonly \\
      -dp $PORT:14337 \\
      skandha $MODE$NODE_FLAGS
EOF
    echo
    echo "As executed by --run, two deliberate differences from the documented command:"
    echo "  - the port is bound to loopback (-p 127.0.0.1:$PORT:14337): the sidecar exposes admin methods (debug_bundler_*) and holds a relayer key;"
    echo "  - the relayer key is passed with -e SKANDHA_RELAYERS (env var named in the docs) instead of being written into config.json."
  else
    cat <<EOF
    cd "\$SIDECAR_REPO"
    bun install
    bun run build
    # config: $CONFIG  (the documented step is: cp config.json.default config.json, then edit)
    ./skandha $MODE --configFile "$CONFIG" --dataDir "$WORK/data" --api.port $PORT$NODE_FLAGS
EOF
    echo
    echo "As executed by --run, the relayer key is passed through the SKANDHA_RELAYERS environment variable (named in the docs)."
  fi
  echo
  echo "RPC will be at http://127.0.0.1:$PORT/rpc/  (docs: 'The RPC API is available at http://localhost:14337/rpc/')."
  echo "Point the app at it: add http://127.0.0.1:$PORT/rpc to Settings > sidecar URLs, or to sidecarUrls in config/devnet.json."
  if [ "$MODE" = node ]; then
    echo "Node mode also needs libp2p ports reachable by peers; see P2P.md in the upstream repo. The boot ENR above is from devnet-readme.md and may be stale."
  fi
  echo
  echo "Reminder: this sidecar relays with ethrex_submitPrivilegedFrameTransaction on ETHREX_RPC_URL. That method is unauthenticated on the public devnet."
  echo "Reminder: we have neither the BUDGET-010 branch nor a BN254 precompile allowlist, so do not expect >100k VERIFY admission from this build. See sidecar/README.md."
}

if [ "$ACTION" = print ]; then
  show_commands
  [ "$missing" -gt 0 ] && { echo; echo "(printed only; $missing prerequisite(s) missing, so --run would refuse)"; }
  exit 0
fi

# ACTION=run
if [ "$missing" -gt 0 ]; then
  echo
  echo "Refusing to run: $missing prerequisite(s) missing (see above)." >&2
  exit 1
fi
mkdir -p "$WORK/data"
config_json >"$CONFIG"
show_commands
echo
echo "Running ..."
EXTRA=()
if [ "$MODE" = node ]; then EXTRA=(--p2p.bootEnrs "$BOOT_ENR"); fi
cd "$SIDECAR_REPO"
if [ "$RUNNER" = docker ]; then
  docker build -t skandha .
  exec docker run \
    --mount type=bind,source="$CONFIG",target=/usr/app/config.json,readonly \
    -e SKANDHA_RELAYERS \
    -dp "127.0.0.1:$PORT:14337" \
    skandha "$MODE" ${EXTRA[@]+"${EXTRA[@]}"}
else
  bun install
  bun run build
  exec ./skandha "$MODE" --configFile "$CONFIG" --dataDir "$WORK/data" --api.port "$PORT" ${EXTRA[@]+"${EXTRA[@]}"}
fi
