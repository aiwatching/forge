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

if [ "$1" = "dev" ]; then
  export FORGE_DEV=1
  pnpm dev
else
  pnpm build && pnpm start
fi
