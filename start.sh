#!/bin/bash
# start.sh — Start Forge locally (kill old processes, build, start)
#
# Usage:
#   ./start.sh          # production mode
#   ./start.sh dev      # dev mode (hot-reload)

# Kill all old forge processes
pkill -f 'telegram-standalone' 2>/dev/null
pkill -f 'terminal-standalone' 2>/dev/null
pkill -f 'cloudflared tunnel' 2>/dev/null
pkill -f 'next-server' 2>/dev/null
pkill -f 'next start' 2>/dev/null
pkill -f 'next dev' 2>/dev/null
sleep 1

if [ "$1" = "dev" ]; then
  pnpm dev
else
  pnpm build && pnpm start
fi
