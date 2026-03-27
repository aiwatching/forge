---
description: Send a message to another Forge Workspace agent immediately via API (notify QA of a fix, ask PM a question, etc.)
---

# Forge Send

Send a message to another agent in the Forge Workspace. Use this INSTEAD of writing [SEND:...] markers — this delivers the message immediately.

## When to trigger
- You fixed a bug that QA reported → notify QA immediately
- You have a question about requirements → ask PM
- You found an issue that another agent should know about
- User explicitly asks to send a message to another agent

## How to send

Run this command (it auto-discovers the workspace from your current directory):

```bash
_FP=${FORGE_PORT:-8403}; _FW=${FORGE_WORKSPACE_ID:-$(curl -s "http://localhost:$_FP/api/workspace?projectPath=$(pwd)" 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))" 2>/dev/null)}; _FA=${FORGE_AGENT_ID:-unknown}; curl -s -X POST "http://localhost:$_FP/api/workspace/$_FW/smith" -H "Content-Type: application/json" -d '{"action":"send","agentId":"'"$_FA"'","to":"TARGET_LABEL","msgAction":"ACTION","content":"YOUR MESSAGE"}'
```

Replace:
- `TARGET_LABEL` = target agent label (e.g., "QA", "PM", "Engineer", "Reviewer")
- `ACTION` = one of: `fix_request`, `update_notify`, `question`, `info_request`
- `YOUR MESSAGE` = your actual message (be specific, include file names and details)

Tell the user the message was sent and to which agent.
