# Workspace (Forge Smiths)

## Overview

Workspace is a multi-agent orchestration system. You define a team of **Smiths** (agents) that coordinate via DAG dependencies, a message bus, and request/response documents. Smiths run as long-lived daemons or can be manually driven from a terminal.

## Core Concepts

| Term | Description |
|------|-------------|
| **Smith** | A long-running agent in the workspace (Claude Code, Codex, etc.) |
| **Primary Smith** | The coordinator smith — runs at project root, typically Lead |
| **Input Node** | User-provided requirements node (append-only history) |
| **DAG** | Directed acyclic graph of agent dependencies (no cycles allowed) |
| **Request Document** | YAML doc describing a task, flows through status stages |
| **Topology Cache** | Live in-memory map of all smiths, auto-injected into every task |
| **Message Bus** | Inter-agent messaging (notifications + direct messages) |
| **Daemon** | Background loop that keeps smiths alive and consumes messages |

## Two-Layer State Model

Each smith has two independent status layers displayed on the node:

| Layer | Values | Description |
|-------|--------|-------------|
| **Smith Status** | `down` / `starting` / `active` | Daemon lifecycle |
| **Task Status** | `idle` / `running` / `done` / `failed` | Current work status |

- **Smith Status** is controlled by daemon start/stop
- **Task Status** tracks individual work execution
- Session-monitor auto-marks `done` after 20 min of file stability (fallback if Stop hook misses)

## Creating Smiths

### Add Agent Modal

Click **+ Add Agent** in workspace header to open config modal. Fields:

| Field | Description |
|-------|-------------|
| **Template** | Quick-select preset (Lead ★, PM, Engineer, QA, Reviewer, UI Designer, Design Evaluator) |
| **Saved Templates** | User-saved smith configs (if any) |
| **Icon + Label** | Display on node (emoji icon + agent name) |
| **Backend** | `cli` (subscription, Claude Code/Codex/Aider) or `api` (API key) |
| **Agent / Profile** | Which CLI or API profile to use (from Settings) |
| **Role / System Prompt** | Core instructions, synced to `CLAUDE.md` in workDir |
| **Plugin Instances** | MCP plugins the agent can use (playwright, shell-command, llm-vision) |
| **Depends On** | Upstream agents this one depends on (creates DAG edges) |
| **Work Dir** | Relative path within project where agent runs |
| **Outputs** | Expected output paths (informational, no longer enforces uniqueness) |
| **Primary** | Only one per workspace — runs at root, gets fixed session, persistent |
| **Requires Approval** | User must approve each inbox message before processing |
| **Terminal Mode** | Keep a tmux+CLI session alive (persistent session) |
| **Skip Permissions** | Auto-approve tool calls (`--dangerously-skip-permissions`) |
| **Model** | Override model (claude-sonnet-4-6, claude-opus-4-6, etc.) |
| **Steps** | Ordered task steps (Label: Prompt) |
| **Watch** | Autonomous file/git/command monitoring |

### Preset Templates

| Preset | Icon | Role | Notes |
|--------|------|------|-------|
| **Lead** ★ | 👑 | Primary coordinator — SOP-driven intake, delegation, gap coverage | **Recommended for Primary smith** |
| **PM** | 📋 | Product Manager — versioned PRDs, testable acceptance_criteria | Writes to `docs/prd/` |
| **Architect** | 🏗️ | Breaks requirements into request documents | Uses `create_request` |
| **Engineer** | 🔨 | Claims requests, implements code | Uses `claim_request` + `update_response` |
| **QA** | 🧪 | Writes Playwright tests, verifies acceptance_criteria | Uses `update_response(section: qa)` |
| **Reviewer** | 🔍 | Reviews code quality, security, performance | Uses `update_response(section: review)` |
| **UI Designer** | 🎨 | Writes UI code, iterates via screenshots | Needs playwright plugin |
| **Design Evaluator** | 🔍 | Scores UI implementations visually | Needs playwright + llm-vision |

Primary presets (Lead) have orange ★ badge and are recommended when designing workspaces with a coordinator.

## Smith Templates (Save/Load)

### Save a Smith as Template

On any configured smith node, click **💾** button:
- Enter template name + optional description
- Stored at `~/.forge/data/smith-templates/<id>.json`
- Appears in "Saved Templates" section when adding new agents

### Export / Import

- **📤 Export** (in Edit Agent modal): download current config as JSON file
- **📂 Import from file**: load a JSON template when creating a new agent
- Share template files across machines/workspaces

