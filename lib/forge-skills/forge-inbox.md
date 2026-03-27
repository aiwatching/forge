---
description: Check and manage messages from other Forge Workspace agents (QA reports, review feedback, PM requests)
---

# Forge Inbox

Check for messages from other agents and manage their status.

## When to trigger
- At the start of a new conversation/session
- When the user asks about other agents' status or messages
- Periodically during long sessions (every 10-15 minutes of active work)

## Setup (if env vars not set)
```bash
FORGE_PORT=${FORGE_PORT:-8403}
if [ -z "$FORGE_WORKSPACE_ID" ]; then
  FORGE_WORKSPACE_ID=$(curl -s http://localhost:$FORGE_PORT/api/workspace?projectPath=$(pwd) | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))" 2>/dev/null)
fi
```

## Check inbox

```bash
curl -s http://localhost:${FORGE_PORT:-8403}/api/workspace/$FORGE_WORKSPACE_ID/smith \
  -X POST -H "Content-Type: application/json" \
  -d '{"action":"inbox","agentId":"'${FORGE_AGENT_ID:-unknown}'"}'
```

This returns messages with `id`, `from`, `action`, `content`, `status`, `time`.

For each message, tell the user:
- Who sent it (which agent)
- What they want (fix_request, question, update_notify, upstream_complete, etc.)
- The message content
- Status: pending (needs action), running (processing), done (handled), failed (error)

## Mark message as done (after handling it)

```bash
curl -s http://localhost:${FORGE_PORT:-8403}/api/workspace/$FORGE_WORKSPACE_ID/smith \
  -X POST -H "Content-Type: application/json" \
  -d '{"action":"message_done","agentId":"'${FORGE_AGENT_ID:-unknown}'","messageId":"MESSAGE_ID"}'
```

## Mark message as failed

```bash
curl -s http://localhost:${FORGE_PORT:-8403}/api/workspace/$FORGE_WORKSPACE_ID/smith \
  -X POST -H "Content-Type: application/json" \
  -d '{"action":"message_failed","agentId":"'${FORGE_AGENT_ID:-unknown}'","messageId":"MESSAGE_ID"}'
```

IMPORTANT: After handling a message (fixing a bug, answering a question, etc.), always mark it as done. If you can't handle it, mark it as failed.
