---
description: Check the status of all agents in the Forge Workspace (who is running, done, waiting)
---

# Forge Status

Check the current status of all agents in the Forge Workspace.

## When to trigger
- User asks "what's the status?" or "how are other agents doing?"
- At the start of a session to understand the current workspace state
- After marking yourself as done, to confirm the status update

## How to check

```bash
curl -s -X POST http://localhost:{{FORGE_PORT}}/api/workspace/{{WORKSPACE_ID}}/smith \
  -H "Content-Type: application/json" \
  -d '{"action":"status","agentId":"{{AGENT_ID}}"}'
```

Present the results as a clear status overview:
- 🟢 done — agent completed its work
- 🔵 running — agent is currently executing
- ⏳ waiting_approval — agent needs user approval to proceed
- ⬚ idle — agent hasn't started yet
- 🔴 failed — agent encountered an error
