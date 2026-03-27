---
description: Check and manage messages from other Forge Workspace agents (QA reports, review feedback, PM requests)
---

# Forge Inbox

Check for messages from other agents and manage their status.

## When to trigger
- At the start of a new conversation/session
- When the user asks about other agents' status or messages

## How to use

IMPORTANT: Do NOT check environment variables. Just run the commands — they auto-discover the workspace.

Step 1 — Get workspace ID:
```bash
curl -s "http://localhost:8403/api/workspace?projectPath=$(pwd)" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))"
```

Step 2 — Check inbox (replace WORKSPACE_ID):
```bash
curl -s -X POST "http://localhost:8403/api/workspace/WORKSPACE_ID/smith" -H "Content-Type: application/json" -d '{"action":"inbox","agentId":"unknown"}'
```

## Mark message as done
```bash
curl -s -X POST "http://localhost:8403/api/workspace/WORKSPACE_ID/smith" -H "Content-Type: application/json" -d '{"action":"message_done","agentId":"unknown","messageId":"MESSAGE_ID"}'
```

## Mark message as failed
```bash
curl -s -X POST "http://localhost:8403/api/workspace/WORKSPACE_ID/smith" -H "Content-Type: application/json" -d '{"action":"message_failed","agentId":"unknown","messageId":"MESSAGE_ID"}'
```

After handling a message, always mark it as done or failed.
