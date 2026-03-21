# Skills Marketplace

## Overview

Browse, install, and manage Claude Code skills and commands from the Forge Skills registry.

## Types

| | Skills | Commands |
|---|---|---|
| Location | `~/.claude/skills/<name>/` | `~/.claude/commands/<name>.md` |
| Entry file | `SKILL.md` | Single `.md` file |
| Complexity | Multi-file with templates | Simple slash command |

Both register as `/slash-command` in Claude Code.

## Install

1. Go to **Skills** tab in Forge
2. Click **Sync** to fetch latest registry
3. Click **Install** on any skill → choose Global or specific project
4. Use in Claude Code with `/<skill-name>`

## Update

Skills with newer versions show a yellow "update" indicator. Click to update (checks for local modifications first).

## Local Skills

The **Local** tab shows skills/commands installed on your machine (both from marketplace and manually created). You can:
- **Install to...** — Copy a local skill to another project or global
- **Delete** — Remove from project or global
- **Edit** — View and modify installed files

## Registry

Default: `https://raw.githubusercontent.com/aiwatching/forge-skills/main`

Change in Settings → Skills Repo URL.

## Custom Skills

Create your own: put a `.md` file in `<project>/.claude/commands/` or a directory in `<project>/.claude/skills/<name>/`.
