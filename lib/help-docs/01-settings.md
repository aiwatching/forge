# Settings Configuration

Settings are stored in `~/.forge/data/settings.yaml`. Configure via the web UI (Settings button in top-right menu) or edit YAML directly.

## All Settings Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `projectRoots` | string[] | `[]` | Directories containing your projects (e.g. `~/Projects`) |
| `docRoots` | string[] | `[]` | Markdown/Obsidian vault directories |
| `claudePath` | string | `""` | Path to claude binary (auto-detected if empty) |
| `claudeHome` | string | `""` | Claude Code home directory (default: `~/.claude`) |
| `telegramBotToken` | string | `""` | Telegram Bot API token (encrypted) |
| `telegramChatId` | string | `""` | Telegram chat ID (comma-separated for multiple users) |
| `notifyOnComplete` | boolean | `true` | Telegram notification on task completion |
| `notifyOnFailure` | boolean | `true` | Telegram notification on task failure |
| `tunnelAutoStart` | boolean | `false` | Auto-start Cloudflare Tunnel on server startup |
| `telegramTunnelPassword` | string | `""` | Admin password for login + tunnel + secrets (encrypted) |
| `taskModel` | string | `"default"` | Model for background tasks |
| `pipelineModel` | string | `"default"` | Model for pipeline workflows |
| `telegramModel` | string | `"sonnet"` | Model for Telegram AI features |
| `skipPermissions` | boolean | `false` | Add `--dangerously-skip-permissions` to claude invocations |
| `notificationRetentionDays` | number | `30` | Auto-cleanup notifications older than N days |
| `skillsRepoUrl` | string | forge-skills URL | GitHub raw URL for skills registry |
| `displayName` | string | `"Forge"` | Display name shown in header |
| `displayEmail` | string | `""` | User email |

## Admin Password

- Set on first launch (CLI prompt)
- Required for: login, tunnel start, secret changes, Telegram commands
- Reset: `forge --reset-password`
- Forgot? Run `forge --reset-password` in terminal

## Encrypted Fields

`telegramBotToken` and `telegramTunnelPassword` are encrypted with AES-256-GCM. The encryption key is stored at `~/.forge/data/.encrypt-key`.
