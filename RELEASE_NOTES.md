# Forge v0.5.1

Released: 2026-03-28

## Changes since v0.5.0

### Features
- feat: daemon health check + SSE for all message actions
- feat: pending_approval status for watch approve + requiresApproval

### Bug Fixes
- fix: stop old worker before creating new one in enterDaemonListening
- fix: prevent multiple running messages + clean stale running
- fix: requiresApproval set at message arrival, not in message loop
- fix: approved messages not re-converted to pending_approval
- fix: message loop never stops + auto-recreate dead workers
- fix: approve/reject emit SSE events + reject marks as failed
- fix: emit bus_message_status after watch approve sets pending_approval
- fix: pending_approval edge cases
- fix: system messages (_watch, _system, user) bypass causedBy rules

### Documentation
- docs: add workspace section + agent flow diagram to README
- docs: README with Mermaid diagrams for v0.5.0
- docs: update README for v0.5.0 — multi-agent workspace
- docs: update workspace help with watch, logs, forge skills, send protection

### Other
- ui: add requiresApproval toggle in agent config modal
- debug: log watch analyze skip reasons


**Full Changelog**: https://github.com/aiwatching/forge/compare/v0.5.0...v0.5.1
