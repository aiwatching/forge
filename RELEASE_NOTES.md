# Forge v0.5.22

Released: 2026-04-03

## Changes since v0.5.21

### Features
- feat: workspace model config, headless mode for non-claude agents
- feat: unified terminal picker, model resolution, VibeCoding agent fix
- feat: smith 'starting' state, terminal picker, boundSessionId preservation
- feat: playwright plugin supports headed mode (show browser window)
- feat: QA preset auto-creates playwright config, test dir, and starts dev server
- feat: Plugin system enhancements — instances, MCP tools, agent integration
- feat: Pipeline supports plugin nodes (mode: plugin)
- feat: Plugin system — types, registry, executor, built-in plugins, API

### Bug Fixes
- fix: reduce verbose agent-to-agent notifications
- fix: plugin config defaults and UI improvements
- fix: settings agent config save, cliType unification, add form improvements
- fix: smith restart race condition and session binding improvements
- fix: terminal-standalone cleanup and correctness fixes
- fix: workspace-standalone and session-monitor correctness/perf fixes
- fix: plugin shell executor hardened against child process crashes
- fix: plugin shell executor uses async exec instead of execSync
- fix: QA preset uses bash commands as primary, MCP tools as optional
- fix: playwright plugin uses mode-prefixed actions to avoid shell multiline issues
- fix: plugin instance config saves schema defaults when user doesn't modify fields
- fix: playwright check_url falls back to config.base_url when params.url empty
- fix: plugin instance form uses proper input types (select/boolean/number)
- fix: plugin system bug fixes from code review
- fix: plugin executor handles empty cwd + builtin dir fallback to source

### Refactoring
- refactor: orchestrator perf + correctness improvements


**Full Changelog**: https://github.com/aiwatching/forge/compare/v0.5.21...v0.5.22
