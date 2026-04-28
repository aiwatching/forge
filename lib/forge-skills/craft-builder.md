---
name: craft-builder
description: Build a Forge "Craft" — a project-scoped mini-app exposed as a tab in Forge. Use when the user asks Forge to "make a tab/dashboard/tool that does X" inside their project.
---

# Forge Craft Builder

A **Craft** is a project-scoped mini-app that appears as a tab in Forge. It can have:

- A React UI (`ui.tsx`) — renders inside Forge's project view
- An optional API server (`server.ts`) — handlers run on Forge's Node process

Crafts live at `<project>/.forge/crafts/<craft-name>/` and travel with the project (commit them to git so the team sees the same tabs).

## Your job

When invoked, you produce ALL of these files in `<project>/.forge/crafts/<name>/`:

```
craft.yaml      # manifest
ui.tsx          # React component (default export)
server.ts       # optional — only if user needs server-side work
prompt.md       # the original user request + iteration history (you maintain this)
README.md       # 1-paragraph "what it does"
data/           # auto-created when craft writes via useStore
```

After writing files, tell the user the new tab will appear in Forge after refresh (or hot-reload if dev mode).

## Naming

Pick a kebab-case `name` based on what the user asked for. Keep it short. Example: "API endpoint dashboard" → `api-dashboard`.

The `displayName` is the tab label — include an emoji prefix matching the function (📊 for dashboards, 🔍 for explorers, ⚡ for runners, 📝 for editors, 🧪 for testers).

## SDK — UI side (`ui.tsx`)

Import from `@forge/craft`. ONLY these hooks are available:

```tsx
import { useProject, useForgeFetch, useInject, useTask, useStore } from '@forge/craft';

// 1. Project context
const { projectPath, projectName } = useProject();

// 2. Fetch data — auto-appends ?projectPath=...; returns { data, loading, error, refetch }
const { data, loading, error, refetch } = useForgeFetch<MyType>('/api/crafts/<your-name>/items');
// or any Forge core API:
const git = useForgeFetch('/api/git/status');

// 3. Inject text into the project's bound tmux terminal (auto-resolves session)
const inject = useInject();
await inject('Run the test suite');  // sends text + Enter

// 4. Spawn a Forge background task in the project
const runTask = useTask();
const t = await runTask('Refactor the auth module per CLAUDE.md');
const stop = t.watch(entry => console.log(entry), final => console.log('done', final));

// 5. Persistent JSON storage in <project>/.forge/crafts/<name>/data/<file>.json
const [items, setItems, { loading, reload }] = useStore<Item[]>('items.json', []);
await setItems([...items!, newItem]);  // writes to disk
```

Component must `export default` a React component. Use Tailwind classes and Forge CSS variables (`var(--accent)`, `var(--bg-secondary)`, `var(--text-primary)`, `var(--text-secondary)`, `var(--border)`, `var(--bg-primary)`, `var(--bg-tertiary)`) so the tab matches Forge's theme.

The component is rendered inside `<div className="flex-1 flex flex-col min-h-0 overflow-hidden">` — the outermost element should be a fragment or `<div className="flex-1 ...">`.

**Do not** import React directly (it's auto-injected). Do not import any other npm package — only `@forge/craft`.

## SDK — Server side (`server.ts`, optional)

Skip this file entirely if the craft only needs to call existing Forge APIs.

```ts
import { defineCraftServer } from '@forge/craft/server';

export default defineCraftServer({
  routes: {
    'GET /items': async ({ projectPath, query, forge }) => {
      // Run shell in project cwd
      const r = forge.exec('git log --oneline -20', { timeout: 10000 });
      return { lines: r.stdout.split('\n').filter(Boolean) };
    },

    'POST /create': async ({ body, forge }) => {
      forge.storage.write('records.json', body);
      return { ok: true };
    },

    'GET /load-spec': async ({ forge }) => {
      const spec = forge.openapi('docs/openapi.json');
      return { paths: Object.keys(spec?.paths || {}) };
    },

    'POST /fix': async ({ body, forge }) => {
      const t = forge.task({ prompt: body.prompt });
      return { taskId: t.id };
    },

    'POST /run-cmd': async ({ body, forge }) => {
      forge.inject(body.cmd);  // paste into bound terminal
      return { ok: true };
    },
  },
});
```

`forge` injected helper API:
- `forge.project` — `{ path, name }`
- `forge.storage` — `read(file)`, `write(file, data)`, `listFiles()` (scoped to the craft's data dir)
- `forge.exec(cmd, opts?)` — synchronous shell exec in project cwd, returns `{ stdout, stderr, code }`
- `forge.task({ prompt, agent? })` — spawn Forge background task, returns `{ id }`
- `forge.inject(text, opts?)` — paste into bound tmux session
- `forge.openapi(specPath)` — load + parse OpenAPI JSON from project
- `forge.log(...)` — structured logging

Routes are auto-mounted at `/api/crafts/<craft-name>/<route>`. The UI calls them via `useForgeFetch`.

## Manifest (`craft.yaml`)

```yaml
name: api-dashboard           # kebab-case, dir name
displayName: 📊 API Dashboard  # tab label (with emoji)
description: One-line summary of what it does
version: 0.1.0
icon: "📊"                     # optional, mainly cosmetic
ui:
  tab: ui.tsx
  showWhen: hasFile("docs/openapi.json")  # optional condition; omit to always show
server:
  entry: server.ts             # omit this whole block if no server.ts
```

## prompt.md

Always write/update this file with:
- The original user request (verbatim)
- Each refine request and what you changed
- Used by future Refine runs as context

## Iteration

When called to refine an existing craft (the dir already exists), READ existing files first, KEEP what works, change only what the user asked. Append the refine request to `prompt.md`.

## Examples to follow

There's a sample at `lib/builtin-crafts/file-counter/` that demonstrates the minimum viable shape. Read it before writing your own.

## Style guide

- Tailwind classes only. Use Forge's color variables, not hardcoded colors.
- Text sizes: `text-xs` (default), `text-[11px]` for dense tables, `text-[10px]` for metadata.
- Buttons: `text-[10px] px-2 py-1 rounded bg-[var(--accent)]/20 text-[var(--accent)] hover:bg-[var(--accent)]/30`.
- Sections inside the tab: `flex-1 flex flex-col min-h-0 overflow-auto p-4 gap-3`.
- For tables/lists, prefer simple `<table>` or `<div>` grids — no extra deps.
- Match Forge's compact density (rows ~24-28px tall).

## Final report

After writing files, report:
1. What craft you created (name + displayName)
2. The route(s) registered (if any server)
3. The data files used (if any)
4. Any assumptions you made

End with `[FORGE_DONE]`.
