---
description: Check and manage messages from other Forge Workspace agents (QA reports, review feedback, PM requests)
---

# Forge Inbox

Check for messages from other agents and manage their status.

## When to trigger
- At the start of a new conversation/session
- When the user asks about other agents' status or messages
- Periodically during long sessions (every 10-15 minutes of active work)

## Check inbox

```bash
curl -s http://localhost:{{FORGE_PORT}}/api/workspace/{{WORKSPACE_ID}}/smith \
  -X POST -H "Content-Type: application/json" \
  -d '{"action":"inbox","agentId":"{{AGENT_ID}}"}'
```

This returns messages with `id`, `from`, `action`, `content`, `status`, `time`.

For each message, tell the user:
- Who sent it (which agent)
- What they want (fix_request, question, update_notify, upstream_complete, etc.)
- The message content
- Status: pending (needs action), done (handled), failed (error)

## Mark message as done (after handling it)

```bash
curl -s http://localhost:{{FORGE_PORT}}/api/workspace/{{WORKSPACE_ID}}/smith \
  -X POST -H "Content-Type: application/json" \
  -d '{"action":"message_done","agentId":"{{AGENT_ID}}","messageId":"MESSAGE_ID"}'
```

## Mark message as failed

```bash
curl -s http://localhost:{{FORGE_PORT}}/api/workspace/{{WORKSPACE_ID}}/smith \
  -X POST -H "Content-Type: application/json" \
  -d '{"action":"message_failed","agentId":"{{AGENT_ID}}","messageId":"MESSAGE_ID"}'
```

IMPORTANT: After handling a message (fixing a bug, answering a question, etc.), always mark it as done. If you can't handle it, mark it as failed.
