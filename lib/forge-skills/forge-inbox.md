---
description: Check for messages from other Forge Workspace agents (QA reports, review feedback, PM requests)
---

# Forge Inbox

Check for messages from other agents in the Forge Workspace. Other agents may have sent bug reports, review feedback, or questions that need your attention.

## When to trigger
- At the start of a new conversation/session
- When the user asks about other agents' status or messages
- Periodically during long sessions (every 10-15 minutes of active work)
- When you sense the user might be ready to context-switch

## How to check

```bash
curl -s http://localhost:{{FORGE_PORT}}/api/workspace/{{WORKSPACE_ID}}/smith \
  -X POST -H "Content-Type: application/json" \
  -d '{"action":"inbox","agentId":"{{AGENT_ID}}"}'
```

This returns a list of messages. For each message, tell the user:
- Who sent it (which agent)
- What they want (the action: fix_request, question, update_notify, etc.)
- The message content

If there are fix_request messages, prioritize those — another agent found an issue that needs attention.
