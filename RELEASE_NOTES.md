# Forge v0.4.0

Released: 2026-03-21

## 🎯 Major Features

### Skills Marketplace
- Skills vs Commands distinction with proper install paths
- Registry v1/v2 support, version tracking, update detection
- Local skills browser with search, install to any project
- Rating & Score display from registry

### Rules (CLAUDE.md Templates)
- Built-in templates: TypeScript, Git Workflow, Obsidian, Security
- Custom templates with batch apply to multiple projects
- Auto-inject defaults to new projects

### Issue Auto-fix Pipeline
- Built-in `issue-auto-fix` and `pr-review` pipelines
- Pipeline `mode: shell` for raw shell commands
- GitHub Issue Scanner with periodic scan and label filters
- Auto-chain: fix → PR → review → notify
- Retry with additional context

### Project Tabs & Favorites
- Multi-tab project view with lazy mounting (max 5)
- Star favorites, collapsible sidebar sections
- ProjectManager refactored: 1254 → 338 + 1116 lines

### Docs Tabs
- Multi-file document tabs with content caching
- Tab persistence in DB across refresh

### Help Module
- Floating dialog with docs browser + embedded AI terminal
- 10 help docs covering all Forge modules
- Auto-sync to `~/.forge/help/`

### Logs Viewer
- Real-time forge.log viewer with search and color-coding
- Process monitor, auto-rotate at 5MB
- Timestamps on all console output (dev + production)
- Sensitive data auto-sanitized in log files

## 🔧 Improvements

- **Performance**: Git API parallelized (3-5x faster), lazy sub-tab loading, React.memo
- **Multi-instance**: Terminal isolation, dynamic WebSocket port, per-instance process cleanup
- **Data architecture**: Centralized paths (`lib/dirs.ts`), auto-migration, DB for tabs/favorites
- **CLI**: `forge --reset-password`, `forge tcode`, default background mode
- **Telegram**: `/tunnel_start` returns URL+code, auto-delete sensitive messages
- **Security**: Log sanitization, LAN access without session code

## 🐛 Bug Fixes

- Cloudflared download hangs indefinitely (#7)
- macOS ARM64 cloudflared support
- Settings overwritten when toggling favorites
- Duplicate tab keys from React strict mode
- Orphan processes not killed on restart
- Pipeline template variables with hyphens not resolving
- Shell commands breaking on single quotes in outputs
- Terminal state projectPath not persisted
- sessionLabels infinite accumulation

**Full Changelog**: https://github.com/aiwatching/forge/compare/v0.3.0...v0.4.0
