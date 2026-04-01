# Forge v0.5.11

Released: 2026-03-31

## Changes since v0.5.10

### Features
- feat: CLAUDE.md FORGE_DONE hint + session monitor detects it
- feat: heartbeat probe replaces stable timeout for terminal mode
- feat: session monitor checks tmux process before stable timeout
- feat: agent_status watch target UI in agent config
- feat: fix 3 watch/monitor issues

### Bug Fixes
- fix: restore session monitor running detection
- Revert "fix: skip session monitor for primary agent (user-controlled)"
- fix: skip session monitor for primary agent (user-controlled)
- fix: session monitor only detects done, not running
- fix: force saveNow in stopDaemon to persist state reset to disk
- fix: steps display doesn't duplicate when label equals prompt
- fix: FORGE_DONE reads last 500 bytes + stop flag prevents post-shutdown events
- fix: check FORGE_DONE on every file change, not just after 10s stable
- fix: heartbeat probe doesn't include FORGE_DONE keyword literally
- fix: heartbeat probe asks for FORGE_DONE keyword, checks response
- fix: mark done after 3 unanswered heartbeat probes
- fix: heartbeat probe less frequent, max 3 attempts
- fix: daemon writes launch script to avoid tmux send-keys truncation
- fix: add ignore hint to notification messages

### Documentation
- docs: add Forge Workspace integration completion marker

### Other
- revert: restore session monitor + orchestrator to stable version (f0ba45a)
- Revert "fix: skip session monitor for primary agent (user-controlled)"
- revert: restore original steps display format (label: prompt)
- revert: remove heartbeat probe, back to simple result + timeout
- revert: remove tmux process check from stable timeout
- enhance: session monitor with tmux process alive check
- revert: session monitor watches fixed file, not directory scan


**Full Changelog**: https://github.com/aiwatching/forge/compare/v0.5.10...v0.5.11
