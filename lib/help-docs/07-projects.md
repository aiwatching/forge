# Projects

## Setup

Add project directories in Settings → **Project Roots** (e.g. `~/Projects`). Forge scans subdirectories automatically.

## Features

### Code Tab
- File tree browser
- Syntax-highlighted code viewer
- Git diff view (click changed files)
- Git operations: commit, push, pull
- Commit history

### Skills & Commands Tab
- View installed skills/commands for this project
- Scope indicator: G (global), P (project), G+P (both)
- Edit files, update from marketplace, uninstall

### CLAUDE.md Tab
- View and edit project's CLAUDE.md
- Apply rule templates (built-in or custom)
- Templates auto-injected with dedup markers

### Issues Tab
- Enable GitHub Issue Auto-fix per project
- Configure scan interval and label filters
- Manual trigger: enter issue # and click Fix Issue
- Processed issues history with retry/delete
- Auto-chains: fix → create PR → review

## Favorites

Click ★ next to a project to favorite it. Favorites appear at the top of the sidebar.

## Terminal

Click "Terminal" button in project header to open a Vibe Coding terminal for that project. Uses `claude -c` to continue last session.
