# API Migration Cockpit

Parity-test API endpoints between a legacy module and a new module during a large migration. Designed for projects where the same paths must be served identically by two different processes (e.g. legacy on `:8080`, new web-server on `:9090`).

## When to use

- You're moving REST endpoints from one Spring/Java module to another and the new module **must keep the exact same paths** (no rewrites allowed in the legacy code).
- You have lots of endpoints (hundreds) and need batch testing + AI-assisted fix.
- You already track migration status in markdown — Forge reads your docs instead of re-scanning the source.

## Quick start

1. Open the project, click the **🚚 Migration** tab.
2. Click **Config** and set:
   - `Legacy base URL` (e.g. `http://localhost:8080`)
   - `New base URL` (e.g. `http://localhost:9090`)
   - `Per-controller docs dir` (default `docs/migration`)
   - `History fallback` (default `docs/lead/migration-history.md`)
3. Click **Discover from docs** — Forge parses your existing migration docs.
4. Click **Run all** to fire each endpoint at both base URLs in parallel and compare JSON.
5. Failures show up in the right sidebar, clustered by error type.
6. Select rows or a cluster → **AI fix → task** (background) or **AI fix → inject** (paste prompt into a tmux session).

## Discovery

Two strategies, controlled by `endpointSource.openApiSpec` in config:

### Strategy A — OpenAPI as primary source (recommended)

When `openApiSpec` points at an OpenAPI 3 JSON (e.g. `docs/fnac-rest-schema-7.6.json`), Forge:

1. Loads every operation in the spec — this is the full surface, including endpoints not yet covered by your migration docs.
2. Annotates each endpoint with status (`migrated` / `stubbed` / `pending`) by cross-referencing your `docs/migration/<X>.java.md` per-controller files (matched by exact `METHOD path`) and `docs/lead/migration-history.md` (matched by controller/tag name).
3. Resolves `$ref` chains so each operation has an inline response schema you can validate against.

Endpoints not covered by any doc are flagged `pending` so you can see what's not yet planned.

### Strategy B — Doc-only discovery (fallback)

If no `openApiSpec` is configured, Forge falls back to parsing `docs/migration/*.md` tables (Migrated / Stubbed sections) plus `migration-history.md` inline `METHOD /path` mentions.

### Primary parser — `docs/migration/<File>.java.md`

Looks for sections marked **Migrated** / **Stubbed** / **URL Parity Only** with markdown tables containing `` `METHOD` `path` `` cells:

```
### ✅ Migrated (11 endpoints — DB-backed)

| HTTP path | Method | Service method | Notes |
|---|---|---|---|
| `GET /control/{id}` | `getById` | `getById(id)` | Single task by PK |

### 🚫 Stubbed (12 endpoints — return 501 Not Implemented)

| HTTP path | Method | Runtime dependency |
|---|---|---|
| `POST /control/macaddress` | `controlByMacForm` | … |
```

Stubbed endpoints get `expectedHttpStatus: 501` so they pass when the new side correctly returns 501.

### Fallback parser — `docs/lead/migration-history.md`

For controllers without a per-file doc, Forge scans entries shaped like:

```
- [x] `MFAController.java` — **migrated 2026-04-23** (… `GET /mfa/foo` …)
- [x] `Foo.java` — **skip 2026-04-23**: out of scope
```

`skip` and `defer` entries are excluded. Inline `` `METHOD /path` `` mentions in the description become endpoints; otherwise a placeholder row is added with a note.

## Running

| Action | Behavior |
|---|---|
| **Run** (per row) | Fires both sides once, expands diff inline |
| **Run selected** | Batch-run checked rows (SSE progress) |
| **Run all** | Batch-run every endpoint |

The runner fires `legacy` and `new` in parallel for each endpoint, with concurrency=4 across endpoints. Path placeholders like `{id}` are filled from `pathSubstitutions` in config.

### Diff modes (`config.diffMode`)

| Mode | Hits legacy? | Comparison |
|---|---|---|
| `shape` (default) | no | Validates new response against the OpenAPI schema (subset semantics — extra fields OK, missing required fail, wrong types fail, enum violations fail). Use this when legacy is unreachable. |
| `exact` | yes | Original behavior — fires both sides in parallel, deep-equal JSON comparison with array sort + ignore-paths. |
| `both` | yes | Both deep-equal AND schema validation. |

### Match outcomes

| Match | Meaning |
|---|---|
| `pass` | Comparison succeeded for the configured mode |
| `stub-ok` | Endpoint marked stubbed; new side returned 501 as expected |
| `fail` | Schema violation, status mismatch, or JSON diff |
| `error` | Unreachable or timed out |
| `flagged` | Endpoint has a user-set annotation (deviated/accepted/wontfix/flaky); failures are re-classified out of the failure list |

