# Forge v0.5.28

Released: 2026-04-09

## Changes since v0.5.27

### Bug Fixes
- fix: restore notification polling for Telegram, add Suspense wrappers

### Performance
- perf: notifications fetch on-demand instead of polling
- perf: remove task completion polling (replaced by hook stop)
- perf: reduce polling frequency and lazy-load non-essential components
- perf: async terminal-cwd to avoid blocking event loop


**Full Changelog**: https://github.com/aiwatching/forge/compare/v0.5.27...v0.5.28
