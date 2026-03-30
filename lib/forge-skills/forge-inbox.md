---
description: "[FALLBACK — only use if MCP get_inbox tool is NOT available] Check messages from other Forge Workspace agents via HTTP API"
---

# Forge Inbox

Check for messages from other agents and manage their status.

## When to trigger
- At the start of a new conversation/session
- When the user asks about other agents' status or messages

## How to use

### Option 1: MCP Tools (preferred)
If MCP tools are available, use them directly:
- `get_inbox()` — check messages
- `mark_message_done(message_id: "ID")` — mark as done
- `check_outbox()` — check messages you sent

### Option 2: HTTP API (fallback)

Check inbox (uses $FORGE_WORKSPACE_ID env var):
```bash
curl -s -X POST "http://localhost:8403/api/workspace/$FORGE_WORKSPACE_ID/smith" -H "Content-Type: application/json" -d '{"action":"inbox","agentId":"'"$FORGE_AGENT_ID"'"}'
```

## Mark message as done
```bash
curl -s -X POST "http://localhost:8403/api/workspace/$FORGE_WORKSPACE_ID/smith" -H "Content-Type: application/json" -d '{"action":"message_done","agentId":"'"$FORGE_AGENT_ID"'","messageId":"MESSAGE_ID"}'
```

After handling a message, always mark it as done or failed.
