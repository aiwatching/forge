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

Forge does **not** re-scan Java source. It reads the docs you've already maintained.

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

### Match outcomes

| Match | Meaning |
|---|---|
| `pass` | Same status code + JSON deep-equal (ignoring configured paths) |
| `stub-ok` | Endpoint marked stubbed; new side returned 501 as expected |
| `fail` | Status mismatch or JSON diff |
| `error` | Unreachable or timed out |

Strict comparison is on by default. Top-level arrays are sorted before compare so order alone won't fail.

## Config (`<project>/.forge/migration/config.yaml`)

```yaml
legacy:
  baseUrl: http://localhost:8080
next:
  baseUrl: http://localhost:9090
auth:
  mode: skip            # skip / bearer / basic
  tokenEnv: FORTINAC_TOKEN
ignorePaths:            # JSONPath patterns to skip during diff
  - $.timestamp
  - $.requestId
healthCheck:
  legacyTimeout: 2000
  newTimeout: 2000
  skipUnhealthy: true
clusterMode: simple     # simple / ai
endpointSource:
  type: docs
  primary: docs/migration
  fallback: docs/lead/migration-history.md
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

## AI fix

After a batch run, failure clusters appear in the sidebar grouped by error type (`http-status-mismatch`, `json-diff`, `legacy-unreachable`, …) with sub-counts per controller.

- **AI fix → task** spawns a Forge background task in the project; the task receives a structured prompt naming the failing endpoints + diffs and is told *not* to modify legacy code.
- **AI fix → inject** prompts for a tmux session name and pastes the prompt + Enter into a running Claude Code session. Use this when you have a Claude terminal already open and want it to take over the fix.

## Tips

- The cockpit assumes both base URLs are reachable and serve identical paths. If the new module isn't running yet, every row will show `error` — that's expected.
- Stubbed endpoints intentionally return 501; they're still listed so you can audit URL parity.
- The diff output truncates each side to 4 KB and shows up to 50 jsonpath diffs per endpoint. Run output JSON files contain the full payload.
- Use the **Search** box to scope to one controller, then **Select all visible** + **Run selected** to focus on a single migration unit.
