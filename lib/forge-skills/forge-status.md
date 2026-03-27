---
description: Check the status of all agents in the Forge Workspace (who is running, done, waiting)
---

# Forge Status

Check the current status of all agents in the Forge Workspace.

## When to trigger
- User asks "what's the status?" or "how are other agents doing?"
- At the start of a session to understand the current workspace state

## How to check

```bash
_FP=${FORGE_PORT:-8403}; _FW=${FORGE_WORKSPACE_ID:-$(curl -s "http://localhost:$_FP/api/workspace?projectPath=$(pwd)" 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))" 2>/dev/null)}; _FA=${FORGE_AGENT_ID:-unknown}; curl -s -X POST "http://localhost:$_FP/api/workspace/$_FW/smith" -H "Content-Type: application/json" -d '{"action":"status","agentId":"'"$_FA"'"}'
```

Present the results as a clear status overview:
- 🟢 active — smith is online and listening
- 🔵 running — agent is currently executing a task
- ✅ done — agent completed its work
- 🔴 failed — agent encountered an error
- ⬚ down — smith is not started
