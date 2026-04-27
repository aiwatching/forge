# Forge Overview

Forge is a self-hosted Vibe Coding platform for Claude Code. It provides a browser-based terminal, multi-agent workspace orchestration, AI task management, remote access, and mobile control via Telegram.

## Main Features

| Feature | Description |
|---|---|
| **Browser Terminal** | xterm.js + tmux persistence, split panes, mouse on/off toggle, auto-reconnect on disconnect |
| **Projects** | File tree, Git operations, code search, per-project tabs, favorites |
| **Workspace (Smiths)** | Multi-agent orchestration with DAG dependencies, message bus, request documents |
| **Tasks** | Background AI task queue with hook-based completion notifications |
| **Pipelines** | YAML-driven DAG workflows with scheduling and routing |
| **Skills Marketplace** | Install/update Claude Code skills and slash commands per project |
| **Usage Analytics** | Token/cost tracking by project, model, source with charts and heatmaps |
| **Telegram Bot** | Mobile control — submit tasks, receive notifications |
| **Remote Access** | One-click Cloudflare tunnel for remote browsing |
| **GitHub Issue Auto-fix** | Scan issues, auto-fix, create PRs |
| **Memory (optional)** | Code graph + knowledge via `@aion0/temper` MCP server |
| **IDE Plugins** | First-party VSCode extension and IntelliJ plugin — drive workspaces, agents, terminals, pipelines and docs from inside the editor (see `13-ide-plugins.md`) |

## Quick Start

```bash
npm install -g @aion0/forge
forge server start
```

Open `http://localhost:8403`. First launch prompts you to set an admin password.

## Requirements
- Node.js >= 20
- tmux (`brew install tmux` on macOS)
- Claude Code CLI (`npm install -g @anthropic-ai/claude-code`)

## Data Location
- Config: `~/.forge/` (binaries)
- Data: `~/.forge/data/` (settings, database, state)
- Workspaces: `~/.forge/workspaces/<id>/` (workspace state files)
- Claude: `~/.claude/` (skills, commands, sessions)

## Architecture
- `forge-server.mjs` starts: Next.js (port 8403) + Terminal server + Telegram bot + Workspace daemon (port 8405)
- `pnpm dev` / `start.sh dev`: Next.js dev mode (init.ts spawns terminal + telegram + workspace)
- `FORGE_EXTERNAL_SERVICES=1`: Next.js skips spawning (forge-server manages external services)

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