API endpoints:
- `GET /api/smith-templates` — list all
- `POST /api/smith-templates` — save (body: `{name, icon, description, config}`)
- `POST /api/smith-templates` with `{action: "delete", id}` — remove

## Dependencies (DAG)

Dependencies must form a **directed acyclic graph**. Circular deps rejected at add/edit time.

```
Input → PM → Engineer → QA → Reviewer
          ↘________________↗
             (both notify Reviewer)
```

- Upstream completes first, broadcasts to downstream
- Each agent declares `dependsOn` (upstream agent IDs)

## Request/Response Document System

Structured YAML documents for multi-agent delivery workflows.

### Storage Layout

```
<project>/.forge/requests/
├── REQ-20260403-001/
│   ├── request.yml    # Architect/Lead creates
│   └── response.yml   # Engineer/Reviewer/QA update
└── REQ-20260403-002/
    ├── request.yml
    └── response.yml
```

### Status Lifecycle

```
open → in_progress → review → qa → done
```

- **open**: request created, no one claimed yet
- **in_progress**: Engineer claimed and is implementing
- **review**: Engineer done, Reviewer should review
- **qa**: Reviewer approved, QA should test
- **done**: QA passed

### Request YAML Schema

```yaml
id: "REQ-20260403-001"
batch: "delivery-20260403"
title: "User authentication"
description: "Detailed description..."
modules:
  - name: "auth-service"
    description: "JWT token generation"
    acceptance_criteria:
      - "Login returns access token"
      - "Expired tokens return 401"
priority: "high"  # high | medium | low
status: "open"
assigned_to: ""
created_by: "Architect"
created_at: "2026-04-03T10:00:00Z"
updated_at: "2026-04-03T10:00:00Z"
```

### Response YAML Schema

```yaml
request_id: "REQ-20260403-001"
status: "done"
engineer:
  completed_at: "2026-04-03T11:30:00Z"
  files_changed: ["src/auth/service.ts"]
  notes: "Implemented with jose library"
review:
  completed_at: "2026-04-03T12:00:00Z"
  result: "approved"  # approved | changes_requested | rejected
  findings: []
qa:
  completed_at: "2026-04-03T12:30:00Z"
  result: "passed"  # passed | failed
  test_files: ["tests/e2e/auth.spec.ts"]
  findings: []
```

### Auto-Notification via DAG

When `create_request` or `update_response` is called, the orchestrator automatically sends notifications to all downstream agents (based on `dependsOn`). Agents don't manually send messages — they operate on the document and downstream smiths are notified.

## MCP Tools (for Smiths)

Agents use these MCP tools (via forge-mcp-server):

### Topology & Status

| Tool | Description |
|------|-------------|
| `get_agents` | Live workspace topology — all agents, roles, DAG flow, status, missing standard roles |
| `get_status` | Live status snapshot of all agents (smith+task status) |
| `get_inbox` | Pending/failed inbox messages for current agent |

### Request Documents

| Tool | Description |
|------|-------------|
| `create_request` | Create a new request document (auto-notifies downstream) |
| `claim_request` | Atomically claim an open request (prevents duplicate work) |
| `list_requests` | List requests, filter by `batch` or `status` |
| `get_request` | Read full request + response content |
| `update_response` | Update response section (engineer/review/qa), auto-advances status |

### Communication

| Tool | Description |
|------|-------------|
| `send_message` | Send a direct message to another agent |
| `mark_message_done` | Mark a processed message as done |
| `check_outbox` | Check delivery status of sent messages |

### Request vs Inbox — When to use which

Every preset smith's role prompt includes a decision rule for this:

**Use `create_request`** when:
- Delegating substantive work (implement feature, write tests, do review)
- Work has concrete deliverables and acceptance criteria
- Work should flow through a pipeline (engineer → qa → reviewer)
- The task needs to be tracked, claimed, and its status visible

**Use `send_message`** when:
- Asking a clarifying question
- Quick status update or coordination
- Reporting a bug back after review fails
- No concrete deliverable

**When unsure, prefer `create_request`** — a tracked artifact beats losing context in chat.

### Other

| Tool | Description |
|------|-------------|
| `run_plugin` | Execute a plugin action (e.g., Playwright test/screenshot) |
| `sync_progress` | Report work progress to workspace |
| `trigger_pipeline` | Trigger a pipeline from a smith |
| `get_pipeline_status` | Check pipeline run status |

