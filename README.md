<p align="center">
  <img src="app/icon.svg" width="80" height="80" alt="Forge">
</p>

<h1 align="center">Forge</h1>

<p align="center">
  <strong>Self-hosted Vibe Coding platform for Claude Code</strong><br>
  Browser terminal · AI tasks · Remote access · Telegram bot
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@aion0/forge"><img src="https://img.shields.io/npm/v/@aion0/forge" alt="npm"></a>
  <a href="https://github.com/aiwatching/forge/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/@aion0/forge" alt="MIT"></a>
  <a href="https://github.com/aiwatching/forge"><img src="https://img.shields.io/github/stars/aiwatching/forge?style=social" alt="stars"></a>
</p>

<p align="center">
  <a href="https://www.youtube.com/watch?v=F3fiSiP3pZY">Watch Demo →</a>
</p>

---

## Demo & Install Guide

[![Forge Install Guide](https://img.youtube.com/vi/F3fiSiP3pZY/maxresdefault.jpg)](https://www.youtube.com/watch?v=F3fiSiP3pZY)

## Install

```bash
npm install -g @aion0/forge
forge server start
```

Open `http://localhost:8403`. First launch prompts you to set an admin password.

**Requirements:** Node.js ≥ 20, tmux, [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)

## What is Forge?

Forge turns Claude Code into a remote-accessible coding platform. Run it on your machine, access from any device.

- **Vibe Code anywhere** — iPad, phone, any browser. Persistent tmux sessions survive refresh/restart
- **Background AI tasks** — Submit prompts that run while you sleep. Live output, cost tracking
- **Pipeline workflows** — Chain Claude Code steps in YAML (design → implement → review)
- **Remote access** — One-click Cloudflare Tunnel, no account needed
- **Telegram bot** — Create tasks, check status, take notes from your phone
- **Skills marketplace** — Browse & install Claude Code slash commands

No API keys required. Uses your existing Claude Code subscription. Code never leaves your machine.

## Features

| | |
|---|---|
| **Vibe Coding** | Browser tmux terminal, multi-tab, split panes, persistent sessions |
| **AI Tasks** | Background Claude Code execution with live streaming output |
| **Pipelines** | YAML DAG workflows with parallel execution & visual editor |
| **Remote Access** | Cloudflare Tunnel with 2FA (password + session code) |
| **Docs Viewer** | Obsidian / markdown rendering with AI assistant |
| **Projects** | File browser, git operations, code viewer with syntax highlighting, diff view |
| **Skills** | Marketplace for skills & commands — browse, install, update, version tracking |
| **Telegram** | Tasks, sessions, notes, tunnel control from mobile |
| **CLI** | `forge task`, `forge watch`, `forge status`, and more |

## Quick Start

```bash
forge server start              # start (background by default)
forge server start --foreground # run in foreground
forge server start --dev        # dev mode with hot-reload
forge server stop               # stop
forge server restart            # restart
```

### From source

```bash
git clone https://github.com/aiwatching/forge.git
cd forge && pnpm install
./start.sh          # production
./start.sh dev      # development
```

## CLI

```bash
forge task <project> <prompt>   # submit a task
forge tasks                     # list tasks
forge watch <id>                # live stream output
forge status                    # process status
forge tcode                     # show tunnel URL + session code
forge projects                  # list projects
forge flows                     # list workflows
forge run <flow>                # run a workflow
forge --reset-password               # reset admin password
```

## Telegram Bot

Create a bot via [@BotFather](https://t.me/botfather), add the token in Settings.

`/task` — create task · `/tasks` — list · `/sessions` — AI summary · `/note` — quick note · `/tunnel_start` — start tunnel · `/watch` — monitor session

## Data

All data in `~/.forge/` — settings, database, terminal state, workflows, logs. Configurable via `--dir` flag.

## License

[MIT](LICENSE)
