# Workspace (Forge Smiths)

## Overview

Workspace is a multi-agent orchestration system. You define a team of **Smiths** (agents) with roles, dependencies, and steps. Smiths run as long-lived daemons, communicate via a message bus, and can be controlled manually or automatically.

## Concepts

| Term | Description |
|------|-------------|
| **Smith** | A long-running agent instance in the workspace |
| **Agent Profile** | A reusable configuration (CLI type + env vars + model) that can be assigned to any smith |
| **Message Bus** | Inter-agent communication system with two message categories |
| **Input Node** | User-provided requirements node (append-only history) |
| **Daemon** | Background execution loop that keeps smiths alive and consuming messages |

## Three-Layer State Model

Each smith has three independent status layers displayed on the node:

| Layer | Values | Description |
|-------|--------|-------------|
| **Smith Status** | `down` / `active` | Whether the daemon process is running |
| **Mode** | `auto` / `manual` | `auto` = daemon-driven, `manual` = user in terminal (purple) |
| **Task Status** | `idle` / `running` / `done` / `failed` | Current work status |

- **Mode controls message consumption**: `manual` pauses inbox processing (same as `running`)
- **Smith Status controls the daemon loop**: `down` stops the message loop entirely
- **Task Status tracks work**: unaffected by mode changes

## Dependencies (DAG)

Dependencies must form a **directed acyclic graph** (DAG). Circular dependencies are rejected when adding or editing agents.

```
Input → PM → Engineer → QA → Reviewer
```

- Upstream agents complete first, then broadcast to downstream
- Each agent knows its upstream (dependsOn) and the system prevents cycles

## Message System

### Two Message Categories

| Category | Direction | Behavior | Use Case |
|----------|-----------|----------|----------|
| **Notification** | Follows DAG (upstream → downstream) | Auto-broadcast on completion, downstream discards reverse notifications | "I'm done, here's what I did" |
| **Ticket** | Any direction (ignores DAG) | 1-to-1, independent lifecycle, retry limits | Bug reports, fix requests |

### Notification Messages (Default)

When a smith completes:
- If it was processing an **upstream** message → broadcast to all downstream agents
- If it was processing a **downstream** message → no broadcast, just mark the message done (sender checks outbox status)
- Each message carries a `causedBy` field tracing which inbox message triggered it

### Ticket Messages

- Created via `create_ticket` API or forge skills
- Have their own lifecycle: `open → in_progress → fixed → verified → closed`
- Retry limit (default 3), exceeding marks ticket as failed
- Not affected by DAG direction — any agent can ticket any agent

### CausedBy Chain

Every outgoing message carries `causedBy` linking to the inbox message that triggered it:

```json
{
  "from": "qa-123",
  "to": "reviewer-456",
  "action": "upstream_complete",
  "causedBy": {
    "messageId": "msg-789",
    "from": "engineer-111",
    "to": "qa-123"
  }
}
```

This enables:
- **Loop prevention**: Notifications from downstream are silently discarded
- **Outbox tracking**: Sender can verify their message was processed
- **Audit trail**: Every message traces back to its trigger

### Message Receive Rules

When a message arrives at an agent's inbox:

1. **Tickets** → always accepted (with retry limit check)
2. **Notification with causedBy matching own outbox** → accepted (response to my request)
3. **Notification from downstream agent** → silently discarded (prevents reverse flow)
4. **Notification from upstream or no causedBy** → accepted (normal DAG flow)

### Message Status Flow

`pending` → `running` → `done` / `failed`

- Only one message processed at a time per agent
- `currentMessageId` persisted in agent state for crash recovery

## Manual Mode

Click the **⌨️** button on any smith to open a terminal:
- Mode switches to `manual` (purple indicator on node)
- Inbox message processing pauses (messages stay pending)
- A tmux session opens with CLI + profile env + forge env vars (`FORGE_AGENT_ID`, `FORGE_WORKSPACE_ID`, `FORGE_PORT`)
- Forge Skills auto-installed for inter-agent communication
- Close terminal → mode returns to `auto`, pending messages resume processing

