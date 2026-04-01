# Forge v0.5.15

Released: 2026-03-31

## Changes since v0.5.14

### Features
- feat: replace Stop button with Done/Failed/Idle for running agents
- feat: Claude Code Stop hook for agent completion detection

### Bug Fixes
- fix: suppress session monitor for 10s after manual state change
- fix: reset session monitor state when task status manually changed
- fix: stop button resets task to idle for terminal agents, not smith down
- fix: session monitor fallback timeout to 60min
- fix: session monitor fallback timeout to 10min
- fix: session monitor done threshold to 5min (hook is primary detection)
- fix: add logging to agent-context.json write for debugging
- fix: hook uses correct Claude Code schema + date-stamped backup
- fix: hook reads agent context from file instead of env vars


**Full Changelog**: https://github.com/aiwatching/forge/compare/v0.5.14...v0.5.15
