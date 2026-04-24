#!/bin/bash
# start.sh — Start Forge locally (kill old processes, build, start)
#
# Usage:
#   ./start.sh          # production mode
#   ./start.sh dev      # dev mode (hot-reload)

# Kill all old forge processes
pkill -f 'telegram-standalone' 2>/dev/null
pkill -f 'terminal-standalone' 2>/dev/null
pkill -f 'workspace-standalone' 2>/dev/null
pkill -f 'cloudflared tunnel' 2>/dev/null
# Wait for workspace daemon port to be released
for i in 1 2 3; do
  lsof -ti:${WORKSPACE_PORT:-8405} >/dev/null 2>&1 || break
  sleep 1
done
pkill -f 'next-server' 2>/dev/null
pkill -f 'next start' 2>/dev/null
pkill -f 'next dev' 2>/dev/null
sleep 1

export PORT=${PORT:-8403}
export TERMINAL_PORT=${TERMINAL_PORT:-8404}
export WORKSPACE_PORT=${WORKSPACE_PORT:-8405}

# pnpm is the pinned package manager (see package.json#packageManager).
# Try corepack first (ships with Node 16.9+), then fall back to a prompt.
if ! command -v pnpm >/dev/null 2>&1; then
  if command -v corepack >/dev/null 2>&1; then
    echo "[forge] pnpm not found — enabling via corepack..."
    corepack enable 2>/dev/null || true
    corepack prepare pnpm@latest --activate 2>/dev/null || true
  fi
fi
if ! command -v pnpm >/dev/null 2>&1; then
  echo "[forge] pnpm is required but was not found on PATH."
  echo "[forge] Install it with:"
  echo "    npm install -g pnpm"
  echo "[forge] Then re-run: ./start.sh ${1:-}"
  exit 1
fi

# Install dependencies if node_modules is missing or the next binary isn't built
if [ ! -x node_modules/.bin/next ]; then
  echo "[forge] node_modules missing — running pnpm install..."
  pnpm install || exit 1
fi

if [ "$1" = "dev" ]; then
  export FORGE_DEV=1
  pnpm dev
else
  pnpm build && pnpm start
fi
