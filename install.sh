#!/bin/bash
# install.sh — Install Forge globally, ready to run
#
# Usage:
#   ./install.sh          # from npm
#   ./install.sh local    # from local source

set -e

if [ "$1" = "local" ] || [ "$1" = "--local" ]; then
  echo "[forge] Installing from local source..."
  npm uninstall -g @aion0/forge 2>/dev/null || true
  npm link
  echo "[forge] Building..."
  pnpm build
else
  echo "[forge] Installing from npm..."
  rm -rf "$(npm root -g)/@aion0/forge" 2>/dev/null || true
  npm cache clean --force 2>/dev/null || true
  # Install from /tmp to avoid pnpm node_modules conflict
  (cd /tmp && npm install -g @aion0/forge)
  echo "[forge] Building..."
  cd "$(npm root -g)/@aion0/forge" && npx next build && cd -
fi

echo ""
echo "[forge] Done."
forge-server --version
echo "Run: forge-server"
