---
description: Check the status of all agents in the Forge Workspace (who is running, done, waiting)
---

# Forge Status

Check the current status of all agents in the Forge Workspace.

## When to trigger
- User asks "what's the status?" or "how are other agents doing?"
- At the start of a session to understand the current workspace state

## How to check

IMPORTANT: Do NOT check environment variables. Just run the commands.

Step 1 — Get workspace ID:
```bash
curl -s "http://localhost:8403/api/workspace?projectPath=$(pwd)" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))"
```

Step 2 — Check status (replace WORKSPACE_ID):
```bash
curl -s -X POST "http://localhost:8403/api/workspace/WORKSPACE_ID/smith" -H "Content-Type: application/json" -d '{"action":"status","agentId":"unknown"}'
```

Present the results as a clear status overview:
- 🟢 active — smith is online and listening
- 🔵 running — agent is currently executing a task
- ✅ done — agent completed its work
- 🔴 failed — agent encountered an error
- ⬚ down — smith is not started