## Topology Cache (Auto-Injected Context)

Every task execution automatically includes a **Workspace Team** section in the agent's context:

```
## Workspace Team
Flow: Lead → Engineer → QA → Reviewer
Missing: architect, pm
- 👑 Lead ← you [active/running]: Lead Coordinator — Primary agent...
- 🔨 Engineer [active/idle]: Senior Software Engineer — You design...
- 🧪 QA [active/idle]: QA Engineer — You ensure quality...
- 🔍 Reviewer [active/idle]: Senior Code Reviewer — You review...
```

- **Rebuilt on every agent change** (add/remove/update/status change)
- **Auto-injected** via `buildUpstreamContext` — agents don't need to call `get_agents` at start
- **Missing roles hint** — shows which standard roles are absent (so Lead knows to cover gaps)
- Agents can still call `get_agents` for detailed mid-task status

## Lead / Primary Smith

The **Lead** preset is designed as a Primary coordinator:

- Runs at project root (`workDir: ./`)
- `persistentSession: true` — always has a terminal
- `primary: true` — fixed session ID, gets ★ badge on node
- Orange border + ★ in preset picker (recommended for primary role)

### Lead SOP

1. **Intake**: Read Workspace Team, classify requirement, route by team composition
2. **Delegate**: `create_request` for each module with testable `acceptance_criteria`
3. **Cover Gaps**: If a role is missing (no Engineer/QA/Reviewer), handle it yourself
4. **Monitor**: `get_status` + `list_requests` to unblock stuck agents
5. **Quality Gate**: Verify all requests done/approved/passed before declaring complete

### Gap Coverage

| Missing Role | Lead Does |
|--------------|-----------|
| PM/Architect | Break requirements into modules with acceptance_criteria |
| Engineer | Implement code, update_response(section: engineer) |
| QA | Write/run tests, update_response(section: qa) |
| Reviewer | Review code for quality/security, update_response(section: review) |

## Message Bus

Two message categories:

| Category | Direction | Use Case |
|----------|-----------|----------|
| **Notification** | DAG-based (upstream → downstream) | "I'm done, here's what I did" |
| **Direct Message** | Any direction | Questions, bug reports, coordination |

### Notification Flow

- When agent completes, system broadcasts `task_complete` to all downstream agents
- Downstream uses `causedBy` field to trace which inbox message triggered their run
- Messages from downstream → discarded (prevents reverse loops)

### Inbox Management

Each smith has an inbox panel with:
- **Inbox tab**: incoming messages with status (pending/running/done/failed)
- **Outbox tab**: sent messages with delivery status
- **Batch operations**: select all completed → bulk delete, or abort all pending

## Plugins (MCP Plugin System)

Smiths can use MCP plugins for extended capabilities.

### Built-in Plugin Types

| Plugin | Description |
|--------|-------------|
| `playwright` | Browser automation — test, screenshot, navigate |
| `shell-command` | Execute custom shell commands |
| `llm-vision` | Send screenshots to LLM for visual evaluation |

### Using Plugins in a Smith

1. In Settings → Plugins, install plugin definitions
2. Create plugin instances (configure endpoints, credentials)
3. In Add Agent modal, select which instances this smith can access
4. Smith calls `run_plugin(plugin: "<instance-id>", action: "<action>", params: {...})`

### Recommended Plugins per Preset

- **QA**: `playwright` (e2e testing)
- **UI Designer**: `playwright` + `shell-command` (screenshots)
- **Design Evaluator**: `playwright` + `llm-vision` (visual scoring)
- **Lead**: `playwright` + `shell-command` (fallback for any role)

## Terminal Mode (Manual)

Click **⌨️** on any smith to open a terminal session:

- tmux session opens with CLI + env vars (`FORGE_AGENT_ID`, `FORGE_WORKSPACE_ID`, `FORGE_PORT`)
- Forge Skills available: `/forge-send`, `/forge-inbox`, `/forge-status`, `/forge-workspace-sync`
- Session Picker: choose new session, continue existing, or browse all Claude sessions
- Close terminal → smith returns to auto mode, pending messages resume
- **Auto-reconnect**: If the WebSocket drops (e.g. system suspend, network blip), the terminal automatically reconnects after 2s and re-attaches to the same tmux session — conversation context preserved
- **Mouse ON/OFF toggle** (🖱️ button in header): Toggle tmux mouse mode globally for all sessions
  - **ON**: trackpad scroll, `Shift+drag` to select text
  - **OFF**: drag to select text directly, `Ctrl+B [` to enter scroll mode
  - Click to apply instantly (no restart needed)

