<p align="center">
  <img src="app/icon.svg" width="80" height="80" alt="Forge">
</p>

<h1 align="center">Forge</h1>

<p align="center">
  <strong>Self-hosted Vibe Coding platform — browser terminal, task orchestration, remote access</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@aion0/forge"><img src="https://img.shields.io/npm/v/@aion0/forge" alt="npm"></a>
  <a href="https://github.com/aiwatching/forge/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/@aion0/forge" alt="license"></a>
  <a href="https://github.com/aiwatching/forge"><img src="https://img.shields.io/github/stars/aiwatching/forge?style=social" alt="stars"></a>
</p>

<p align="center">
  <a href="#installation">Install</a> · <a href="#features">Features</a> · <a href="#quick-start">Quick Start</a> · <a href="#telegram-bot">Telegram</a> · <a href="#configuration">Config</a> · <a href="#roadmap">Roadmap</a>
</p>

---

Forge turns [Claude Code](https://docs.anthropic.com/en/docs/claude-code) into a full web-based vibe coding platform. Open your browser, start coding with AI from anywhere — your iPad, phone, or any device with a browser.

**No API keys required.** Runs on your existing Claude Code CLI subscription. Your code stays on your machine.

## Features

| Feature | Description |
|---------|-------------|
| **Vibe Coding** | Browser-based tmux terminal. Multiple tabs, persistent sessions that survive refresh, browser close, and server restart |
| **Remote Access** | One-click Cloudflare Tunnel — secure public URL, zero config, no account needed |
| **Task Queue** | Submit tasks to Claude Code in the background. Live streaming output, cost tracking, session continuity |
| **Docs Viewer** | Render Obsidian vaults / markdown directories with a dedicated Claude Console |
| **Project Manager** | Browse projects, view files, git status, commit, push, pull — all from the browser |
| **Demo Preview** | Preview local dev servers through the tunnel with a dedicated Cloudflare URL |
| **Telegram Bot** | Submit tasks, check status, control tunnel, take notes — all from your phone |
| **File Browser** | Code viewer with syntax highlighting, git changes, diff view, multi-repo support |
| **YAML Workflows** | Define multi-step flows that chain Claude Code tasks together |
| **CLI** | Full command-line interface for task management |

## Installation

### npm (recommended)

```bash
npm install -g @aion0/forge
forge-server
```

### From source

```bash
git clone https://github.com/aiwatching/forge.git
cd forge
pnpm install
pnpm dev
```

### Options

```bash
forge-server              # Production (auto-builds if needed)
forge-server --dev        # Development with hot-reload
forge-server --background # Run in background, logs to ~/.forge/forge.log
forge-server --stop       # Stop background server
forge-server --rebuild    # Force rebuild
```

## Prerequisites

- **Node.js** >= 20
- **tmux** — `brew install tmux` (macOS) / `apt install tmux` (Linux)
- **Claude Code CLI** — `npm install -g @anthropic-ai/claude-code`

## Quick Start

1. **Start Forge**

   ```bash
   forge-server
   ```

2. **Open browser** → `http://localhost:3000`

3. **Log in** — password is auto-generated and printed in the console:

   ```
   [init] Login password: a7x9k2 (valid today)
   ```

   Forgot it? Run `forge password`

4. **Configure projects** — Settings → add your project directories

5. **Start vibe coding** — open a terminal tab, run `claude`, and go

## Remote Access

Access Forge from anywhere — your phone, iPad, or another computer:

1. Click the **tunnel button** in the header
2. Forge auto-downloads `cloudflared` and creates a temporary public URL
3. Open the URL on any device — protected by the daily login password

> The tunnel URL changes each time. Use the Telegram `/tunnel_password` command to get it on your phone.

## Telegram Bot

Control Forge from your phone. Create a bot via [@BotFather](https://t.me/botfather), add the token in Settings.

| Command | Description |
|---------|-------------|
| `/task` | Create a task (interactive project picker) |
| `/tasks` | List tasks with quick-action numbers |
| `/peek` | AI summary of a Claude session |
| `/docs` | Docs session summary or file search |
| `/note` | Quick note — sent to Docs Claude |
| `/tunnel_start` | Start Cloudflare Tunnel |
| `/tunnel_stop` | Stop tunnel |
| `/tunnel_password <pw>` | Get login password + tunnel URL |

Whitelist-protected — only configured Chat IDs can interact with the bot.

## CLI

```bash
forge task <project> <prompt>   # Submit a task
forge tasks [status]            # List tasks
forge watch <id>                # Live stream output
forge status <id>               # Task details + result
forge cancel <id>               # Cancel a task
forge retry <id>                # Retry a failed task
forge run <flow-name>           # Run a YAML workflow
forge projects                  # List projects
forge password                  # Show login password
```

Shortcuts: `t`=task, `ls`=tasks, `w`=watch, `s`=status, `f`=flows, `p`=projects, `pw`=password

## Configuration

All data lives in `~/.forge/`:

```
~/.forge/
├── .env.local            # Environment variables (optional)
├── settings.yaml         # Main configuration
├── password.json         # Daily auto-generated password
├── data.db               # SQLite database
├── terminal-state.json   # Terminal tab layout
├── preview.json          # Demo preview config
├── flows/                # YAML workflow definitions
└── bin/                  # Auto-downloaded binaries
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
┌──────────────────────────────────────────────────┐
│  Web Dashboard (Next.js 16 + React 19)           │
│  ┌─────────┐ ┌──────┐ ┌────────┐ ┌───────────┐  │
│  │  Vibe   │ │ Docs │ │Projects│ │Demo       │  │
│  │ Coding  │ │      │ │        │ │Preview    │  │
│  └─────────┘ └──────┘ └────────┘ └───────────┘  │
├──────────────────────────────────────────────────┤
│  API Layer (Next.js Route Handlers)              │
├───────────┬───────────┬──────────────────────────┤
│  Claude   │  Task     │  Telegram Bot            │
│  Code     │  Runner   │  + Notifications         │
│  Process  │  (Queue)  │                          │
├───────────┴───────────┴──────────────────────────┤
│  SQLite · Terminal Server · Cloudflare Tunnel    │
└──────────────────────────────────────────────────┘
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Next.js 16, React 19, Tailwind CSS 4, xterm.js |
| Backend | Next.js Route Handlers, SQLite (better-sqlite3) |
| Terminal | node-pty, tmux, WebSocket |
| Auth | NextAuth v5 (daily rotating password + OAuth) |
| Tunnel | Cloudflare cloudflared (zero-config) |
| Bot | Telegram Bot API |

## Troubleshooting

<details>
<summary><strong>macOS: "fork failed: Device not configured"</strong></summary>

PTY device limit exhausted. Increase it:

```bash
sudo sysctl kern.tty.ptmx_max=2048

# Permanent
echo 'kern.tty.ptmx_max=2048' | sudo tee -a /etc/sysctl.conf
```

</details>

<details>
<summary><strong>Session cookie invalid after restart</strong></summary>

Fix the AUTH_SECRET so it persists:

```bash
echo "AUTH_SECRET=$(openssl rand -hex 32)" >> ~/.forge/.env.local
```

</details>

## Roadmap

- [ ] **Multi-Agent Workflow** — DAG-based pipelines where multiple Claude Code instances collaborate ([design doc](docs/roadmap-multi-agent-workflow.md))
- [ ] Pipeline UI — DAG visualization with real-time node status
- [ ] Additional bot platforms — Discord, Slack
- [ ] Excalidraw rendering in Docs viewer
- [ ] Multi-model chat (Anthropic, OpenAI, Google, xAI)

## Contributing

Contributions welcome! Please open an issue first to discuss what you'd like to change.

## License

[MIT](LICENSE)
