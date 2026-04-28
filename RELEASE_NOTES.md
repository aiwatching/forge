# Forge v0.5.50

Released: 2026-04-28

## Changes since v0.5.49

### Features
- feat: API migration cockpit MVP for legacy → new parity testing

### Refactoring
- refactor: remove Migration Cockpit from Forge core (replaced by craft)

### Documentation
- feat: API migration cockpit MVP for legacy → new parity testing

### Other
- ui(crafts): move hide/close buttons into the terminal panel toolbar
- feat(crafts): multi-file support — recursive bundle + nested file links
- fix(crafts): kill stale-registry display after publish + auto-bust on mutations
- fix(crafts): widen manifest editor 640px → 900px
- feat(crafts): in-Forge manifest editor (bump version etc. without leaving the UI)
- feat(crafts): in-place update + reminder badge in dropdown
- refactor(crafts): drop redundant outer + Craft button
- feat(crafts): add Crafts category to global Marketplace panel
- feat(crafts): one-click publish PR via gh CLI
- fix(crafts): publish flow always uses PR, not direct push
- feat(crafts): publish via GitHub auto-fork (no write access required)
- feat(crafts): marketplace + project-type requires + publish flow
- refactor(crafts): drop file-counter sample, collapse craft tabs into dropdown
- fix(crafts): keep craft tabs (incl. terminal panel) mounted across tab switches
- fix(crafts): list sessions scoped to the craft's cwd, not the project root
- fix(crafts): resume sessionId actually applied — closure staleness
- fix(crafts): always show picker on open + hide vs close split
- fix(crafts): picker re-creates tmux session with chosen --resume
- fix(crafts): keep craft tmux sessions alive across tab switches + restarts
- feat(crafts): terminal closed by default + agent/session picker on first open
- feat(crafts): integrated terminal at bottom of every craft tab
- fix(crafts): agent picker reads agents[] from /api/agents response
- fix(tasks): truncate long task prompt in detail view, click to expand
- feat(crafts): name + agent picker + terminal session as default builder mode
- fix(crafts): bundle SDK inline + cache-bust transpile output
- fix(crafts): move system routes out of _ namespace + delete + better builder
- feat(crafts): project-scoped mini-apps with AI builder
- feat(migration): per-endpoint flag for known deviations
- feat(migration): smart prompt + lenient nullable + per-violation ignore
- feat(migration): editable diagnosis prompt before send
- feat(migration): inline request/response inspector for debugging
- feat(migration): default Fix actions to inject into bound terminal
- feat(migration): rich diagnosis context + connectivity banner + fix-task hand-off
- feat(migration): OpenAPI as primary source + shape diff mode
- fix(migration): parser missed 159 per-controller docs and dropped stubbed endpoints


**Full Changelog**: https://github.com/aiwatching/forge/compare/v0.5.49...v0.5.50
