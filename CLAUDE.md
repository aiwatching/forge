# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project: Forge (@aion0/forge)

Self-hosted Vibe Coding platform — Next.js web UI + tmux-backed browser terminal + multi-agent workspace + Telegram bot + Cloudflare tunnel, wrapping Claude Code and other CLIs.

Package manager is **pnpm** (pinned in `packageManager`). `better-sqlite3` and `node-pty` are native — `pnpm rebuild` after a Node upgrade.

## Scripts

```bash
# ── Start ──
./start.sh                       # production (kill old processes → build → start)
./start.sh dev                   # development (hot-reload, FORGE_DEV=1 bypasses auth)
forge server start               # production via npm link/install, background + logs to <data>/forge.log
forge server start --foreground  # run in foreground
forge server start --dev         # dev mode
forge server stop                # stop default instance (port 8403)
forge server stop --port 4000 --dir ~/.forge-staging   # stop specific instance
forge server restart             # stop + start (safe for remote)
forge server rebuild             # force rebuild .next
forge server start --port 4000 --terminal-port 4001 --workspace-port 4002 --dir ~/.forge-staging
forge server start --reset-terminal  # kill terminal server (loses tmux attach)
forge --reset-password           # reset admin password
forge --version

# ── Test instance ──
./dev-test.sh                    # port 4000, data ~/.forge-test, hot-reload

# ── Install / Publish ──
./install.sh                     # from npm
./install.sh --local             # npm link + pnpm build from source
./publish.sh [patch|minor|major|x.y.z]   # bump, generate RELEASE_NOTES.md, commit, tag, push, gh release
npm login && npm publish --access public --otp=<code>

# ── Monitor ──
./check-forge-status.sh          # show process status + tmux sessions

# ── Tests (no framework — custom tsx scripts) ──
npx tsx lib/workspace/__tests__/workspace.test.ts
npx tsx lib/workspace/__tests__/state-machine.test.ts
npx tsx scripts/verify-usage.ts

# ── CLI (talks to running server over HTTP) ──
forge                            # help
forge task <project> "prompt"    # submit a background task (--new for fresh session)
forge tasks                      # list
forge watch <id>                 # live stream task output
forge tcode                      # tunnel URL + session code
```

The CLI (`cli/mw.ts`) reaches the server at `http://localhost:${MW_URL port or 3000}`. Set `MW_URL` if the server is not on the default port.

## Architecture

### Process model
Forge runs as **four cooperating processes**, normally launched by `bin/forge-server.mjs`:

| Process | Port (default) | Responsibility |
|---|---|---|
| `next-server` (web UI + API) | 8403 | Next.js app — UI, REST/SSE APIs, auth |
| `lib/terminal-standalone.ts` | 8404 | WebSocket ↔ tmux pty bridge for browser terminals |
| `lib/workspace-standalone.ts` | 8405 (+ MCP 8406) | Workspace daemon + MCP server — **exclusive writer of workspace `state.json`** |
| `lib/telegram-standalone.ts` | — | Telegram bot polling loop |

Each forked service is spawned with a `--forge-port=<webPort>` instance tag. `forge-server.mjs`'s `cleanupOrphans()` uses this tag to kill *this* instance's stale processes and legacy untagged orphans while leaving other instances alone. When adding a new standalone, keep the tag forwarded.

### Dev mode vs production mode
- `FORGE_EXTERNAL_SERVICES=1` tells Next.js (`lib/init.ts`) **not** to spawn terminal/telegram/workspace — `forge-server.mjs` manages them. This is set automatically by `forge-server.mjs` in prod/background/dev.
- Plain `pnpm dev` (or `./dev-test.sh`) sets it to `0` — `lib/init.ts` becomes the process supervisor and spawns the standalones itself. Use this when iterating on Next.js only.
- `FORGE_DEV=1` (set by `./start.sh dev`) **bypasses login in `middleware.ts`** — never set in production.