### Flagging known deviations

When the new module intentionally diverges from the OpenAPI spec (e.g. you removed a deprecated field as part of the migration), don't keep seeing it as "fail". Click the 🏷 button on the row to attach an annotation:

| Flag | Use it when |
|---|---|
| `🏷 deviated` | The migration intentionally changed the response shape; spec is being updated separately |
| `✅ accepted` | The current new-side behavior is the new contract; spec is just stale |
| `⛔ wontfix` | Known broken, deferred to later milestone |
| `〰 flaky` | Passes intermittently — track separately |

The popover lets you also pin **per-endpoint ignored paths** (suggested directly from the current run's diff). Annotations are stored in `<project>/.forge/migration/annotations.json` and applied on every subsequent run for that endpoint:

- The endpoint-level ignorePaths are merged into the global ignorePaths for that endpoint only.
- If after that any violations remain, the result is shown as `flagged` (yellow), not `fail` (red), and is excluded from failure clusters.
- Diagnose / Fix prompts include the annotation note so the AI knows the deviation is intentional and doesn't try to "fix" it.

Top-level arrays are sorted before exact comparison so order alone won't fail. Schema mode samples the first 10 array items to keep reports tractable.

## Config (`<project>/.forge/migration/config.yaml`)

```yaml
legacy:
  baseUrl: http://localhost:8080
next:
  baseUrl: http://localhost:9090
auth:
  mode: skip            # skip / bearer / basic
  tokenEnv: FORTINAC_TOKEN
diffMode: shape         # shape / exact / both
ignorePaths:            # JSONPath patterns to skip during diff/validation
  - $.timestamp
  - $.requestId
healthCheck:
  legacyTimeout: 2000
  newTimeout: 2000
  skipUnhealthy: true
clusterMode: simple     # simple / ai
endpointSource:
  type: mixed
  openApiSpec: docs/fnac-rest-schema-7.6.json   # primary source when set
  primary: docs/migration                        # used to annotate status
  fallback: docs/lead/migration-history.md       # used to annotate status
pathSubstitutions:
  id: "1"
  ip: "127.0.0.1"
  mac: "00:00:00:00:00:00"
```

## Storage

```
<project>/.forge/migration/
├── config.yaml
├── endpoints.json            # discovered endpoints
├── runs/<timestamp>.json     # one file per batch run
└── failures/current.json     # latest failures (used by clustering)
```

## Diagnose & fix

When a row fails, four buttons appear next to it:

| Button | Action |
|---|---|
| `Run` | Re-run just this endpoint |
| `🔍` | Open the **Diagnose drawer** — full markdown with request URL, actual response, expected schema, schema violations, OpenAPI metadata, and the migration doc snippet |
| `🤖 Fix` | Inject the diagnosis markdown into the **bound terminal** (the live tmux session whose pane cwd is at/under this project). Falls back to spawning a background task if no terminal matches. |
| `📋` | Copy a reproduction `curl` to clipboard |

After a batch run, failure clusters appear in the sidebar grouped by error type with sub-counts per controller. From a cluster you can `Fix cluster → task` to send the entire cluster as one diagnosis prompt.

### Connectivity banner

If more than 50% of runs fail with the same connectivity error type (`new-unreachable`, `legacy-unreachable`, …), a banner appears at the top with the actual error message (e.g. `ECONNREFUSED 127.0.0.1:9090`) and one-click access to Config. This catches the common case of "the new server isn't running" before you start hunting individual failures.

### Architectural note

Forge is the **tool / orchestrator**: it discovers endpoints from your OpenAPI spec, runs HTTP parity tests, surfaces failures, and packages diagnosis context. Forge intentionally does NOT hard-code source-file paths or migration conventions — those belong to your project's `CLAUDE.md` and migration playbook. The Diagnose / Fix tasks spawn inside the project's working directory so the project's own conventions drive the fix.

### Bound terminal

The toolbar shows `→ <session-name> ●` when Forge has detected an active tmux session whose pane is in this project's directory (●  = currently attached). All `🤖 Fix` actions default to **injecting into that session** rather than creating a task — your already-running Claude takes over the fix in-place. If multiple sessions match, pick one from the dropdown. If none match (no terminal open in the project), the fix falls back to a background task.

Use the small **→ task** button next to any fix action to force a fresh background task instead.

## Tips

- The cockpit assumes both base URLs are reachable and serve identical paths. If the new module isn't running yet, every row will show `error` — that's expected.
- Stubbed endpoints intentionally return 501; they're still listed so you can audit URL parity.
- The diff output truncates each side to 4 KB and shows up to 50 jsonpath diffs per endpoint. Run output JSON files contain the full payload.
- Use the **Search** box to scope to one controller, then **Select all visible** + **Run selected** to focus on a single migration unit.
