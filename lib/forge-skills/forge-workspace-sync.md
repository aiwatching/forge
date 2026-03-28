---
description: Automatically sync your work progress with Forge Workspace when you've completed a task or made significant changes
---

# Forge Workspace Sync

When you detect that the user has completed a meaningful unit of work, automatically sync with Forge Workspace.

## When to trigger
- User says they're done ("done", "完成了", "finished", "that should work")
- You've made multiple file changes and the conversation reaches a natural stopping point
- User asks to move on to the next task or agent

## How to sync

IMPORTANT: Do NOT check environment variables. Just run the commands.

Step 1 — Get workspace ID:
```bash
curl -s "http://localhost:8403/api/workspace?projectPath=$(pwd)" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))"
```

Step 2 — Sync (replace WORKSPACE_ID):
```bash
curl -s -X POST "http://localhost:8403/api/workspace/WORKSPACE_ID/smith" -H "Content-Type: application/json" -d '{"action":"done","agentId":"'"$FORGE_AGENT_ID"'","output":"PASTE_YOUR_RECENT_OUTPUT_HERE"}'
```

Include any `[SEND:AgentLabel:action] message` markers in the `output` field.

This will:
1. Detect git changes since last sync
2. Record what you did in agent memory
3. Parse [SEND:...] markers and deliver messages
4. Mark this agent as "done"
5. Notify downstream agents

Tell the user what files changed, messages sent, and that downstream agents were notified.
