---
description: Check the status of all agents in the Forge Workspace (who is running, done, waiting)
---

# Forge Status

Check the current status of all agents in the Forge Workspace.

## When to trigger
- User asks "what's the status?" or "how are other agents doing?"
- At the start of a session to understand the current workspace state
- After marking yourself as done, to confirm the status update

## Setup (if env vars not set)
```bash
FORGE_PORT=${FORGE_PORT:-8403}
if [ -z "$FORGE_WORKSPACE_ID" ]; then
  FORGE_WORKSPACE_ID=$(curl -s http://localhost:$FORGE_PORT/api/workspace?projectPath=$(pwd) | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))" 2>/dev/null)
fi
```

## How to check

```bash
curl -s -X POST http://localhost:${FORGE_PORT:-8403}/api/workspace/$FORGE_WORKSPACE_ID/smith \
  -H "Content-Type: application/json" \
  -d '{"action":"status","agentId":"'${FORGE_AGENT_ID:-unknown}'"}'
```

Present the results as a clear status overview:
- 🟢 active — smith is online and listening
- 🔵 running — agent is currently executing a task
- ✅ done — agent completed its work
- 🔴 failed — agent encountered an error
- ⬚ down — smith is not started
