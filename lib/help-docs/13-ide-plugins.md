# IDE Plugins

Forge ships with two first-party IDE plugins that mirror the web UI's feature set so you can drive workspaces, agent terminals, pipelines and docs without leaving the editor. Both are **thin clients** — they require a Forge server running locally (or reachable over a tunnel).

| | VSCode extension | IntelliJ plugin |
|---|---|---|
| Marketplace ID | `aion0.forge-vibecoding` | `Forge Vibe Coding` (`com.aion0.forge`) |
| Install | VSCode → Extensions → search `Forge Vibe Coding` | IDE → Settings → Plugins → Marketplace → search `Forge Vibe Coding` |
| Source | `vscode-extension/` | `intellij-plugin/` |
| Min IDE | VSCode ≥ 1.80 | IntelliJ Platform ≥ 2024.1 (build 241) |

## Prerequisites

The plugins do **not** ship Forge — install it once first:

```bash
npm install -g @aion0/forge
forge server start
```

Default port `8403`. The plugins auto-detect `http://localhost:8403`. For remote forges (over Cloudflare tunnel or LAN), add a connection in plugin settings (see below).

## Tool Window / Sidebar Layout

Both plugins expose four tabs:

| Tab | Shows | Right-click actions | Double-click |
|---|---|---|---|
| **Workspaces** | Forge workspaces with daemon status (🟢/○) and per-smith status emoji (▶ running / ⏸ paused / ✓ done / ✕ failed / ◐ starting) | Workspace: start / stop / restart daemon. Smith: open terminal, send message, pause/resume, mark done/failed/idle, retry. | Smith → attach to its tmux session in an IDE terminal |
| **Terminals** | Each forge project as a folder with its claude sessions (★ = bound/pinned default). | Project: **Open With ▸** submenu of every configured agent (claude/codex/aider/...) — fresh launch; New Session… (pick agent); Plain Terminal Here. Session: Resume; Resume With… submenu; Pin as Default Session. | Session row resumes that exact session via `claude --resume <id>` |
| **Pipelines** | Forge projects with their pipeline bindings (⚙ enabled / ⊘ disabled) and recent runs (▶/✓/✕/⊘). | Project: Add Pipeline…; Binding: Trigger Now, Enable/Disable, Remove; Run: Show Nodes; Node: Show Result. | Binding: trigger; Run: expand to see nodes; Node: open prompt/result/diff/log as a markdown buffer |
| **Docs** | Configured doc roots → file/dir tree. | Dir: Open Terminal Here (runs claude); File: Open. | File: open in IDE editor |

## Multi-Connection (Local + Remote forges)

Both plugins support multiple Forge servers — useful when you have one Forge running locally for `~/.forge` and a second running on an office Mac mini exposed via tunnel.

**VSCode**: edit `forge.connections` in settings.json:
```json
{
  "forge.connections": [
    { "name": "Local",  "serverUrl": "http://localhost:8403", "terminalUrl": "ws://localhost:8404" },
    { "name": "Office", "serverUrl": "https://forge-office.trycloudflare.com", "terminalUrl": "wss://forge-office.trycloudflare.com" }
  ],
  "forge.activeConnection": "Local"
}
```
Click the status-bar entry (bottom right, `Forge: <name>`) to switch.

**IntelliJ**: Settings → Tools → Forge → Connections list. Status-bar widget toggles active connection.

Tokens are stored per-connection: VSCode uses `SecretStorage`, IntelliJ uses `PasswordSafe`. `Forge: Login` (command palette / Tools menu) prompts for the admin password and caches the bearer token.

## How agent terminals work

When you double-click a session row or pick `Open With ▸ <agent>`:

1. Plugin calls `GET /api/agents?resolve=<agentId>` → gets `cliCmd`, `cliType`, `supportsSession`, `env`, `model`.
2. For specific-session resume: `claude --resume <sid>` (forced regardless of API's `resumeFlag` — `-c` is wrong for specific resume).
3. Profile env vars are forwarded to the spawned process.
4. `model` is passed as `--model <name>` for claude-code agents (so a "sonnet" profile actually runs sonnet).
5. **IntelliJ** spawns the agent CLI directly as the pty's primary process (`LocalTerminalDirectRunner` subclass with `enableShellIntegration = false` + `configureStartupOptions` override) — no shell, no `executeCommand` race. The user's login shell (`$SHELL -l`) is wrapped around it so `.zprofile` / `.bash_profile` is sourced for PATH.
6. **VSCode** uses the existing terminal-server WebSocket (`forge.terminalUrl`) to attach.

Workspace smith terminals attach to a pre-existing tmux session via `tmux -2 -u attach -t <session>` (UTF-8 + 256-color forced, otherwise JediTerm/xterm.js render boxes wrong).

## Releasing new versions (maintainers)

Each plugin has a `publish.sh` in its directory:

```bash
# VSCode — needs `vsce login aion0` cached, or $VSCE_PAT env var
cd vscode-extension
./publish.sh patch          # bump 0.2.x → 0.2.(x+1) and publish

# IntelliJ — needs $JETBRAINS_MARKETPLACE_TOKEN env var
cd intellij-plugin
./publish.sh patch
```

VSCode goes live in 1–2 minutes. IntelliJ goes through human moderation: 1–3 business days for the first publish, hours-to-1-day for subsequent updates of an already-approved plugin.

## Troubleshooting

- **"Not connected" / "401" in tree** — Forge server isn't running or the token expired. Run `Forge: Login` (or `forge server start` if the server is down).
- **Terminal opens but agent CLI fails** ("`claude: command not found`") — IDE inherited a stripped PATH. The IntelliJ plugin spawns under `$SHELL -l -c …` to source `.zprofile`/`.bash_profile`; if your PATH is set in `.zshrc` only (not `.zprofile`), move it.
- **Smith terminal shows garbled output** — make sure tmux ≥ 3.0 and the IDE terminal supports UTF-8 + 256-color. The plugin already passes `tmux -2 -u attach`; if it still looks broken, check `$LANG` is `*.UTF-8`.
- **Picked a session, claude opens a different one** — Forge ≤ 0.5.43 had `resume: '-c'` hardcoded for claude (which is `--continue`, zero-arg). Upgrade Forge or pull the latest `lib/agents/index.ts`.
- **JetBrains plugin install fails with "incompatible build"** — verify your IDE is build 241+ (Help → About → Build #). The plugin's `sinceBuild = 241`.
- **Tree keeps collapsing folders I expanded** — fixed in IntelliJ plugin v0.1.17 (full path expansion is preserved across the 5-second poll, not just top-level).