### Forge Skills in Terminal

| Skill | Description |
|-------|-------------|
| `/forge-send` | Send a message to another smith (blocked if replying to current sender — use for NEW issues only) |
| `/forge-inbox` | Check incoming messages |
| `/forge-status` | Check all smiths' status |
| `/forge-workspace-sync` | Sync progress back to workspace |

**Note**: When processing a message from another agent, do NOT use `/forge-send` to reply — the system auto-delivers results via `markMessageDone`. Only use `/forge-send` for new issues to other agents.

## Inbox Management

Each smith has an inbox panel with two tabs:

### Inbox Tab
- Messages received from other smiths
- Status badges: pending (yellow), running (blue), done (green), failed (red)
- Ticket messages have purple border + TICKET badge + lifecycle status
- CausedBy trace shows which agent triggered the message

### Outbox Tab
- Messages sent by this smith
- Track delivery status and responses

### Batch Operations
- **Select all completed** → batch delete done/failed messages
- **Abort all pending (N)** → cancel all pending messages at once
- Checkbox selection on individual done/failed messages

## Controls

| Action | Description |
|--------|-------------|
| **Start** | Launch daemon, begin executing all agents |
| **Stop** | Stop daemon, kill all workers |
| **Pause** | Pause a specific smith (stops consuming messages) |
| **Resume** | Resume a paused smith |
| **Retry** | Retry a failed smith |
| **Reset** | Reset smith to idle, clear history |
| **Open Terminal** | Switch to manual mode, open floating terminal |
| **Close Terminal** | Return to auto mode, resume message processing |

## Workspace API

```bash
# List workspaces
curl http://localhost:8403/api/workspace

# Get workspace state
curl http://localhost:8403/api/workspace/<id>

# Agent operations
curl -X POST http://localhost:8403/api/workspace/<id>/agents \
  -H 'Content-Type: application/json' \
  -d '{"action":"start"}'                                        # start daemon
  -d '{"action":"stop"}'                                         # stop daemon
  -d '{"action":"run", "agentId":"engineer-123"}'                # run one smith
  -d '{"action":"open_terminal", "agentId":"engineer-123"}'      # manual mode
  -d '{"action":"close_terminal", "agentId":"engineer-123"}'     # back to auto
  -d '{"action":"reset", "agentId":"engineer-123"}'              # reset to idle

# Smith API (via workspace daemon)
curl -X POST http://localhost:8403/api/workspace/<id>/smith \
  -H 'Content-Type: application/json' \
  -d '{"action":"send","agentId":"$ID","to":"QA","msgAction":"review","content":"Please check"}'
  -d '{"action":"inbox","agentId":"$ID"}'
  -d '{"action":"status","agentId":"$ID"}'
  -d '{"action":"create_ticket","agentId":"$FROM","targetId":"$TO","content":"Bug found"}'
  -d '{"action":"update_ticket","messageId":"$ID","ticketStatus":"fixed"}'

# Stream real-time events (SSE)
curl http://localhost:8403/api/workspace/<id>/stream
```

## Persistence

- Workspace state: `~/.forge/workspaces/<id>/state.json`
- Auto-saved every 10 seconds
- Atomic writes (temp file → rename) for crash safety
- Synchronous save on daemon shutdown
- `currentMessageId` persisted per agent for crash recovery

## Tips

1. **Dependencies must be a DAG** — no circular dependencies allowed
2. **Start with Input nodes** — define requirements before adding agent smiths
3. **Use profiles** for agents that need custom API endpoints or models
4. **Notifications flow downstream** — upstream agents won't receive downstream broadcasts
5. **Use tickets for bugs** — tickets ignore DAG direction, have retry limits
6. **Open Terminal** for manual intervention — mode switches to manual, inbox pauses
7. **Check Inbox** when a smith is stuck — it may have unprocessed messages
8. **Batch delete** completed messages to keep inbox clean