### Terminal Layout: Float vs Dock

The workspace toolbar has a layout switcher: `⧉ Float` or `▤ Dock`.

| Layout | Behavior |
|---|---|
| **Float** (default) | Each terminal is a draggable/resizable floating window positioned near its smith node |
| **Dock** | All open terminals arranged in a fixed grid at the bottom of the workspace |

Dock mode features:
- Grid columns selector (1/2/3/4) — auto-expands based on open terminal count
- 1 terminal with 4 columns → fills full width
- 2 → half-half, 3 → thirds, 4 → quarters, 5+ → wraps to second row
- Drag the top border to resize dock height
- Layout preference persisted to localStorage

### Smith Node Positions

Drag smith nodes to reorganize the graph. Positions are **persisted to workspace state** and restored on reload. Auto-save debounces writes (500ms after drag stops).

## Watch (Autonomous Monitoring)

Agents can monitor file/git/command changes without message-driven triggers.

### Configuration

| Field | Description |
|-------|-------------|
| **Interval** | Check frequency in seconds (min 10, default 60) |
| **Debounce** | Minimum seconds between alerts (default 10) |
| **Targets** | What to watch (multiple allowed) |
| **On Change** | Action: `log`, `analyze`, `approve`, or `send_message` |

### Target Types

| Type | Description |
|------|-------------|
| `Directory` | File mtime changes in a project folder |
| `Git` | New commits via HEAD hash comparison |
| `Agent Output` | Another agent's declared output paths |
| `Agent Log` | Another agent's log file with optional keyword filter |
| `Session Output` | Claude session tail output |
| `Command` | Run a shell command, detect output changes |
| `Agent Status` | Another agent's smithStatus/taskStatus changes |

### Watch Actions

| Action | Behavior |
|--------|----------|
| `Log` | Write alert to agent log (no token cost) |
| `Analyze` | Auto-wake agent to analyze changes (costs tokens) |
| `Approve` | Create pending approval, user decides |
| `Send Message` | Send alert to specified agent |

## Mascot Animations (Visual Flair)

Each smith can display an animated companion character next to its node.

**Themes**: Stick figure, Cat, Pixel (8-bit RPG hero), Emoji, Off (default)

- Theme picker in workspace header
- Animates based on smith state (idle/running/done/failed/sleeping)
- Persists to localStorage (`forge.mascotTheme`)
- Done state plays celebration 2x then settles quietly

## Controls

| Action | Description |
|--------|-------------|
| **Start Daemon** | Launch all smiths, begin consuming messages |
| **Stop Daemon** | Stop all smiths, kill workers. Preserves user's terminal conversation context (no `/clear` is sent). Tmux sessions attached to by a user are kept alive. |
| **Run All** | Trigger all runnable agents once |
| **Run** | Trigger specific agent |
| **Pause/Resume** | Pause/resume message consumption for one agent |
| **Mark Done/Failed/Idle** | Manually set task status |
| **Retry** | Re-run a failed agent from checkpoint |
| **Open Terminal** | Enter manual mode with tmux session |
| **Remove** | Delete agent (cascades — cleans dangling dependsOn) |

## Workspace API

### HTTP Endpoints

```bash
# List workspaces
curl http://localhost:8403/api/workspace

# Find by project path
curl "http://localhost:8403/api/workspace?projectPath=/path/to/project"

# Export workspace as template
curl "http://localhost:8403/api/workspace?export=<workspaceId>"

# Import template
curl -X POST http://localhost:8403/api/workspace \
  -H 'Content-Type: application/json' \
  -d '{"projectPath":"...","projectName":"...","template":{...}}'

# Delete workspace
curl -X DELETE "http://localhost:8403/api/workspace?id=<workspaceId>"
```

### Agent Operations

```bash
POST /api/workspace/<id>/agents
{
  "action": "add",           # create agent
  "config": {...}
}
{
  "action": "update",        # update agent
  "agentId": "...",
  "config": {...}
}
{
  "action": "remove",        # remove agent
  "agentId": "..."
}
{
  "action": "start_daemon"   # start all smiths
}
{
  "action": "stop_daemon"    # stop all smiths
}
{
  "action": "run",           # trigger one agent
  "agentId": "..."
}
{
  "action": "mark_done",     # manual status
  "agentId": "...",
  "notify": true             # also send downstream notifications
}
```

