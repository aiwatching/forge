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
- You see a [SEND:AgentLabel:action] marker in your output → call this API to actually deliver it

## How to send

```bash
curl -s -X POST http://localhost:{{FORGE_PORT}}/api/workspace/{{WORKSPACE_ID}}/smith \
  -H "Content-Type: application/json" \
  -d '{"action":"send","agentId":"{{AGENT_ID}}","to":"TARGET_LABEL","msgAction":"ACTION","content":"YOUR MESSAGE"}'
```

Where:
- `to` = target agent label (e.g., "QA", "PM", "Engineer", "Reviewer")
- `msgAction` = one of: `fix_request`, `update_notify`, `question`, `info_request`
- `content` = your actual message (be specific, include file names and details)

IMPORTANT: Always call this API to send messages. Do NOT just write [SEND:...] text — that alone won't deliver the message. You must call the API.

Tell the user the message was sent and to which agent.
