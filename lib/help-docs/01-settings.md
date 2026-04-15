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
| `defaultAgent` | string | `"claude"` | Default agent for tasks and terminal |
| `telegramAgent` | string | `""` | Agent for Telegram task execution |
| `docsAgent` | string | `""` | Agent for documentation queries |
| `skipPermissions` | boolean | `false` | Add `--dangerously-skip-permissions` to claude invocations |
| `manageClaudeConfig` | boolean | `true` | When `false`, Forge will not modify `~/.claude/` or project `.claude/` files (skills, Stop hook, permissions, profile env/model) |
| `notificationRetentionDays` | number | `30` | Auto-cleanup notifications older than N days |
| `skillsRepoUrl` | string | forge-skills URL | GitHub raw URL for skills registry |
| `displayName` | string | `"Forge"` | Display name shown in header |
| `displayEmail` | string | `""` | User email |
| `favoriteProjects` | string[] | `[]` | Starred project paths |
| `obsidianVault` | string | `""` | Path to Obsidian vault |

## Agents

Forge auto-detects installed CLI agents (Claude Code, Codex, Aider). You can also add custom agents manually.

### Agent Fields

Each agent entry in `settings.agents` supports:

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Display name |
| `path` | string | Path to CLI binary |
| `enabled` | boolean | Whether this agent is available |
| `cliType` | string | CLI tool type: `claude-code`, `codex`, `aider`, `generic` |
| `taskFlags` | string | Flags for headless task execution (e.g. `-p --verbose`) |
| `interactiveCmd` | string | Command for interactive terminal sessions |
| `resumeFlag` | string | Flag to resume sessions (e.g. `-c` for claude) |
| `outputFormat` | string | Output format: `stream-json`, `text` |
| `skipPermissionsFlag` | string | Flag to skip permissions (e.g. `--dangerously-skip-permissions`) |
| `requiresTTY` | boolean | Whether agent needs a PTY (true for codex) |
| `models` | object | Model overrides per context: `terminal`, `task`, `telegram`, `help`, `mobile` |
| `profile` | string | Linked profile ID — applies that profile's env/model when launching |

### CLI Type

The `cliType` field determines how Forge interacts with the agent:

| CLI Type | Session Support | Resume | Skip Permissions |
|----------|----------------|--------|------------------|
| `claude-code` | Yes (session files) | `-c` / `--resume <id>` | `--dangerously-skip-permissions` |
| `codex` | No | — | `--full-auto` |
| `aider` | No | — | `--yes` |
| `generic` | No | — | — |

### Example YAML

```yaml
agents:
  claude:
    name: Claude Code
    path: /usr/local/bin/claude
    enabled: true
    cliType: claude-code
    skipPermissionsFlag: --dangerously-skip-permissions
  codex:
    name: OpenAI Codex
    path: codex
    enabled: true
    cliType: codex
    requiresTTY: true
    skipPermissionsFlag: --full-auto
```

## Agent Profiles

Profiles are reusable configurations that extend a base agent with custom environment variables, model overrides, and CLI settings. Any smith or terminal session can use a profile.

### Profile Fields

| Field | Type | Description |
|-------|------|-------------|
| `base` | string | Base agent ID (e.g. `claude`, `codex`) — makes this entry a profile |
| `name` | string | Display name |
| `model` | string | Model override (passed via `--model` flag) |
| `env` | object | Environment variables injected when launching |
| `cliType` | string | Override CLI type (inherits from base if not set) |
| `enabled` | boolean | Whether this profile is available |

### Example: Custom API Endpoint Profile

```yaml
agents:
  forti-k2:
    base: claude
    name: Forti K2
    model: forti-k2
    env:
      ANTHROPIC_AUTH_TOKEN: sk-xxx
      ANTHROPIC_BASE_URL: http://my-server:7001/
      ANTHROPIC_SMALL_FAST_MODEL: forti-k2
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "true"
      DISABLE_TELEMETRY: "true"
```

### Example: Model Override Profile

```yaml
agents:
  claude-opus:
    base: claude
    name: Claude Opus
    model: claude-opus-4-6
  claude-sonnet:
    base: claude
    name: Claude Sonnet
    model: claude-sonnet-4-6
```

### How Profiles Work

1. A profile inherits all capabilities from its base agent (binary path, session support, resume flags)
2. Environment variables from `env` are exported before launching the CLI
3. The `model` field is passed as `--model <value>` flag (claude-code) or via env
4. Profiles appear in agent selection dropdowns alongside base agents

### Linking a Profile to an Agent

In the agent configuration, set the `profile` field to link a profile:

```yaml
agents:
  claude:
    profile: forti-k2    # Claude will use forti-k2's env/model when launched
```

This applies the profile's environment variables and model override whenever that agent is launched in a terminal.

## API Providers

Configure API keys for direct API access (used by API-backend smiths):

```yaml
providers:
  anthropic:
    apiKey: sk-ant-...    # encrypted on save
    defaultModel: claude-sonnet-4-6
    enabled: true
  google:
    apiKey: AIza...
    defaultModel: gemini-2.0-flash
    enabled: true
  openai:
    apiKey: sk-...
    enabled: false
```

Provider API keys are encrypted with AES-256-GCM. The UI shows masked values (••••••••).

## Admin Password

- Set on first launch (CLI prompt)
- Required for: login, tunnel start, secret changes, Telegram commands
- Reset: `forge --reset-password`

## Encrypted Fields

`telegramBotToken` and `telegramTunnelPassword` are encrypted with AES-256-GCM. Agent/provider `apiKey` fields are also encrypted. The encryption key is stored at `~/.forge/data/.encrypt-key`.

## Settings UI

The Settings modal has these sections:

| Section | What it configures |
|---------|-------------------|
| **Project Roots** | Directories to scan for projects |
| **Document Roots** | Markdown/Obsidian vault paths |
| **Agents** | Detected CLI agents + configuration |
| **Profiles** | Agent profiles with env/model overrides |
| **Providers** | API provider keys and defaults |
| **Telegram** | Bot token, chat ID, notification toggles |
| **Display** | Name, email |
| **Other** | Skip permissions, skills repo URL, notification retention |