### Streaming Events (SSE)

```bash
curl http://localhost:8403/api/workspace/<id>/stream
```

Events: `agents_changed`, `task_status`, `smith_status`, `log`, `bus_message`, `workspace_complete`, `watch_alert`.

## Timeouts & Session Monitor

A background session monitor polls each agent's Claude session file:

| Threshold | Behavior |
|-----------|----------|
| **File change** | → `running` (mtime/size changed) |
| **19 min stable** | Check for `result` entry in session file → mark `done` if found |
| **20 min stable** | Force `done` (fallback if Stop hook missed) |

The Stop hook (installed in `~/.claude/settings.json`) triggers `done` immediately when Claude Code finishes a turn.

## Persistence

- **Workspace state**: `~/.forge/workspaces/<id>/state.json` (atomic writes, auto-save every 10s)
- **Agent logs**: `~/.forge/workspaces/<id>/agents/<agentId>/logs.jsonl` (append-only)
- **Smith templates**: `~/.forge/data/smith-templates/*.json`
- **Request documents**: `<project>/.forge/requests/REQ-*/` (request.yml + response.yml)
- **Agent context**: `<project>/<workDir>/.forge/agent-context.json` (read by Stop hook)

## Complete WorkspaceAgentConfig Schema

Use this exact JSON structure when calling `POST /api/workspace/<id>/agents` with `action: "add"` or `action: "update"`.

```json
{
  "id": "engineer-1775268642253",
  "label": "Engineer",
  "icon": "🔨",
  "type": "agent",
  "primary": false,
  "backend": "cli",
  "agentId": "claude",
  "provider": null,
  "model": null,
  "dependsOn": ["input-1775268600000", "pm-1775268620946"],
  "workDir": "./src",
  "outputs": ["src/", "docs/architecture/"],
  "steps": [
    { "id": "claim", "label": "Find & Claim", "prompt": "Read Workspace Team..." },
    { "id": "design", "label": "Design", "prompt": "get_request for details..." },
    { "id": "implement", "label": "Implement", "prompt": "Implement per design..." },
    { "id": "report", "label": "Report Done", "prompt": "update_response..." }
  ],
  "role": "Senior Software Engineer. Context auto-includes Workspace Team...",
  "persistentSession": true,
  "skipPermissions": true,
  "requiresApproval": false,
  "plugins": ["playwright-main"],
  "watch": {
    "enabled": false,
    "interval": 60,
    "targets": [],
    "action": "log",
    "prompt": "",
    "sendTo": ""
  }
}
```

### Field Reference

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `id` | string | yes (for update/remove) | auto | Format: `{label-lower}-{timestamp}` |
| `label` | string | yes | — | Display name, must be unique in workspace |
| `icon` | string | yes | `🤖` | Emoji icon |
| `type` | string | yes | `agent` | `agent` or `input` |
| `primary` | boolean | no | false | Only one per workspace, workDir forced to `./` |
| `backend` | string | yes | `cli` | `cli` (subscription) or `api` (api key) |
| `agentId` | string | cli only | `claude` | Agent ID from Settings → Agents (e.g. `claude`, `codex`, `aider`) |
| `provider` | string | api only | — | e.g. `anthropic` |
| `model` | string | no | — | Model override (e.g. `claude-sonnet-4-6`) |
| `dependsOn` | string[] | yes | `[]` | Upstream agent IDs (DAG edges) |
| `workDir` | string | yes | `./` | Relative path from project root, must be unique |
| `outputs` | string[] | yes | `[]` | Expected output paths (informational) |
| `steps` | object[] | yes | `[]` | `{id, label, prompt}[]` |
| `role` | string | yes | — | System prompt, synced to `CLAUDE.md` in workDir |
| `persistentSession` | boolean | no | false | Keep tmux+CLI alive (required for primary) |
| `skipPermissions` | boolean | no | true | `--dangerously-skip-permissions` for Claude Code |
| `requiresApproval` | boolean | no | false | User approves each inbox message |
| `plugins` | string[] | no | — | Plugin instance IDs |
| `watch` | object | no | — | Watch config (see Watch section) |

### Watch Config Schema

