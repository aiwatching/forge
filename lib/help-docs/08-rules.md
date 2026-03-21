# Rules (CLAUDE.md Templates)

## What Are Rules?

Reusable markdown snippets that get appended to project CLAUDE.md files. They define coding conventions, security rules, workflow guidelines, etc.

## Built-in Templates

| Template | Description |
|----------|-------------|
| TypeScript Rules | Coding conventions (const, types, early returns) |
| Git Workflow | Commit messages, branch naming |
| Obsidian Vault | Vault integration instructions |
| Security Rules | OWASP guidelines, no hardcoded secrets |

## Manage Rules

**Skills tab → Rules sub-tab**:
- View all templates (built-in + custom)
- Create new: click "+ New"
- Edit any template (including built-in)
- Delete custom templates
- Set as "default" — auto-applied to new projects
- Batch apply: select template → check projects → click "Apply"

## Apply to Project

**Project → CLAUDE.md tab**:
- Left sidebar shows CLAUDE.md content + template list
- Click "+ add" to inject a template
- Click "added" to remove
- Templates wrapped in `<!-- forge:template:id -->` markers (prevents duplicate injection)

## Default Templates

Templates marked as "default" are automatically injected into new projects when they first appear in the project list.

## Custom Templates

Stored in `~/.forge/data/claude-templates/`. Each is a `.md` file with YAML frontmatter:

```markdown
---
name: My Rule
description: What this rule does
tags: [category]
builtin: false
isDefault: false
---

## My Custom Rule
Your content here...
```
