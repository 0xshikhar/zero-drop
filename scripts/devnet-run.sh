#!/usr/bin/env bash
# Gated devnet run for the P0 items: (1) devnet reachable, (2) deploy ZeroDrop with staking and float,
# (3) live gas spike: admit a >100k VERIFY frame transaction through the alt mempool, (4) send the same
# raw bytes to the devnet's canonical node and keep its response. Writes a dated log under evidence/.
#
# Requires DEPLOYER_PRIVATE_KEY in the environment (a funded devnet key). It is never written to disk.
# Refuses to run unless scripts/check-devnet.ts exits 0. Never disables TLS verification.
set -euo pipefail
cd "$(dirname "$0")/.."

: "${DEPLOYER_PRIVATE_KEY:?set DEPLOYER_PRIVATE_KEY to a funded devnet key (never stored)}"
DEVNET_RPC="${DEVNET_RPC:-https://altmempool.forshtat.com}"
DEVNET_MEMPOOL="${DEVNET_MEMPOOL:-https://altmempool.forshtat.com/rpc}"
REGISTRY="${REGISTRY:-0xd51c04d7a0b01124e84de152f4e56d9eecb22d2f}"
STAKE="${STAKE:-0.012}"
FUND="${FUND:-0.1}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
LOG="evidence/devnet-run-${STAMP}.log"
mkdir -p evidence

echo "== 1. devnet reachability (TLS verified)" | tee -a "$LOG"
if ! pnpm tsx scripts/check-devnet.ts | tee -a "$LOG"; then
  echo "devnet not reachable: stopping (no request was sent with TLS disabled)" | tee -a "$LOG"
  exit 1
fi

echo "== 2+3. deploy ZeroDrop (mock verifier, direct path off, stake and float) and run the gas spike" | tee -a "$LOG"
RPC_URL="$DEVNET_RPC" MEMPOOL_URLS="$DEVNET_MEMPOOL" DEPLOYER_PRIVATE_KEY="$DEPLOYER_PRIVATE_KEY" \
  pnpm tsx scripts/gas-spike.ts --gas-to-burn 300000 --registry "$REGISTRY" --fund "$FUND" --stake "$STAKE" \
  2>&1 | tee -a "$LOG"

RAW="$(grep -o '0x06[0-9a-fA-F]*' "$LOG" | tail -1 || true)"
if [ -z "$RAW" ]; then
  echo "no raw transaction found in the log; skipping the canonical step" | tee -a "$LOG"
  exit 2
fi

echo "== 4. same raw bytes to the devnet canonical node (eth_sendRawTransaction)" | tee -a "$LOG"
curl -sS --max-time 60 -X POST -H 'content-type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_sendRawTransaction\",\"params\":[\"${RAW}\"]}" \
  "$DEVNET_RPC" | tee -a "$LOG"
echo | tee -a "$LOG"
echo "log: $LOG"
