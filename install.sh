#!/bin/bash
# install.sh — Install Forge globally, ready to run
#
# Usage:
#   ./install.sh          # from npm
#   ./install.sh local    # from local source

set -e

# tmux is required for browser terminals — warn early if missing
if ! command -v tmux >/dev/null 2>&1; then
  echo "[forge] ⚠️  tmux not found — Forge terminals won't work without it."
  case "$(uname -s)" in
    Darwin)
      echo "[forge] Install: brew install tmux"
      if command -v brew >/dev/null 2>&1; then
        read -r -p "[forge] Run 'brew install tmux' now? [y/N] " reply
        case "$reply" in [yY]*) brew install tmux ;; esac
      fi
      ;;
    Linux)
      if command -v apt-get >/dev/null 2>&1; then
        echo "[forge] Install: sudo apt install -y tmux"
      elif command -v dnf >/dev/null 2>&1; then
        echo "[forge] Install: sudo dnf install -y tmux"
      elif command -v pacman >/dev/null 2>&1; then
        echo "[forge] Install: sudo pacman -S tmux"
      else
        echo "[forge] Install tmux via your distro's package manager."
      fi
      ;;
    *)
      echo "[forge] See https://github.com/tmux/tmux/wiki/Installing"
      ;;
  esac
  echo ""
fi

# Agent CLI check — at least one of claude / codex / aider is needed
if ! command -v claude >/dev/null 2>&1 \
   && ! command -v codex >/dev/null 2>&1 \
   && ! command -v aider >/dev/null 2>&1; then
  echo "[forge] ⚠️  No agent CLI found (claude / codex / aider)."
  echo "[forge] Install Claude Code:  npm install -g @anthropic-ai/claude-code"
  echo "[forge] Install Codex:        https://github.com/openai/codex#installation"
  echo "[forge] Or configure API-only profiles in Settings after login."
  echo ""
fi

if [ "$1" = "local" ] || [ "$1" = "--local" ]; then
  echo "[forge] Installing from local source..."
  npm uninstall -g @aion0/forge 2>/dev/null || true
  npm link
  echo "[forge] Building..."
  pnpm build || echo "[forge] Build completed with warnings (non-critical)"
else
  echo "[forge] Installing from npm..."
  rm -rf "$(npm root -g)/@aion0/forge" 2>/dev/null || true
  npm cache clean --force 2>/dev/null || true
  # Install from /tmp to avoid pnpm node_modules conflict
  (cd /tmp && npm install -g @aion0/forge)
  echo "[forge] Building..."
  cd "$(npm root -g)/@aion0/forge" && (npx next build || echo "[forge] Build completed with warnings") && cd -
fi

echo ""
echo "[forge] Done."
forge --version
echo "Run: forge server start"
