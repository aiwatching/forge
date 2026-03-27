---
description: Automatically sync your work progress with Forge Workspace when you've completed a task or made significant changes
---

# Forge Workspace Sync

When you detect that the user has completed a meaningful unit of work (implemented a feature, fixed a bug, finished a task), automatically sync with Forge Workspace.

## When to trigger
- User says they're done with a task ("done", "完成了", "finished", "that should work")
- You've made multiple file changes and the conversation reaches a natural stopping point
- User asks to move on to the next task or agent

## How to sync

First, collect your recent output that contains any [SEND:...] markers. Then run:

```bash
curl -s -X POST http://localhost:{{FORGE_PORT}}/api/workspace/{{WORKSPACE_ID}}/smith \
  -H "Content-Type: application/json" \
  -d '{"action":"done","agentId":"{{AGENT_ID}}","output":"PASTE_YOUR_RECENT_OUTPUT_WITH_SEND_MARKERS_HERE"}'
```

IMPORTANT: Include any `[SEND:AgentLabel:action] message` markers you wrote in the `output` field. The server will parse them and deliver the messages to other agents.

For example, if you wrote `[SEND:QA:info_request] Feature X is ready for testing`, include that text in the output field so QA receives the message.

This will:
1. Detect git changes since last sync
2. Record what you did in agent memory
3. Parse [SEND:...] markers and deliver messages to other agents
4. Mark this agent as "done" in the workspace
5. Trigger downstream agents (QA, Reviewer, etc.)

After running, tell the user what files were changed, how many messages were sent, and that downstream agents have been notified.