```json
{
  "enabled": true,
  "interval": 60,
  "targets": [
    { "type": "directory", "path": "src/", "debounce": 10 },
    { "type": "git", "debounce": 10 },
    { "type": "agent_status", "path": "engineer-1234", "pattern": "done" },
    { "type": "command", "cmd": "npm test", "debounce": 10 },
    { "type": "agent_log", "path": "qa-5678", "pattern": "error" },
    { "type": "agent_output", "path": "pm-9012" },
    { "type": "session", "path": "engineer-1234" }
  ],
  "action": "log",
  "prompt": "Analyze and report",
  "sendTo": "engineer-1234"
}
```

- `action` values: `log` | `analyze` | `approve` | `send_message`
- `sendTo` is required only when `action: "send_message"`

## Complete Recipes

### Authentication (Required for API Calls)

```bash
# Ask user for admin password, then:
TOKEN=$(curl -s -X POST http://localhost:8403/api/auth/verify \
  -H "Content-Type: application/json" \
  -d '{"password":"USER_PASSWORD"}' | python3 -c "import sys,json; print(json.load(sys.stdin).get('token',''))")

# Use token in all subsequent requests:
# curl -H "X-Forge-Token: $TOKEN" ...
```

### Recipe 1: Create Workspace + Add Lead + Start Daemon

```bash
# 1. Create workspace
WS=$(curl -s -X POST http://localhost:8403/api/workspace \
  -H "Content-Type: application/json" -H "X-Forge-Token: $TOKEN" \
  -d '{"projectPath":"/Users/me/projects/my-app","projectName":"my-app"}' \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")

# 2. Add Input node (where user requirements go)
curl -s -X POST "http://localhost:8403/api/workspace/$WS/agents" \
  -H "Content-Type: application/json" -H "X-Forge-Token: $TOKEN" \
  -d '{
    "action": "add",
    "config": {
      "id": "input-'$(date +%s%N)'",
      "label": "Requirements",
      "icon": "📝",
      "type": "input",
      "backend": "cli",
      "dependsOn": [],
      "outputs": [],
      "steps": [],
      "role": "",
      "content": "",
      "entries": []
    }
  }'

# 3. Add Lead (Primary coordinator)
curl -s -X POST "http://localhost:8403/api/workspace/$WS/agents" \
  -H "Content-Type: application/json" -H "X-Forge-Token: $TOKEN" \
  -d '{
    "action": "add",
    "config": {
      "id": "lead-'$(date +%s%N)'",
      "label": "Lead",
      "icon": "👑",
      "type": "agent",
      "primary": true,
      "backend": "cli",
      "agentId": "claude",
      "dependsOn": [],
      "workDir": "./",
      "outputs": ["docs/lead/"],
      "persistentSession": true,
      "skipPermissions": true,
      "plugins": [],
      "role": "You are the Lead — primary coordinator...",
      "steps": [
        {"id": "intake", "label": "Intake", "prompt": "Read Workspace Team..."},
        {"id": "delegate", "label": "Delegate", "prompt": "create_request for each task..."},
        {"id": "monitor", "label": "Monitor", "prompt": "get_status + list_requests..."}
      ]
    }
  }'

# 4. Start daemon
curl -s -X POST "http://localhost:8403/api/workspace/$WS/agents" \
  -H "Content-Type: application/json" -H "X-Forge-Token: $TOKEN" \
  -d '{"action": "start_daemon"}'
```

### Recipe 2: Add a Full Dev Team (Lead + Engineer + QA + Reviewer)

