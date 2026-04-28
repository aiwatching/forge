# Crafts — project-scoped mini-apps

A **Craft** is a tab inside Forge that lives at `<project>/.forge/crafts/<name>/`. It can be hand-written, AI-generated, or shipped as a Forge builtin (open-source samples). Crafts travel with the project — commit them to git so the team sees the same tabs.

## Quick start

In any project, click **+ Craft** next to the project tabs. Type what you want (e.g. "show all our REST endpoints with migration status, allow batch run + AI fix"). Forge spawns a background task that uses the `craft-builder` skill to generate the files. After ~30-60s the new tab appears.

For an existing craft, switch to its tab and click the small **⚙** badge to refine it ("add a sort button" / "this column should be wider").

## Anatomy

```
<project>/.forge/crafts/<name>/
├── craft.yaml      # manifest (name, displayName, icon, conditions)
├── ui.tsx          # React component (default export)
├── server.ts       # optional API routes
├── prompt.md       # original user request + iteration history
├── README.md       # what this craft does
└── data/           # craft's persistent JSON storage
```

## SDK

Imports from `@forge/craft` (UI side):

| Hook | What it does |
|---|---|
| `useProject()` | `{ projectPath, projectName }` |
| `useForgeFetch(path)` | Fetch wrapper, auto-injects `?projectPath=...`, returns `{ data, loading, error, refetch }` |
| `useInject()` | `(text) => Promise` — paste prompt + Enter into the project's bound tmux session |
| `useTask()` | `(prompt) => TaskHandle` — spawn Forge background task, watch its log stream |
| `useStore(file, default)` | `[value, save, { loading, reload }]` — JSON storage in `data/<file>.json` |
| `useOpenAPI(path)` | Load + parse OpenAPI 3 spec from project |
| `useFile(path, { watch? })` | Read project file with optional polling |
| `useShell()` | `(cmd) => Promise<{ stdout, stderr, code }>` — exec in project cwd |
| `useGit()` | Git status / log info |
| `useToast()` | `(msg, kind)` — quick top notification |

Server side (`server.ts`):

```ts
import { defineCraftServer } from '@forge/craft/server';

export default defineCraftServer({
  routes: {
    'GET /items': async ({ forge, query, params }) => {
      const r = forge.exec('git log --oneline -20');
      return { lines: r.stdout.split('\n') };
    },
    'POST /run': async ({ body, forge }) => {
      const t = forge.task({ prompt: body.prompt });
      return { taskId: t.id };
    },
  },
});
```

`forge` injected helpers:
- `forge.project` — `{ path, name }`
- `forge.storage` — `read(file)`, `write(file, data)`, `listFiles()` (scoped to craft data dir)
- `forge.exec(cmd, opts?)` — sync shell exec in project cwd
- `forge.task({ prompt })` — spawn background task
- `forge.inject(text)` — paste into bound tmux session
- `forge.openapi(specPath)` — load + parse OpenAPI JSON
- `forge.log(...)` — structured logging

Routes are mounted at `/api/crafts/<craft-name>/<route>`. The UI calls them via `useForgeFetch`.

## Manifest

```yaml
name: api-dashboard           # kebab-case, dir name
displayName: 📊 API Dashboard  # tab label
description: One-line summary
version: 0.1.0
icon: "📊"
ui:
  tab: ui.tsx                 # default
  showWhen: hasFile("docs/openapi.json")  # optional condition
server:
  entry: server.ts            # default; omit if no server
```

`showWhen` supports `hasFile("path")` (only show tab when file exists) or `always`.

## Builtins

`lib/builtin-crafts/<name>/` is the slot for crafts that ship with Forge by default. Currently empty — every craft is project-local at `<project>/.forge/crafts/<name>/`. Builtins (when present) appear automatically in every project; project-local crafts override builtins by name.

## Architectural model

Forge is the **orchestrator**: discovers crafts, mounts UI tabs + API routes, provides the SDK. The craft is **your project's content** — stored in `<project>/.forge/`, not in Forge core. Generic features (Migration Cockpit will eventually move here) end up as crafts that live in your repo, not in Forge.
