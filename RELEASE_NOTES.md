# Forge v0.5.26

Released: 2026-04-06

## Changes since v0.5.25

### Features
- feat: add review-mr as builtin pipeline
- feat: all pipeline steps use worktree, no shell mode exception
- feat: pipeline steps auto-use git worktree for isolated execution

### Bug Fixes
- fix: pipeline tasks use same model as normal tasks, no pipelineModel override
- fix: task model selection — treat 'default' as fall-through
- fix: ignore stdin + parse worktree field in pipeline nodes
- fix: spawn claude without shell, resolve path via which
- fix: remove shell: '/bin/zsh' from claude spawn to prevent arg interpretation
- fix: all pipeline steps use worktree, shell gets env vars
- fix: all pipeline steps use worktree, shell gets env vars
- fix: shell/plugin pipeline steps skip worktree, run in project dir
- fix: only auto-worktree for agent/prompt mode, not shell steps
- fix: resolve rebase conflicts and fix anti-loop guard in messaging

### Documentation
- docs: update pipeline help with worktree env vars for shell steps

### Other
- try some fixes 2
- try some fixes
- daemon is exclusive writer of state.json
- skip auth in dev mode
- fix terminal copy/paste and selection
- add noreply and inbox to workspace messaging


**Full Changelog**: https://github.com/aiwatching/forge/compare/v0.5.25...v0.5.26
