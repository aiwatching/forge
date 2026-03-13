# Forge

> Unified AI workflow platform — multi-model task orchestration, persistent sessions, web terminal, and remote access.

Forge is a self-hosted web platform that turns [Claude Code](https://docs.anthropic.com/en/docs/claude-code) into a managed task engine. Submit AI coding tasks from a web dashboard, CLI, or Telegram — and let them run in the background with full session continuity, cost tracking, and live streaming.

## Features

- **Task Orchestration** — Submit tasks to Claude Code, queue them, track progress, stream output in real-time
- **Multi-Model Chat** — Built-in chat sessions with Anthropic, OpenAI, Google, and xAI providers
- **Persistent Sessions** — Tasks for the same project automatically continue the previous conversation context
- **Web Terminal** — tmux-backed terminal in the browser with tab management, survives page refresh and server restart
- **YAML Workflows** — Define multi-step flows that chain tasks together
- **Telegram Bot** — Submit tasks, check status, control tunnel — all from your phone
- **Remote Access** — One-click Cloudflare Tunnel for secure public URL (zero config, no account needed)
- **Session Watcher** — Monitor Claude Code sessions for changes, idle state, keywords, or errors
- **CLI** — Full-featured command-line interface for task management
- **Auth** — Auto-generated daily rotating password + optional Google OAuth

## Prerequisites

- **Node.js** >= 20
- **pnpm** (recommended) or npm
- **tmux** — for web terminal sessions
- **Claude Code CLI** — `npm install -g @anthropic-ai/claude-code`
- At least one AI provider API key (Anthropic, OpenAI, Google, or xAI)

## Installation

### From npm

```bash
npm install -g @aion0/forge
```

### From source

```bash
git clone https://github.com/aiwatching/forge.git
cd forge
pnpm install
pnpm build
```

## Quick Start

### 1. Set up API keys

Create `.env.local` in the project root:

```env
# Required: at least one provider
ANTHROPIC_API_KEY=sk-ant-...

# Optional: additional providers
OPENAI_API_KEY=sk-...
GOOGLE_GENERATIVE_AI_API_KEY=AI...
XAI_API_KEY=xai-...

# Auth (auto-generated on first run)
AUTH_SECRET=<random-string>
AUTH_TRUST_HOST=true

# Optional: Google OAuth
# GOOGLE_CLIENT_ID=...
# GOOGLE_CLIENT_SECRET=...
```

### 2. Start the server

```bash
# Development
pnpm dev

# Production
pnpm build && pnpm start
```

### 3. Log in

Open `http://localhost:3000`. A login password is auto-generated and printed in the console:

```
[init] Login password: a7x9k2 (valid today)
```

Forgot it? Run:

```bash
forge password
# or
npx tsx cli/mw.ts password
```

### 4. Configure projects

Open **Settings** (gear icon) and add your project root directories (e.g. `~/Projects`). Forge will scan for git repositories automatically.

## CLI Usage

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

# Execution log
forge log <task-id>

# Cancel / retry
forge cancel <task-id>
forge retry <task-id>

# Run a YAML workflow
forge run daily-review

# List workflows / projects
forge flows
forge projects

# Session management
forge session                          # list all project sessions
forge session my-app                   # get session for a project
forge session link my-app <session-id> # link a local Claude session
```

**Shortcuts:** `t`=task, `r`=run, `ls`=tasks, `w`=watch, `l`=log, `s`=status, `f`=flows, `p`=projects, `pw`=password

## YAML Workflows

Define multi-step flows in `~/.my-workflow/flows/`:

```yaml
# ~/.my-workflow/flows/daily-review.yaml
name: daily-review
steps:
  - project: my-app
    prompt: "Review open TODOs and suggest fixes"
  - project: my-api
    prompt: "Check for any failing tests and fix them"
```

Run with `forge run daily-review`.

## Telegram Bot

Control Forge from Telegram for mobile-friendly task management.

### Setup

1. Create a bot via [@BotFather](https://t.me/botfather)
2. In Settings, add your **Bot Token** and **Chat ID**
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

## Remote Access (Cloudflare Tunnel)

Access Forge from anywhere without port forwarding or DNS config:

1. Click the **tunnel icon** in the header bar, or go to **Settings > Remote Access**
2. Click **Start** — Forge auto-downloads `cloudflared` and creates a temporary public URL
3. Share the URL — it's protected by the daily login password

Enable **Auto-start** in Settings to start the tunnel on every server boot.

> The tunnel URL changes each time. Use the Telegram `/tunnel_password` command to get the current URL and password on your phone.

## Web Terminal

The built-in terminal runs on tmux, so sessions persist across:
- Page refreshes
- Browser close/reopen
- Server restarts

Features:
- Multiple tabs with custom names
- Runs on `localhost:3001` (auto-proxied through the main app for remote access)
- Large scrollback buffer (50,000 lines)
- Mouse support

## Configuration

All config lives in `~/.my-workflow/`:

```
~/.my-workflow/
  settings.yaml      # Main configuration
  password.json      # Daily auto-generated login password
  data.db            # SQLite database (tasks, sessions)
  terminal-state.json # Terminal tab layout
  flows/             # YAML workflow definitions
  bin/               # Auto-downloaded binaries (cloudflared)
```

### settings.yaml

```yaml
projectRoots:
  - ~/Projects
  - ~/Work
claudePath: claude                  # Claude Code binary path
telegramBotToken: "123:ABC..."      # Telegram bot token
telegramChatId: "12345"             # Your Telegram chat ID
notifyOnComplete: true              # Notify when tasks finish
notifyOnFailure: true               # Notify on task failure
tunnelAutoStart: false              # Auto-start Cloudflare Tunnel
telegramTunnelPassword: "secret"    # Password for Telegram tunnel commands
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
│  Claude  │  Task    │  Telegram Bot         │
│  Code    │  Runner  │  (Polling)            │
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
| AI | Vercel AI SDK, Anthropic/OpenAI/Google/xAI |
| Terminal | xterm.js, node-pty, tmux, WebSocket |
| Auth | NextAuth v5 |
| Tunnel | Cloudflare (cloudflared) |
| Bot | Telegram Bot API |

## License

MIT
