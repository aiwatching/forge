#!/bin/bash
# check-forge-status.sh — Show Forge process status

echo "══════════════════════════════════"
echo "  Forge Process Status"
echo "══════════════════════════════════"

# Next.js
count=$(ps aux | grep 'next-server' | grep -v grep | wc -l | tr -d ' ')
pid=$(ps aux | grep 'next-server' | grep -v grep | awk '{print $2}' | head -1)
if [ "$count" -gt 0 ]; then
  echo "  ● Next.js        running (pid: $pid)"
else
  echo "  ○ Next.js        stopped"
fi

# Terminal
count=$(ps aux | grep 'terminal-standalone' | grep -v grep | grep -v 'npm exec' | grep -v 'cli.mjs' | wc -l | tr -d ' ')
pid=$(ps aux | grep 'terminal-standalone' | grep -v grep | grep -v 'npm exec' | grep -v 'cli.mjs' | awk '{print $2}' | head -1)
if [ "$count" -gt 0 ]; then
  echo "  ● Terminal        running (pid: $pid)"
else
  echo "  ○ Terminal        stopped"
fi

# Telegram
count=$(ps aux | grep 'telegram-standalone' | grep -v grep | grep -v 'npm exec' | grep -v 'cli.mjs' | wc -l | tr -d ' ')
pid=$(ps aux | grep 'telegram-standalone' | grep -v grep | grep -v 'npm exec' | grep -v 'cli.mjs' | awk '{print $2}' | head -1)
if [ "$count" -gt 0 ]; then
  echo "  ● Telegram        running (pid: $pid)"
else
  echo "  ○ Telegram        stopped"
fi

# Workspace Daemon
count=$(ps aux | grep 'workspace-standalone' | grep -v grep | grep -v 'npm exec' | grep -v 'cli.mjs' | wc -l | tr -d ' ')
pid=$(ps aux | grep 'workspace-standalone' | grep -v grep | grep -v 'npm exec' | grep -v 'cli.mjs' | awk '{print $2}' | head -1)
if [ "$count" -gt 0 ]; then
  echo "  ● Workspace       running (pid: $pid)"
else
  echo "  ○ Workspace       stopped"
fi

# MCP Server (runs inside workspace-standalone)
mcp_status=$(curl -s http://localhost:8406/health 2>/dev/null)
if echo "$mcp_status" | grep -q '"ok":true'; then
  sessions=$(echo "$mcp_status" | python3 -c "import sys,json; print(json.load(sys.stdin).get('sessions',0))" 2>/dev/null)
  echo "  ● MCP Server      running (port: 8406, sessions: $sessions)"
else
  echo "  ○ MCP Server      stopped"
fi

# Cloudflare Tunnel
count=$(ps aux | grep 'cloudflared tunnel' | grep -v grep | wc -l | tr -d ' ')
pid=$(ps aux | grep 'cloudflared tunnel' | grep -v grep | awk '{print $2}' | head -1)
url=$(cat ~/.forge/tunnel-state.json 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('url',''))" 2>/dev/null)
if [ "$count" -gt 0 ]; then
  echo "  ● Tunnel          running (pid: $pid) ${url}"
else
  echo "  ○ Tunnel          stopped"
fi

# tmux sessions
tmux_count=$(tmux list-sessions 2>/dev/null | grep '^mw-' | wc -l | tr -d ' ')
echo ""
echo "  Terminal sessions: $tmux_count"
tmux list-sessions 2>/dev/null | grep '^mw-' | while read line; do
  echo "    $line"
done

echo "══════════════════════════════════"
