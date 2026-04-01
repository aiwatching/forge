# Forge v0.5.17

Released: 2026-03-31

## Changes since v0.5.16

### Bug Fixes
- fix: reset session monitor on clearTmuxSession + always restart on ensurePersistentSession
- fix: reset warmup count on startMonitoring and resetState
- fix: warmup 7 polls — poll 7 sets fresh baseline before real detection
- fix: warmup 6 polls (~18s) before first running detection
- fix: poll 3s with 4-poll warmup (12s before first running detection)
- fix: session monitor poll interval 3s → 6s
- fix: read fixedSessionId directly from file instead of dynamic import
- fix: add logging for fixedSession resolution in ensurePersistentSession


**Full Changelog**: https://github.com/aiwatching/forge/compare/v0.5.16...v0.5.17