### Data layout (`lib/dirs.ts`)
- `getConfigDir()` → `~/.forge/` — shared across instances, holds `bin/` (cloudflared).
- `getDataDir()` → `FORGE_DATA_DIR` env var, or `--dir` flag, or `~/.forge/data/` — **per-instance** settings, sqlite (`workflow.db`), encrypted key, flows, logs, workspaces.
- A one-time migration on startup moves the legacy flat `~/.forge/*` layout into `~/.forge/data/*` (also handled in `forge-server.mjs`). If touching paths, check both places.

### `lib/init.ts` side effects
First API request per Next.js worker triggers `ensureInitialized()` (guarded by a global Symbol). It migrates secrets, auto-detects CLI agents (`which claude`), installs Forge's skills into `~/.claude/skills/`, syncs `lib/help-docs/` to `<dataDir>/help/`, and starts the task runner / session watcher / pipeline scheduler. Anything you add here runs on every cold worker — keep it idempotent.

### Workspace orchestration (`lib/workspace/`)
- `orchestrator.ts` (3400 lines) is the core DAG engine; `manager.ts` is a singleton cache of orchestrators keyed by workspace ID (HMR-safe via `globalThis.__forgeOrchestrators`).
- `persistence.ts` exports `loadWorkspace` / `listWorkspaces` etc. but **intentionally does not export `saveWorkspace`** — all mutations must go through the workspace daemon's HTTP API to avoid multi-writer races. Respect this when adding new mutators.
- `agent-bus.ts` = inter-agent messages (notifications + tickets); `agent-worker.ts` = per-agent loop; `backends/{api,cli}-backend.ts` = API vs CLI execution; `watch-manager.ts` = autonomous file/git/command monitoring.

### Settings & secrets
`lib/settings.ts` reads/writes `<dataDir>/settings.yaml`. Fields listed in `SECRET_FIELDS` (`lib/crypto.ts`) are auto-encrypted with AES-256-GCM using `<dataDir>/.encrypt-key`. `lib/init.ts#migrateSecrets` re-encrypts any plaintext secret on startup.

## Help Docs Rule

When adding or changing a feature, check if `lib/help-docs/` needs updating. Each file covers one module:
- `00-overview.md` — install, start, data paths
- `01-settings.md` — all settings fields
- `02-telegram.md` — bot setup and commands
- `03-tunnel.md` — remote access
- `04-tasks.md` — background tasks
- `05-pipelines.md` — DAG workflows
- `06-skills.md` — marketplace
- `07-projects.md` — project management
- `08-rules.md` — CLAUDE.md templates
- `09-issue-autofix.md` — GitHub issue scanner
- `10-troubleshooting.md` — common issues
- `11-workspace.md` — multi-agent workspace (smiths, daemon, request docs)
- `12-usage.md` — token usage analytics and cost tracking

If a feature change affects user-facing behavior, update the corresponding help doc in the same commit. These docs are also served to the in-app Help AI — `lib/help-docs/CLAUDE.md` is its system prompt.

## Commit conventions

`publish.sh` groups release notes by prefix: `feat:`, `fix:`, `perf:`, `refactor:`, `docs:`. Anything else lands in "Other". Use these prefixes for anything you want surfaced in release notes.

## Key paths

- Data: `~/.forge/data/` (override with `FORGE_DATA_DIR` or `--dir`)
- npm package: `@aion0/forge`
- GitHub: `github.com/aiwatching/forge`

## Obsidian Vault
Location: /Users/zliu/MyDocuments/obsidian-project/Projects/Bastion
When I ask about my notes, use bash to search and read files from this directory.
Example: find /Users/zliu/MyDocuments/obsidian-project -name "*.md" | head -20

<!-- forge:template:obsidian-vault -->
## Obsidian Vault
When I ask about my notes, use bash to search and read files from the vault directory.
Example: find <vault_path> -name "*.md" | head -20
<!-- /forge:template:obsidian-vault -->


<!-- FORGE:BEGIN -->
## Forge Workspace Integration
When you finish processing a task or message from Forge, end your final response with the marker: [FORGE_DONE]
This helps Forge detect task completion. Do not include this marker if you are still working.
<!-- FORGE:END -->
