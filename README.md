# Forge

> Self-hosted AI workflow platform — web terminal, task orchestration, remote access.

Forge is a self-hosted web platform built around [Claude Code](https://docs.anthropic.com/en/docs/claude-code). It provides a browser-based terminal backed by tmux, a task queue for running Claude Code in the background, and one-click remote access via Cloudflare Tunnel — all behind a simple daily-rotating password.

No API keys required. Forge runs on your existing Claude Code subscription.

## Features

- **Web Terminal** — Full tmux-backed terminal in the browser. Multiple tabs, persistent sessions that survive page refresh, browser close, and server restart
- **Task Orchestration** — Submit tasks to Claude Code, queue them by project, track progress with live streaming output
- **Remote Access** — One-click Cloudflare Tunnel for a secure public URL (zero config, no account needed)
- **Session Continuity** — Tasks for the same project automatically continue the previous conversation context
- **YAML Workflows** — Define multi-step flows that chain tasks together
- **Bot Integration** — Telegram bot for mobile task management and tunnel control (extensible to other platforms)
- **Session Watcher** — Monitor Claude Code sessions for changes, idle state, keywords, or errors
- **CLI** — Full-featured command-line interface for task management
- **Auth** — Auto-generated daily rotating password + optional Google OAuth

## Prerequisites

- **Node.js** >= 20
- **pnpm** (recommended) or npm
- **tmux** — for web terminal sessions
- **Claude Code CLI** — `npm install -g @anthropic-ai/claude-code`

## Installation

### From npm

```bash
npm install -g @aion0/forge

# Start the server
forge-server

# Or in development mode
forge-server --dev
```

### From source

```bash
git clone https://github.com/aiwatching/forge.git
cd forge
pnpm install
pnpm dev
```

## Quick Start

### 1. Log in

Open `http://localhost:3000`. A login password is auto-generated and printed in the console:

```
[init] Login password: a7x9k2 (valid today)
```

The password rotates daily. Forgot it? Run:

```bash
forge password
```

### 4. Configure projects

Open **Settings** (gear icon) and add your project root directories (e.g. `~/Projects`). Forge will scan for git repositories automatically.

## Web Terminal

The core feature. A browser-based terminal powered by tmux:

- **Persistent** — Sessions survive page refresh, browser close, and server restart
- **Multi-tab** — Create, rename, and manage multiple terminal tabs
- **Remote-ready** — Access your terminal from anywhere via Cloudflare Tunnel
- **Large scrollback** — 50,000 lines with mouse support

The terminal server runs on `localhost:3001` and is auto-proxied through the main app for remote access.

## Remote Access (Cloudflare Tunnel)

Access Forge from anywhere without port forwarding or DNS config:

1. Click the **tunnel icon** in the header bar, or go to **Settings > Remote Access**
2. Click **Start** — Forge auto-downloads `cloudflared` and creates a temporary public URL
3. The URL is protected by the daily login password

Enable **Auto-start** in Settings to start the tunnel on every server boot.

> The tunnel URL changes each time. Use the Telegram bot `/tunnel_password` command to get the current URL and password on your phone.

## Task Orchestration

Submit AI coding tasks that run in the background:

```bash
# Submit a task
forge task my-app "Fix the login bug in auth.ts"

# Force a fresh session (ignore previous context)
forge task my-app "Refactor the API layer" --new

# List tasks
forge tasks              # all
forge tasks running      # filter by status

# Watch task output live
forge watch <task-id>

# Task details (result, git diff, cost)
forge status <task-id>

# Cancel / retry
forge cancel <task-id>
forge retry <task-id>
```

**All CLI shortcuts:** `t`=task, `r`=run, `ls`=tasks, `w`=watch, `l`=log, `s`=status, `f`=flows, `p`=projects, `pw`=password

## YAML Workflows

Define multi-step flows in `~/.forge/flows/`:

```yaml
# ~/.forge/flows/daily-review.yaml
name: daily-review
steps:
  - project: my-app
    prompt: "Review open TODOs and suggest fixes"
  - project: my-api
    prompt: "Check for any failing tests and fix them"
```

Run with `forge run daily-review`.

## Bot Integration

Forge ships with a Telegram bot for mobile-friendly control. The bot system is designed to be extensible to other platforms in the future.

### Telegram Setup

1. Create a bot via [@BotFather](https://t.me/botfather)
2. In **Settings**, add your **Bot Token** and **Chat ID**
3. Optionally set a **Tunnel Password** for remote access control

### Commands

| Command | Description |
|---------|-------------|
| `/tasks` | List tasks with quick-action numbers |
| `/tasks running` | Filter by status |
| `/sessions` | Browse Claude Code sessions |
| `/watch <project>` | Monitor a session for changes |
| `/tunnel start <pw>` | Start Cloudflare Tunnel |
| `/tunnel stop <pw>` | Stop tunnel |
| `/tunnel_password <pw>` | Get login password + tunnel URL |
| `/help` | Show all commands |

Password-protected commands auto-delete your message to keep credentials safe.

## Configuration

All config lives in `~/.forge/`:

```
~/.forge/
  .env.local           # Environment variables (AUTH_SECRET, API keys, etc.)
  settings.yaml        # Main configuration
  password.json        # Daily auto-generated login password
  data.db              # SQLite database (tasks, sessions)
  terminal-state.json  # Terminal tab layout
  flows/               # YAML workflow definitions
  bin/                 # Auto-downloaded binaries (cloudflared)
```

### .env.local (optional)

```env
# Fixed auth secret (optional — auto-generated if not set)
AUTH_SECRET=<random-string>

# Optional: AI provider API keys for multi-model chat
# ANTHROPIC_API_KEY=sk-ant-...
# OPENAI_API_KEY=sk-...
# GOOGLE_GENERATIVE_AI_API_KEY=AI...
```

### settings.yaml

```yaml
# Project directories to scan
projectRoots:
  - ~/Projects
  - ~/Work

# Claude Code binary path (default: claude)
claudePath: claude

# Cloudflare Tunnel
tunnelAutoStart: false              # Auto-start on server boot

# Telegram bot (optional)
telegramBotToken: ""                # Bot API token from @BotFather
telegramChatId: ""                  # Your chat ID
telegramTunnelPassword: ""          # Password for tunnel commands

# Task notifications (optional, requires Telegram)
notifyOnComplete: true
notifyOnFailure: true
```

## Architecture

```
┌─────────────────────────────────────────────┐
│  Web Dashboard (Next.js + React)            │
│  ┌──────────┐ ┌──────────┐ ┌─────────────┐ │
│  │  Tasks   │ │ Sessions │ │  Terminal   │ │
│  └──────────┘ └──────────┘ └─────────────┘ │
├─────────────────────────────────────────────┤
│  API Layer (Next.js Route Handlers)         │
├──────────┬──────────┬───────────────────────┤
│  Claude  │  Task    │  Bot Integration      │
│  Code    │  Runner  │  (Telegram, ...)      │
│  Process │  (Queue) │                       │
├──────────┴──────────┴───────────────────────┤
│  SQLite (better-sqlite3)                    │
├─────────────────────────────────────────────┤
│  Terminal Server (node-pty + tmux + WS)     │
├─────────────────────────────────────────────┤
│  Cloudflare Tunnel (optional)               │
└─────────────────────────────────────────────┘
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Next.js 16, React 19, Tailwind CSS 4 |
| Backend | Next.js Route Handlers, SQLite |
| Terminal | xterm.js, node-pty, tmux, WebSocket |
| Auth | NextAuth v5 |
| Tunnel | Cloudflare (cloudflared) |
| Bot | Telegram Bot API (extensible) |

## Troubleshooting

### macOS: "fork failed: Device not configured"

This means the system ran out of pseudo-terminal (PTY) devices. macOS defaults to 511, which can be tight when running IDEs and many terminal sessions. Increase the limit:

```bash
# Temporary (until reboot)
sudo sysctl kern.tty.ptmx_max=2048

# Permanent
echo 'kern.tty.ptmx_max=2048' | sudo tee -a /etc/sysctl.conf
```

## Roadmap

- [ ] **Multi-Agent Workflow** — DAG-based pipelines where multiple Claude Code instances collaborate, passing outputs between nodes with conditional routing and parallel execution. See [docs/roadmap-multi-agent-workflow.md](docs/roadmap-multi-agent-workflow.md).
- [ ] Pipeline UI — DAG visualization with real-time node status
- [ ] Additional bot platforms — Discord, Slack, etc.
- [ ] Multi-model chat with API keys (Anthropic, OpenAI, Google, xAI)

## License

MIT