```bash
TS=$(date +%s%N)
INPUT_ID="input-$TS"
LEAD_ID="lead-$TS"
ENG_ID="engineer-$TS"
QA_ID="qa-$TS"
REV_ID="reviewer-$TS"

# Input
curl -s -X POST "http://localhost:8403/api/workspace/$WS/agents" \
  -H "Content-Type: application/json" -H "X-Forge-Token: $TOKEN" \
  -d "{\"action\":\"add\",\"config\":{\"id\":\"$INPUT_ID\",\"label\":\"Requirements\",\"icon\":\"📝\",\"type\":\"input\",\"backend\":\"cli\",\"dependsOn\":[],\"outputs\":[],\"steps\":[],\"role\":\"\",\"content\":\"\",\"entries\":[]}}"

# Lead (depends on Input)
curl -s -X POST "http://localhost:8403/api/workspace/$WS/agents" \
  -H "Content-Type: application/json" -H "X-Forge-Token: $TOKEN" \
  -d "{\"action\":\"add\",\"config\":{\"id\":\"$LEAD_ID\",\"label\":\"Lead\",\"icon\":\"👑\",\"type\":\"agent\",\"primary\":true,\"backend\":\"cli\",\"agentId\":\"claude\",\"dependsOn\":[\"$INPUT_ID\"],\"workDir\":\"./\",\"outputs\":[\"docs/lead/\"],\"persistentSession\":true,\"skipPermissions\":true,\"role\":\"Lead coordinator\",\"steps\":[{\"id\":\"plan\",\"label\":\"Plan\",\"prompt\":\"Coordinate the team\"}]}}"

# Engineer (depends on Lead)
curl -s -X POST "http://localhost:8403/api/workspace/$WS/agents" \
  -H "Content-Type: application/json" -H "X-Forge-Token: $TOKEN" \
  -d "{\"action\":\"add\",\"config\":{\"id\":\"$ENG_ID\",\"label\":\"Engineer\",\"icon\":\"🔨\",\"type\":\"agent\",\"backend\":\"cli\",\"agentId\":\"claude\",\"dependsOn\":[\"$LEAD_ID\"],\"workDir\":\"./src\",\"outputs\":[\"src/\"],\"persistentSession\":true,\"skipPermissions\":true,\"role\":\"Engineer\",\"steps\":[{\"id\":\"impl\",\"label\":\"Implement\",\"prompt\":\"Write code\"}]}}"

# QA (depends on Engineer)
curl -s -X POST "http://localhost:8403/api/workspace/$WS/agents" \
  -H "Content-Type: application/json" -H "X-Forge-Token: $TOKEN" \
  -d "{\"action\":\"add\",\"config\":{\"id\":\"$QA_ID\",\"label\":\"QA\",\"icon\":\"🧪\",\"type\":\"agent\",\"backend\":\"cli\",\"agentId\":\"claude\",\"dependsOn\":[\"$ENG_ID\"],\"workDir\":\"./qa\",\"outputs\":[\"tests/\"],\"persistentSession\":true,\"skipPermissions\":true,\"plugins\":[\"playwright-main\"],\"role\":\"QA\",\"steps\":[{\"id\":\"test\",\"label\":\"Test\",\"prompt\":\"Write and run tests\"}]}}"

# Reviewer (depends on Engineer + QA)
curl -s -X POST "http://localhost:8403/api/workspace/$WS/agents" \
  -H "Content-Type: application/json" -H "X-Forge-Token: $TOKEN" \
  -d "{\"action\":\"add\",\"config\":{\"id\":\"$REV_ID\",\"label\":\"Reviewer\",\"icon\":\"🔍\",\"type\":\"agent\",\"backend\":\"cli\",\"agentId\":\"claude\",\"dependsOn\":[\"$ENG_ID\",\"$QA_ID\"],\"workDir\":\"./review\",\"outputs\":[\"docs/review/\"],\"persistentSession\":true,\"skipPermissions\":true,\"role\":\"Reviewer\",\"steps\":[{\"id\":\"review\",\"label\":\"Review\",\"prompt\":\"Review code\"}]}}"
```

### Recipe 3: Submit Input and Run

```bash
# Send requirement text to Input node
curl -s -X POST "http://localhost:8403/api/workspace/$WS/agents" \
  -H "Content-Type: application/json" -H "X-Forge-Token: $TOKEN" \
  -d "{\"action\":\"complete_input\",\"agentId\":\"$INPUT_ID\",\"content\":\"Build a login page with email/password.\"}"

# Trigger Lead to start
curl -s -X POST "http://localhost:8403/api/workspace/$WS/agents" \
  -H "Content-Type: application/json" -H "X-Forge-Token: $TOKEN" \
  -d "{\"action\":\"run\",\"agentId\":\"$LEAD_ID\"}"
```

### Recipe 4: Save a Smith as Template + Import Later

```bash
# Save current agent config as template
curl -s -X POST http://localhost:8403/api/smith-templates \
  -H "Content-Type: application/json" -H "X-Forge-Token: $TOKEN" \
  -d '{
    "name": "My Engineer",
    "icon": "🔨",
    "description": "Custom engineer with TDD preference",
    "config": {
      "label": "Engineer",
      "icon": "🔨",
      "backend": "cli",
      "agentId": "claude",
      "workDir": "./src",
      "outputs": ["src/"],
      "role": "Engineer with TDD approach...",
      "steps": [...],
      "persistentSession": true,
      "plugins": ["playwright-main"]
    }
  }'

# List templates
curl -s http://localhost:8403/api/smith-templates -H "X-Forge-Token: $TOKEN"

# When adding agent, reuse saved template's config field
```

