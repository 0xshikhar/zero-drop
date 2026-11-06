#!/usr/bin/env bash
# ZeroDrop: Universal One-Command Backend Runner
#
# Usage:
#   ./scripts/backend.sh [up|down|status|test]
#
# Supports both:
# 1. Docker Compose (Zero-install plug-and-play)
# 2. Native pnpm/tsx stack fallback (scripts/stack.ts)
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

ACTION="${1:-up}"

check_port() {
  local port="$1"
  nc -z 127.0.0.1 "$port" 2>/dev/null || return 1
}

has_docker() {
  command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1
}

case "$ACTION" in
  up)
    echo "======================================================="
    echo "  Starting ZeroDrop Plug-and-Play Backend Services     "
    echo "======================================================="
    if has_docker; then
      echo "✓ Docker detected. Starting containers via Docker Compose..."
      docker compose up -d
      echo ""
      echo "Backend Services Online:"
      echo "  - Pinner Node:      http://127.0.0.1:3001"
      echo "  - Tor SOCKS5 Proxy: socks5h://127.0.0.1:9050"
      echo "  - Anvil RPC Node:   http://127.0.0.1:8545"
    else
      echo "ℹ Docker not active. Using native zero-dependency stack runner..."
      pnpm stack:up
    fi
    echo ""
    echo "Run './scripts/backend.sh status' to verify health."
    ;;

  down)
    echo "Stopping ZeroDrop backend services..."
    if has_docker; then
      docker compose down 2>/dev/null || true
    fi
    pnpm stack:down 2>/dev/null || true
    echo "✓ All backend services stopped."
    ;;

  status)
    echo "======================================================="
    echo "  ZeroDrop Backend Health & Status                     "
    echo "======================================================="
    
    # 1. Pinner
    PINNER_OK=false
    for p in 3001 8787 8788; do
      if curl -s -f "http://127.0.0.1:$p/health" >/dev/null 2>&1; then
        echo "  [✓] Pinner Service:   ONLINE on port $p"
        curl -s "http://127.0.0.1:$p/health"
        echo ""
        PINNER_OK=true
        break
      fi
    done
    if [ "$PINNER_OK" = false ]; then
      echo "  [-] Pinner Service:   OFFLINE (Start with ./scripts/backend.sh up)"
    fi

    # 2. Tor
    if check_port 9050; then
      echo "  [✓] Tor SOCKS5 Proxy: ONLINE on port 9050"
    else
      echo "  [-] Tor SOCKS5 Proxy: OFFLINE (Port 9050 not listening)"
    fi

    # 3. Anvil / EVM RPC
    if check_port 8545; then
      CHAIN_ID=$(curl -s -X POST -H "Content-Type: application/json" --data '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}' http://127.0.0.1:8545 | grep -o '"result":"[^"]*"' || echo "unknown")
      echo "  [✓] EVM RPC Node:     ONLINE on port 8545 ($CHAIN_ID)"
    else
      echo "  [-] EVM RPC Node:     OFFLINE on port 8545"
    fi
    echo "======================================================="
    ;;

  test)
    echo "Testing Pinner health..."
    for p in 3001 8787 8788; do
      if curl -s -f "http://127.0.0.1:$p/health" 2>/dev/null; then
        echo " -> Port $p responded successfully!"
        break
      fi
    done
    ;;

  *)
    echo "Usage: $0 [up|down|status|test]"
    exit 1
    ;;
esac

