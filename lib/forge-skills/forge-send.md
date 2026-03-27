---
description: Send a message to another Forge Workspace agent immediately via API (notify QA of a fix, ask PM a question, etc.)
---

# Forge Send

Send a message to another agent in the Forge Workspace.

## When to trigger
- You fixed a bug that QA reported → notify QA immediately
- You have a question about requirements → ask PM
- You found an issue that another agent should know about
- User explicitly asks to send a message to another agent

## How to send

IMPORTANT: Do NOT check environment variables first. Just run the command below — it auto-discovers everything.

Step 1 — Get workspace ID:
```bash
curl -s "http://localhost:8403/api/workspace?projectPath=$(pwd)" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))"
```

Step 2 — Send message (replace WORKSPACE_ID with result from step 1):
```bash
curl -s -X POST "http://localhost:8403/api/workspace/WORKSPACE_ID/smith" -H "Content-Type: application/json" -d '{"action":"send","agentId":"unknown","to":"TARGET_LABEL","msgAction":"ACTION","content":"YOUR MESSAGE"}'
```

Replace:
- `WORKSPACE_ID` = the ID from step 1
- `TARGET_LABEL` = target agent label (e.g., "QA", "PM", "Engineer", "Reviewer")
- `ACTION` = one of: `fix_request`, `update_notify`, `question`, `info_request`
- `YOUR MESSAGE` = your actual message

Tell the user the result.
