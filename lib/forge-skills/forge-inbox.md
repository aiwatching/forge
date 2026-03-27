---
description: Check and manage messages from other Forge Workspace agents (QA reports, review feedback, PM requests)
---

# Forge Inbox

Check for messages from other agents and manage their status.

## When to trigger
- At the start of a new conversation/session
- When the user asks about other agents' status or messages
- Periodically during long sessions

## Check inbox

```bash
_FP=${FORGE_PORT:-8403}; _FW=${FORGE_WORKSPACE_ID:-$(curl -s "http://localhost:$_FP/api/workspace?projectPath=$(pwd)" 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))" 2>/dev/null)}; _FA=${FORGE_AGENT_ID:-unknown}; curl -s -X POST "http://localhost:$_FP/api/workspace/$_FW/smith" -H "Content-Type: application/json" -d '{"action":"inbox","agentId":"'"$_FA"'"}'
```

This returns messages with `id`, `from`, `action`, `content`, `status`, `time`.

For each message, tell the user:
- Who sent it (which agent)
- What they want (fix_request, question, update_notify, upstream_complete, etc.)
- The message content
- Status: pending (needs action), running (processing), done (handled), failed (error)

## Mark message as done (after handling it)

```bash
_FP=${FORGE_PORT:-8403}; _FW=${FORGE_WORKSPACE_ID:-$(curl -s "http://localhost:$_FP/api/workspace?projectPath=$(pwd)" 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))" 2>/dev/null)}; _FA=${FORGE_AGENT_ID:-unknown}; curl -s -X POST "http://localhost:$_FP/api/workspace/$_FW/smith" -H "Content-Type: application/json" -d '{"action":"message_done","agentId":"'"$_FA"'","messageId":"MESSAGE_ID"}'
```

## Mark message as failed

```bash
_FP=${FORGE_PORT:-8403}; _FW=${FORGE_WORKSPACE_ID:-$(curl -s "http://localhost:$_FP/api/workspace?projectPath=$(pwd)" 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))" 2>/dev/null)}; _FA=${FORGE_AGENT_ID:-unknown}; curl -s -X POST "http://localhost:$_FP/api/workspace/$_FW/smith" -H "Content-Type: application/json" -d '{"action":"message_failed","agentId":"'"$_FA"'","messageId":"MESSAGE_ID"}'
```

IMPORTANT: After handling a message, always mark it as done. If you can't handle it, mark it as failed.
