# Forge VSCode Extension

Native VSCode integration for [Forge](https://github.com/aiwatching/forge).

## What it does

- **Sidebar** — workspaces, smiths, active terminals, and background tasks at a glance
- **Native terminals** — attach to or create Forge tmux sessions in VSCode's terminal panel (uses VSCode's own Pseudoterminal API; sessions show up next to your regular terminals)
- **Send selection** — pipe selected code to a running Forge terminal
- **Notifications** — smith bell events surface as VSCode notifications
- **Status bar** — connection indicator + quick command access

## Setup

1. Install Forge CLI: `npm install -g @aion0/forge`
2. Start the server: `forge server start`
3. Install this extension (VSCode → "Install from VSIX..." or marketplace)
4. Cmd/Ctrl+Shift+P → `Forge: Login` → enter your admin password

The token is stored in VSCode's SecretStorage and reused across sessions.

## Settings

| Key | Default | Description |
|-----|---------|-------------|
| `forge.serverUrl` | `http://localhost:8403` | Forge HTTP server |
| `forge.terminalUrl` | `ws://localhost:8404` | Terminal WebSocket |
| `forge.autoStart` | `false` | Spawn `forge server start` on activation if unreachable |
| `forge.notifications.enabled` | `true` | Smith-bell → VSCode notification |
| `forge.refreshInterval` | `5` | Tree refresh interval (seconds) |

## Local install

```bash
cd vscode-extension
npm install
npm run package        # produces forge-vscode.vsix
code --install-extension forge-vscode.vsix
```

## Develop

```bash
cd vscode-extension
npm install
npm run watch          # in one terminal
# In VSCode: F5 to launch Extension Development Host
```
