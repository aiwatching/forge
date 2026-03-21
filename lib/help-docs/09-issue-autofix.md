# Issue Auto-fix

## Overview

Automatically scan GitHub Issues, fix code, create PRs, and review — all hands-free.

## Prerequisites

- `gh` CLI installed and authenticated: `gh auth login`
- Project has a GitHub remote

## Setup

1. Go to **Projects → select project → Issues tab**
2. Enable **Issue Auto-fix**
3. Configure:
   - **Scan Interval**: minutes between scans (0 = manual only)
   - **Base Branch**: leave empty for auto-detect (main/master)
   - **Labels Filter**: comma-separated labels (empty = all issues)
4. Click **Scan Now** to test

## Flow

```
Scan → Fetch Issue → Fix Code (new branch) → Push → Create PR → Auto Review → Notify
```

1. **Scan**: `gh issue list` finds open issues matching labels
2. **Fix**: Claude Code analyzes issue and fixes code on `fix/<id>-<description>` branch
3. **PR**: Pushes branch and creates Pull Request
4. **Review**: Automatically triggers `pr-review` pipeline
5. **Notify**: Results sent via Telegram (if configured)

## Manual Trigger

Enter an issue number in "Manual Trigger" section and click "Fix Issue".

## Retry

Failed fixes show a "Retry" button. Click to provide additional context (e.g. "rebase from main first") and re-run.

## Safety

- Checks for uncommitted changes before starting (aborts if dirty)
- Always works on new branches (never modifies main)
- Switches back to original branch after completion
- Existing PRs are updated, not duplicated

## Processed Issues

History shows all processed issues with status (processing/done/failed), PR number, and pipeline ID. Click pipeline ID to view details.
