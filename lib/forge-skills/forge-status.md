---
description: "[FALLBACK — only use if MCP get_status tool is NOT available] Check agent statuses via HTTP API"
---

# Forge Status

Check the current status of all agents in the Forge Workspace.

## When to trigger
- User asks "what's the status?" or "how are other agents doing?"
- At the start of a session to understand the current workspace state

## How to check

### Option 1: MCP Tools (preferred)
If MCP tools are available:
- `get_status()` — all agent statuses
- `get_agents()` — agent details (roles, dependencies)

### Option 2: HTTP API (fallback)

Check status (uses $FORGE_WORKSPACE_ID env var):
```bash
curl -s -X POST "http://localhost:8403/api/workspace/$FORGE_WORKSPACE_ID/smith" -H "Content-Type: application/json" -d '{"action":"status","agentId":"'"$FORGE_AGENT_ID"'"}'
```

Present the results as a clear status overview.
