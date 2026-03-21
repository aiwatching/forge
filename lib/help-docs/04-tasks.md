# Background Tasks

## What Are Tasks?

Tasks run Claude Code prompts in the background. They use `claude -p` (print mode) — execute and exit, no persistent session. Your code runs on your machine using your Claude subscription.

## Create a Task

**From UI**: Click "+ New Task" in the Tasks tab.

**From CLI**:
```bash
forge task my-project "fix the login bug"
forge task my-project "add unit tests for utils.ts" --new  # fresh session
```

**From Telegram**: `/task my-project fix the login bug`

## Task Modes

| Mode | Description |
|------|-------------|
| `prompt` | Run Claude Code with a prompt (default) |
| `shell` | Execute raw shell command |
| `monitor` | Watch a session and trigger actions |

## Watch Task Output

```bash
forge watch <task-id>    # live stream in terminal
```

Or from Telegram: `/watch <task-id>`

## CLI Commands

```bash
forge tasks              # list all tasks
forge tasks running      # filter by status
forge status <id>        # task details
forge cancel <id>        # cancel
forge retry <id>         # retry failed task
forge log <id>           # execution log
```

## Features

- **Per-project concurrency**: One prompt task per project at a time, others queue
- **Session continuity**: All tasks in the same project share one Claude conversation
- **Cost tracking**: Token usage and USD cost per task
- **Git tracking**: Captures branch name and git diff after execution
- **Scheduled execution**: Set `scheduledAt` for deferred tasks
