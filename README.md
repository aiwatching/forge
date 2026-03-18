<p align="center">
  <img src="app/icon.svg" width="80" height="80" alt="Forge - Self-hosted Vibe Coding Platform">
</p>

<h1 align="center">Forge</h1>

<p align="center">
  <strong>Self-hosted Vibe Coding platform for Claude Code — browser terminal, AI task orchestration, remote access from any device</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@aion0/forge"><img src="https://img.shields.io/npm/v/@aion0/forge" alt="npm version"></a>
  <a href="https://github.com/aiwatching/forge/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/@aion0/forge" alt="MIT license"></a>
  <a href="https://github.com/aiwatching/forge"><img src="https://img.shields.io/github/stars/aiwatching/forge?style=social" alt="GitHub stars"></a>
</p>

<p align="center">
  <a href="#installation">Install</a> · <a href="#features">Features</a> · <a href="#quick-start">Quick Start</a> · <a href="#telegram-bot">Telegram</a> · <a href="#scripts">Scripts</a> · <a href="#configuration">Config</a> · <a href="#roadmap">Roadmap</a>
</p>

---

## What is Forge?

Forge is a self-hosted web platform that turns [Claude Code](https://docs.anthropic.com/en/docs/claude-code) into a remote-accessible vibe coding environment. It provides a persistent browser-based terminal (powered by tmux), background AI task orchestration, one-click Cloudflare Tunnel for remote access, and a Telegram bot for mobile control.

**Use cases:**
- Vibe code from your iPad, phone, or any browser — Claude Code runs on your machine, you access it from anywhere
- Submit AI coding tasks that run in the background while you sleep
- Chain multiple Claude Code instances into automated pipelines (design → implement → review → deploy)
- Browse and search your Obsidian notes with an AI assistant

**No API keys required.** Forge uses your existing Claude Code CLI subscription. Your code never leaves your machine.

## Features

| Feature | What it does |
|---------|-------------|
| **Vibe Coding** | Browser-based tmux terminal with multiple tabs. Sessions persist across page refresh, browser close, and server restart. Access from any device via Cloudflare Tunnel. |
| **AI Task Queue** | Submit prompts to Claude Code that run in the background. Live streaming output, cost tracking, session continuity across tasks. Supports `--dangerously-skip-permissions` for fully autonomous operation. |
| **Pipeline Engine** | Define multi-step DAG workflows in YAML. Chain Claude Code tasks with dependencies, output passing between steps, conditional routing, and parallel execution. Visual drag-and-drop editor included. |
| **Remote Access** | One-click Cloudflare Tunnel generates a secure public URL. Zero config, no Cloudflare account needed. Auto-health-check with reconnection. |
| **Docs Viewer** | Render Obsidian vaults and markdown directories in the browser. Built-in Claude Console for AI-assisted note-taking and research. Image support. |
| **Project Manager** | Browse project files, view code with syntax highlighting, git status/commit/push/pull, commit history — all from the browser. Multi-repo support. |
| **Demo Preview** | Preview local dev servers (Vite, Next.js, etc.) through dedicated Cloudflare Tunnel URLs. Multiple simultaneous previews supported. |
| **Telegram Bot** | Create tasks, check status, control tunnel, take notes, get AI session summaries — all from your phone. Whitelist-protected. |
| **CLI** | Full command-line interface: `forge task`, `forge watch`, `forge status`, `forge password`, and more. |
| **Monitor** | Real-time dashboard showing process status (Next.js, Terminal, Telegram, Tunnel), tmux sessions, and system uptime. |

## Installation

```bash
npm install -g @aion0/forge
forge-server
```

Open `http://localhost:3000` — a login password is printed in the console.

### From source

```bash
git clone https://github.com/aiwatching/forge.git
cd forge
pnpm install
./start.sh        # production
./start.sh dev    # development with hot-reload
```

### Prerequisites

- **Node.js** >= 20
- **tmux** — `brew install tmux` (macOS) / `apt install tmux` (Linux)
- **Claude Code CLI** — `npm install -g @anthropic-ai/claude-code`

## Quick Start

1. **Start Forge** — `forge-server` or `./start.sh`
2. **Open browser** — `http://localhost:3000`
3. **Log in** — password is in the console output, rotates daily. Run `forge password` if you forget.
4. **Configure** — Settings → add project directories and (optionally) Telegram bot token
5. **Start coding** — Open a terminal tab, run `claude`, and vibe

## Remote Access

Access Forge from anywhere — iPad, phone, coffee shop:

1. Click the **tunnel button** in the header
2. A temporary Cloudflare URL is generated (no account needed)
3. Open it on any device — protected by your daily rotating password

Health checks run every 60 seconds. If the tunnel drops, it auto-restarts and notifies you via Telegram.

## Telegram Bot

Mobile-first control for Forge. Create a bot via [@BotFather](https://t.me/botfather), add the token in Settings.

| Command | Description |
|---------|-------------|
| `/task` | Create a task (interactive project picker) |
| `/tasks` | List tasks with quick-action numbers |
| `/sessions` | AI summary of Claude Code sessions |
| `/docs` | Docs session summary or file search |
| `/note` | Quick note — sent to Docs Claude for filing |
| `/tunnel_start` | Start Cloudflare Tunnel |
| `/tunnel_stop` | Stop tunnel |
| `/tunnel_password <pw>` | Get login password + tunnel URL |
| `/watch` | Monitor session / list watchers |

Whitelist-protected — only configured Chat IDs can interact. Supports multiple users (comma-separated IDs).

## Pipeline Engine

Define multi-step AI workflows in YAML. Each step runs Claude Code autonomously, with outputs passed to downstream steps.

```yaml
name: feature-build
description: "Design → Implement → Review"
input:
  requirement: "Feature description"
vars:
  project: my-app
nodes:
  architect:
    project: "{{vars.project}}"
    prompt: "Analyze: {{input.requirement}}. Output a design doc."
    outputs:
      - name: design
        extract: result
  implement:
    project: "{{vars.project}}"
    depends_on: [architect]
    prompt: "Implement: {{nodes.architect.outputs.design}}"
    outputs:
      - name: diff
        extract: git_diff
  review:
    depends_on: [implement]
    project: "{{vars.project}}"
    prompt: "Review: {{nodes.implement.outputs.diff}}"
```

Features: DAG execution, parallel nodes, conditional routing, loop protection, Telegram notifications per step, visual editor.

## CLI

All commands are unified under `forge`:

```bash
# Server management
forge server start              # Start server (foreground)
forge server start --background # Start in background
forge server start --dev        # Development mode with hot-reload
forge server start --port 4000  # Custom port
forge server stop               # Stop server
forge server restart            # Restart (safe for remote use)
forge server rebuild            # Force rebuild

# Tasks
forge task <project> <prompt>   # Submit a task
forge tasks [status]            # List tasks (running|queued|done|failed)
forge watch <id>                # Live stream task output
forge cancel <id>               # Cancel a task
forge retry <id>                # Retry a failed task

# Workflows
forge run <flow-name>           # Run a YAML workflow
forge flows                     # List available workflows

# Status & Info
forge status                    # Show process status + tmux sessions
forge status <id>               # Show task details
forge password                  # Show login password
forge projects                  # List configured projects
forge -v                        # Show version

# Package management
forge upgrade                   # Update to latest npm version
forge uninstall                 # Stop server + uninstall (data preserved in ~/.forge)
```

Shortcuts: `t`=task, `ls`=tasks, `w`=watch, `s`=status, `l`=log, `f`=flows, `p`=projects, `pw`=password

### Server start options

```bash
forge server start --port 4000           # Custom web port (default: 3000)
forge server start --terminal-port 4001  # Custom terminal port (default: 3001)
forge server start --dir ~/.forge-test   # Custom data directory
forge server start --background          # Run in background
forge server start --reset-terminal      # Kill terminal server on start
```

### Development scripts

```bash
./start.sh              # kill old processes → build → start (production)
./start.sh dev          # development with hot-reload
./dev-test.sh           # test instance on port 4000 (separate data dir)
./install.sh            # install from npm
./install.sh --local    # install from local source
./publish.sh            # bump version → commit → tag → ready to publish
./check-forge-status.sh # show all forge processes + tmux sessions
```

## Configuration

All data lives in `~/.forge/`:

```
~/.forge/
├── .env.local            # Environment variables (AUTH_SECRET, API keys)
├── settings.yaml         # Main configuration
├── password.json         # Daily auto-generated login password
├── data.db               # SQLite database (tasks, sessions)
├── terminal-state.json   # Terminal tab layout
├── tunnel-state.json     # Tunnel process state
├── preview.json          # Demo preview config
├── pipelines/            # Pipeline execution state
├── flows/                # YAML workflow definitions
└── bin/                  # Auto-downloaded binaries (cloudflared)
```

<details>
<summary><strong>settings.yaml</strong></summary>

```yaml
projectRoots:
  - ~/Projects
docRoots:
  - ~/Documents/obsidian-vault
claudePath: claude
tunnelAutoStart: false
telegramBotToken: ""
telegramChatId: ""              # Comma-separated for multiple users
telegramTunnelPassword: ""
notifyOnComplete: true
notifyOnFailure: true
taskModel: default              # default / sonnet / opus / haiku
pipelineModel: default
telegramModel: sonnet
skipPermissions: false          # Add --dangerously-skip-permissions to terminal claude invocations
```

</details>

<details>
<summary><strong>.env.local</strong> (optional)</summary>

```env
# Fixed auth secret (auto-generated if not set)
AUTH_SECRET=<random-string>

# Optional: AI provider API keys for multi-model chat
# ANTHROPIC_API_KEY=sk-ant-...
# OPENAI_API_KEY=sk-...
```

</details>

## Architecture

```
forge-server.mjs (single process)
├── Next.js (web dashboard + API)
│   ├── Vibe Coding (xterm.js + tmux)
│   ├── Docs Viewer (markdown + Claude Console)
│   ├── Project Manager (files + git)
│   ├── Task Queue (background Claude Code)
│   ├── Pipeline Engine (DAG workflows)
│   ├── Demo Preview (tunnel proxy)
│   └── Monitor (process status)
├── terminal-standalone.ts (WebSocket → tmux)
├── telegram-standalone.ts (Telegram Bot API polling)
└── cloudflared (Cloudflare Tunnel, on demand)
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Next.js 16, React 19, Tailwind CSS 4, xterm.js, ReactFlow |
| Backend | Next.js Route Handlers, SQLite (better-sqlite3) |
| Terminal | node-pty, tmux, WebSocket |
| Auth | NextAuth v5 (daily rotating password + OAuth) |
| Tunnel | Cloudflare cloudflared (zero-config) |
| Bot | Telegram Bot API |
| Pipeline | YAML-based DAG engine with visual editor |

## Troubleshooting

<details>
<summary><strong>macOS: "fork failed: Device not configured"</strong></summary>

PTY device limit exhausted:

```bash
sudo sysctl kern.tty.ptmx_max=2048
echo 'kern.tty.ptmx_max=2048' | sudo tee -a /etc/sysctl.conf
```

</details>

<details>
<summary><strong>Session cookie invalid after restart</strong></summary>

Fix AUTH_SECRET so it persists across restarts:

```bash
echo "AUTH_SECRET=$(openssl rand -hex 32)" >> ~/.forge/.env.local
```

</details>

<details>
<summary><strong>Orphan processes after Ctrl+C</strong></summary>

Use `./start.sh` or `forge-server` which clean up old processes on start. Or manually:

```bash
./check-forge-status.sh  # see what's running
pkill -f 'telegram-standalone|terminal-standalone|next-server|cloudflared'
```

</details>

## Roadmap

- [ ] **Multi-Agent Collaboration** — Real-time message channels between concurrent Claude Code instances ([design doc](docs/roadmap-multi-agent-workflow.md))
- [ ] Additional bot platforms — Discord, Slack
- [ ] Excalidraw rendering in Docs viewer
- [ ] Multi-model chat with API keys (Anthropic, OpenAI, Google, xAI)
- [ ] Plugin system for custom integrations

## Contributing

Contributions welcome! Please open an issue first to discuss what you'd like to change.

## License

[MIT](LICENSE)
