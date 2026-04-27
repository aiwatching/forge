# Forge IntelliJ Plugin

Native IntelliJ IDEA / JetBrains IDE integration for [Forge](https://github.com/aiwatching/forge).
Mirrors (in progress) the feature set of the VSCode extension.

## Status — v0.1.0 (scaffold)

- [x] Project structure (Gradle Kotlin DSL + IntelliJ Platform Plugin v1.17 + Kotlin 1.9)
- [x] `plugin.xml` — registers tool window, settings page, status bar widget, actions
- [x] Multi-connection support — persisted to `forge.xml` application state
- [x] Auth via PasswordSafe (per-connection token)
- [x] HTTP client (`java.net.http.HttpClient` + Gson)
- [x] Status bar widget — shows connection name + connectivity, click switches
- [x] Settings UI — edit connections, pick active
- [x] Login / Logout / Switch Connection / Open Web UI actions

## Coming next

- [ ] Tool window tabs:
  - [ ] Workspaces — projects, smiths, daemon control, Inbox/Log expansion
  - [ ] Terminals — list active forge tmux sessions, attach
  - [ ] Pipelines — project-bound bindings, recent runs, node detail markdown
  - [ ] Docs — file tree (local file:// or remote forge-docs:// VFS)
- [ ] Smith terminal attach (custom JediTerm session over forge WebSocket)
- [ ] Pipeline node result viewer
- [ ] Workspace bootstrap from current project root
- [ ] Send selection to forge terminal

## Build

```bash
cd intellij-plugin
./gradlew buildPlugin           # produces build/distributions/forge-intellij-0.1.0.zip
./gradlew runIde                # launches a sandbox IntelliJ with the plugin loaded
```

## Install locally

After `buildPlugin`:
1. JetBrains IDE → Settings → Plugins → ⚙ → "Install Plugin from Disk…"
2. Pick `build/distributions/forge-intellij-0.1.0.zip`
3. Restart IDE
4. View → Tool Windows → Forge

Then **Tools → Forge: Login** to authenticate against the active connection.

## Settings

Settings → Tools → Forge:
- Connections table (add / edit / remove)
- Active connection name

Tokens are stored separately in IntelliJ's PasswordSafe — clear via **Tools → Forge: Logout**.
