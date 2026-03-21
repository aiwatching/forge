# Forge Overview

Forge is a self-hosted Vibe Coding platform for Claude Code. It provides a browser-based terminal, AI task orchestration, remote access, and mobile control via Telegram.

## Quick Start

```bash
npm install -g @aion0/forge
forge server start
```

Open `http://localhost:3000`. First launch prompts you to set an admin password.

## Requirements
- Node.js >= 20
- tmux (`brew install tmux` on macOS)
- Claude Code CLI (`npm install -g @anthropic-ai/claude-code`)

## Data Location
- Config: `~/.forge/` (binaries)
- Data: `~/.forge/data/` (settings, database, state)
- Claude: `~/.claude/` (skills, commands, sessions)

## Server Commands
```bash
forge server start              # background (default)
forge server start --foreground # foreground
forge server start --dev        # dev mode with hot-reload
forge server stop               # stop
forge server restart            # restart
forge server start --port 4000  # custom port
forge server start --dir ~/.forge-test  # custom data dir
forge --reset-password          # reset admin password
```