### Recipe 5: Configure Watch on an Agent

```bash
# Update agent to watch the src/ directory and analyze on changes
curl -s -X POST "http://localhost:8403/api/workspace/$WS/agents" \
  -H "Content-Type: application/json" -H "X-Forge-Token: $TOKEN" \
  -d "{
    \"action\":\"update\",
    \"agentId\":\"$REV_ID\",
    \"config\": {
      \"id\":\"$REV_ID\",
      \"label\":\"Reviewer\",
      ... (all existing fields)
      \"watch\": {
        \"enabled\": true,
        \"interval\": 60,
        \"targets\": [
          {\"type\":\"directory\",\"path\":\"src/\",\"debounce\":10}
        ],
        \"action\": \"analyze\",
        \"prompt\": \"Review recent changes for quality issues\"
      }
    }
  }"
```

### Recipe 6: Install a Plugin Instance

```bash
# List available plugin definitions
curl -s http://localhost:8403/api/plugins -H "X-Forge-Token: $TOKEN"

# Install a plugin instance (e.g., playwright)
curl -s -X POST http://localhost:8403/api/plugins \
  -H "Content-Type: application/json" -H "X-Forge-Token: $TOKEN" \
  -d '{
    "action": "install",
    "id": "playwright",
    "config": {
      "instanceName": "playwright-main"
    }
  }'

# List installed instances
curl -s "http://localhost:8403/api/plugins?installed=true" -H "X-Forge-Token: $TOKEN"
```

### Recipe 7: Query Workspace State

```bash
# List all workspaces
curl -s http://localhost:8403/api/workspace -H "X-Forge-Token: $TOKEN"

# Get full workspace state (agents + states + bus)
curl -s "http://localhost:8403/api/workspace?projectPath=/Users/me/projects/my-app" \
  -H "X-Forge-Token: $TOKEN"

# Get live agent list
curl -s "http://localhost:8403/api/workspace/$WS/agents" -H "X-Forge-Token: $TOKEN"

# Stream SSE events (runs forever, use Ctrl+C to stop)
curl -N "http://localhost:8403/api/workspace/$WS/stream" -H "X-Forge-Token: $TOKEN"
```

### Recipe 8: Remove Agent / Workspace

```bash
# Remove an agent (non-primary only)
curl -s -X POST "http://localhost:8403/api/workspace/$WS/agents" \
  -H "Content-Type: application/json" -H "X-Forge-Token: $TOKEN" \
  -d "{\"action\":\"remove\",\"agentId\":\"$REV_ID\"}"

# Delete entire workspace
curl -s -X DELETE "http://localhost:8403/api/workspace?id=$WS" \
  -H "X-Forge-Token: $TOKEN"
```

## Common Pitfalls

| Problem | Cause | Solution |
|---------|-------|----------|
| "Work directory conflict" | Two agents use same `workDir` | Each non-input smith must have unique workDir |
| "Cycle detected in dependencies" | `dependsOn` creates a loop | Review DAG, break the cycle |
| "Primary already set" | Trying to add 2nd primary smith | Only one primary per workspace |
| Daemon won't start | No primary agent, or config errors | Check logs at `~/.forge/data/forge.log` |
| Agent stuck in `running` | Stop hook didn't fire | 20-min auto timeout will kick in; or manual mark_done |
| Hook not firing | `.forge/agent-context.json` missing | Restart daemon to re-inject |
| `agentId` not found | CLI/profile deleted from Settings | Update agent config with valid agentId |

## Tips

1. **Start with a Lead** — add Lead first as Primary, then add specialists (Engineer, QA, etc.)
2. **Dependencies must be DAG** — no cycles allowed
3. **Use request documents** — don't rely on loose `send_message` for delegation
4. **Trust the topology** — agents auto-see the team in their context, no redundant `get_agents` calls needed
5. **Let Lead cover gaps** — don't add roles you don't need, Lead handles missing ones
6. **Use Watch for passive monitoring** — avoid token costs with `action: log`
7. **Save useful smiths as templates** — 💾 button → reusable across workspaces
8. **Use Terminal mode** for debugging — interact with a smith directly
9. **Check session logs** if a smith seems stuck — `~/.claude/projects/<encoded-path>/<sessionId>.jsonl`
10. **20-min timeout is a safety net** — if Stop hook fires normally, task is marked done immediately
