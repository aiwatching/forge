---
description: "[FALLBACK — only use if MCP send_message tool is NOT available] Send a message to another Forge Workspace agent via HTTP API"
---

# Forge Send

Send a message to another agent in the Forge Workspace.

## When to trigger
- You fixed a bug that QA reported → notify QA immediately
- You have a question about requirements → ask PM
- You found an issue that another agent should know about
- User explicitly asks to send a message to another agent

## When NOT to trigger
- Do NOT send a reply to the agent whose message you are currently processing. The system automatically marks your result as done and notifies them. Only use forge-send for NEW issues or questions to OTHER agents.

## How to send

### Option 1: MCP Tool (preferred)
If the `send_message` tool is available, use it directly:
```
send_message(to: "TARGET_LABEL", content: "YOUR MESSAGE", action: "ACTION")
```

### Option 2: HTTP API (fallback if MCP not available)

Step 1 — Get workspace ID (already set as env var):
```bash
echo "$FORGE_WORKSPACE_ID"
```

Step 2 — Send message (use $FORGE_WORKSPACE_ID directly):
```bash
curl -s -X POST "http://localhost:8403/api/workspace/$FORGE_WORKSPACE_ID/smith" -H "Content-Type: application/json" -d '{"action":"send","agentId":"'"$FORGE_AGENT_ID"'","to":"TARGET_LABEL","msgAction":"ACTION","content":"YOUR MESSAGE"}'
```

Replace:
- `WORKSPACE_ID` = the ID from step 1
- `TARGET_LABEL` = target agent label (e.g., "QA", "PM", "Engineer", "Reviewer")
- `ACTION` = one of: `fix_request`, `update_notify`, `question`, `info_request`, `review`
- `YOUR MESSAGE` = your actual message

Note: `$FORGE_AGENT_ID` is automatically set by Forge when launching the terminal. Do NOT replace it manually.

Tell the user the result.
