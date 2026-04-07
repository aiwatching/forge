# Pipelines (Workflows)

## What Are Pipelines?

Pipelines chain multiple tasks into a DAG (directed acyclic graph). Each step can depend on previous steps, pass outputs forward, and run in parallel. Pipelines are defined as YAML workflow files.

## YAML Workflow Format

```yaml
name: my-workflow
description: "What this workflow does"
input:
  feature: "Feature description"      # required input fields
  priority: "Priority level (optional)"
vars:
  project: my-app                     # default variables
nodes:
  design:
    project: "{{vars.project}}"
    prompt: "Design: {{input.feature}}"
    outputs:
      - name: spec
        extract: result
  implement:
    project: "{{vars.project}}"
    depends_on: [design]
    prompt: "Implement based on: {{nodes.design.outputs.spec}}"
    outputs:
      - name: diff
        extract: git_diff
  review:
    project: "{{vars.project}}"
    depends_on: [implement]
    prompt: "Review the changes"
```

## Node Options

| Field | Description | Default |
|-------|-------------|---------|
| `project` | Project name (supports templates) | required |
| `prompt` | Claude Code prompt or shell command | required |
| `mode` | `claude` (AI agent) or `shell` (raw command) | `claude` |
| `branch` | Auto-checkout branch before running (supports templates) | none |
| `depends_on` | List of node IDs that must complete first | `[]` |
| `outputs` | Extract results (see Output Extraction) | `[]` |
| `routes` | Conditional routing to next nodes (see Routing) | `[]` |
| `max_iterations` | Max loop iterations for routed nodes | `3` |

## Node Modes

### `claude` (default)
Runs the prompt via Claude Code (`claude -p`). The AI agent reads the codebase, makes changes, and returns a result.

### `shell`
Runs the prompt as a raw shell command (`bash -c "..."`). Useful for git operations, CLI tools, API calls, etc.

```yaml
nodes:
  setup:
    mode: shell
    project: my-app
    prompt: |
      git checkout main && git pull && echo "READY"
    outputs:
      - name: info
        extract: stdout
```

**Shell escaping**: Template values in shell mode are automatically escaped (single quotes `'` → `'\''`) to prevent injection.

## Template Variables

Templates use `{{...}}` syntax and are resolved before execution:

- `{{input.xxx}}` — pipeline input values provided at trigger time
- `{{vars.xxx}}` — workflow-level variables defined in YAML
- `{{nodes.<node_id>.outputs.<output_name>}}` — outputs from completed nodes

Node IDs can contain hyphens (e.g., `{{nodes.fetch-issue.outputs.data}}`).

### Examples

```yaml
prompt: "Fix issue #{{input.issue_id}} in {{input.project}}"
prompt: "Based on: {{nodes.design.outputs.spec}}"
prompt: |
  REPO={{nodes.setup.outputs.repo}} && \
  gh pr create --title "Fix #{{input.issue_id}}" -R "$REPO"
```

## Output Extraction

Each node can extract outputs for downstream nodes:

| Extract Type | Description |
|-------------|-------------|
| `result` | Claude's final response text |
| `stdout` | Shell command stdout (same as result for shell mode) |
| `git_diff` | Git diff of changes made during the task |

```yaml
outputs:
  - name: summary
    extract: result
  - name: changes
    extract: git_diff
```

## Skip Convention (`__SKIP__`)

If a shell node outputs `__SKIP__` in its stdout and exits with code 0, the node is marked as `skipped` instead of `done`. All downstream dependent nodes are also skipped. The pipeline completes successfully (not failed).

```yaml
nodes:
  check:
    mode: shell
    project: my-app
    prompt: |
      if [ -z "{{input.issue_id}}" ]; then
        echo "__SKIP__ No issue_id provided"
        exit 0
      fi
      echo "Processing issue {{input.issue_id}}"
```

Use this for optional steps that should gracefully skip when preconditions aren't met.

## Conditional Routing

Nodes can route to different next steps based on output content:

```yaml
nodes:
  analyze:
    project: my-app
    prompt: "Analyze the issue. Reply SIMPLE or COMPLEX."
    outputs:
      - name: complexity
        extract: result
    routes:
      - condition: "{{outputs.complexity contains 'SIMPLE'}}"
        next: quick-fix
      - condition: default
        next: deep-fix
  quick-fix:
    depends_on: [analyze]
    project: my-app
    prompt: "Apply a quick fix"
  deep-fix:
    depends_on: [analyze]
    project: my-app
    prompt: "Do a thorough analysis and fix"
```

### Route Conditions

- `{{outputs.<name> contains '<keyword>'}}` — check if output contains a keyword
- `default` — fallback route (always matches)

### Loops

If a route points back to the same node, it creates a loop (up to `max_iterations`):

```yaml
nodes:
  fix-and-test:
    project: my-app
    prompt: "Fix the failing test, then run tests."
    max_iterations: 5
    outputs:
      - name: test_result
        extract: result
    routes:
      - condition: "{{outputs.test_result contains 'PASS'}}"
        next: done
      - condition: default
        next: fix-and-test   # loop back to retry
  done:
    depends_on: [fix-and-test]
    mode: shell
    project: my-app
    prompt: "echo 'All tests passing!'"
```

## Branch Auto-checkout

Pipeline steps automatically use **git worktree** for isolated execution. Each step gets its own working copy — your main working directory is never affected.

```yaml
nodes:
  work:
    project: my-app
    branch: "feature/{{input.feature_name}}"   # optional: custom branch name
    prompt: "Implement the feature"
```

**How it works:**
- If `branch` is specified, a worktree is created at `<project>/.forge/worktrees/<branch>/`
- If `branch` is omitted, an auto-generated branch `pipeline/<id>` is used
- **All step modes** (shell, agent, prompt, plugin) run inside the worktree
- After completion, the worktree is preserved for review
- Clean up: `git worktree remove <path>` after reviewing changes

**Shell steps in worktree:**

Shell steps receive 3 environment variables for worktree context:

| Variable | Value | Example |
|----------|-------|---------|
| `FORGE_WORKTREE` | Worktree path (current working directory) | `/project/.forge/worktrees/pipeline-abc12345` |
| `FORGE_WORKTREE_BRANCH` | Branch name for this worktree | `pipeline/abc12345` or `feature/my-feature` |
| `FORGE_PROJECT_ROOT` | Original project root path | `/Users/me/projects/my-app` |

Use these when shell scripts need to reference the original repo:

```yaml
nodes:
  push-changes:
    mode: shell
    prompt: |
      git add -A && git commit -m "Pipeline changes" &&
      git push origin "$FORGE_WORKTREE_BRANCH"
```

To operate on the original repo from a shell step:
```yaml
  check-main:
    mode: shell
    prompt: |
      cd "$FORGE_PROJECT_ROOT" && git log --oneline -5
```

**Benefits:**
- Your working directory stays clean during pipeline execution
- Multiple pipelines can run in parallel on the same project
- Changes are isolated on branches, easy to review/merge/discard
- All step modes use the same isolation — consistent behavior

## Parallel Execution

Nodes without dependency relationships run in parallel:

```yaml
nodes:
  frontend:
    project: my-app
    prompt: "Build frontend component"
  backend:
    project: my-app
    prompt: "Build API endpoint"
  integration:
    depends_on: [frontend, backend]  # waits for both
    project: my-app
    prompt: "Integration test"
```

`frontend` and `backend` run simultaneously; `integration` starts when both finish.

## Built-in Workflows

### issue-fix-and-review
Complete issue resolution: fetch GitHub issue → fix code on new branch → create PR.

**Input**: `issue_id`, `project`, `base_branch` (optional), `extra_context` (optional)

**Steps**: setup → fetch-issue → fix-code → push-and-pr → notify

**Prerequisites**: `gh` CLI installed and authenticated (`gh auth login`), project has GitHub remote.

### pr-review
Review a pull request: fetch PR diff → AI review → report.

**Input**: `pr_number`, `project`

**Steps**: setup → fetch-pr → review → post-review

## Project Pipeline Bindings

Projects can bind workflows for easy access and scheduled execution.

### Binding a Workflow to a Project

1. Go to **Projects → select project → Pipelines tab**
2. Click **+ Add** to attach a workflow
3. Configure:
   - **Enabled**: toggle on/off
   - **Schedule**: Manual only, or periodic (15min to 24h intervals)
4. Click **Run** to manually trigger

### Scheduled Execution

When a schedule is set (e.g., "Every 30 min"):
- The scheduler checks all bindings every 60 seconds
- If the interval has elapsed since last run, the pipeline triggers automatically
- Running pipelines are not re-triggered (prevents overlap)
- `Last run` and `Next run` times are shown in the UI

Schedule options: Manual only, 15min, 30min, 1h, 2h, 6h, 12h, 24h.

### API

```bash
# List bindings + runs + workflows for a project
curl "http://localhost:8403/api/project-pipelines?project=/path/to/project"

# Add binding
curl -X POST http://localhost:8403/api/project-pipelines \
  -H 'Content-Type: application/json' \
  -d '{"action":"add","projectPath":"/path","projectName":"my-app","workflowName":"issue-fix-and-review"}'

# Update binding (enable/disable, change config/schedule)
curl -X POST http://localhost:8403/api/project-pipelines \
  -H 'Content-Type: application/json' \
  -d '{"action":"update","projectPath":"/path","workflowName":"issue-fix-and-review","config":{"interval":30}}'

# Trigger pipeline manually
curl -X POST http://localhost:8403/api/project-pipelines \
  -H 'Content-Type: application/json' \
  -d '{"action":"trigger","projectPath":"/path","projectName":"my-app","workflowName":"issue-fix-and-review","input":{"issue_id":"42"}}'

# Remove binding
curl -X POST http://localhost:8403/api/project-pipelines \
  -H 'Content-Type: application/json' \
  -d '{"action":"remove","projectPath":"/path","workflowName":"issue-fix-and-review"}'
```

## CLI

```bash
forge flows              # list available workflows
forge run my-workflow    # execute a workflow
```

## Import a Workflow

1. In **Pipelines** tab, click **Import**
2. Paste YAML workflow content
3. Click **Save Workflow**

Or save YAML directly to `~/.forge/data/flows/<name>.yaml`.

To create a workflow via Help AI: ask "Create a pipeline that does X" — the AI will generate the YAML for you to import.

## Creating Workflows via API

```bash
curl -X POST http://localhost:8403/api/pipelines \
  -H 'Content-Type: application/json' \
  -d '{"action": "save-workflow", "yaml": "<yaml content>"}'
```

## Conversation Mode (Multi-Agent Dialogue)

Conversation mode enables multiple agents to collaborate through structured dialogue. Instead of a DAG of tasks, Forge acts as a message broker — sending prompts between agents in rounds until a stop condition is met.

### YAML Format

```yaml
name: architect-implementer
type: conversation
description: "Architect designs, implementer builds"
input:
  project: "Project name"
  task: "What to build"
agents:
  - id: architect
    agent: claude
    role: "You are a software architect. Design the solution, define interfaces, and review implementations."
  - id: implementer
    agent: codex
    role: "You are a developer. Implement what the architect designs."
max_rounds: 10
stop_condition: "both agents say DONE"
initial_prompt: "Build: {{input.task}}"
```

### Fields

| Field | Description | Default |
|-------|-------------|---------|
| `type` | Must be `conversation` | required |
| `agents` | List of participating agents | required |
| `agents[].id` | Logical ID within conversation | required |
| `agents[].agent` | Agent registry ID (`claude`, `codex`, `aider`, etc.) | `claude` |
| `agents[].role` | System prompt / role description | none |
| `agents[].project` | Project context (overrides input.project) | none |
| `max_rounds` | Maximum number of full rounds | `10` |
| `stop_condition` | When to stop early | none |
| `initial_prompt` | The seed prompt (supports `{{input.*}}` templates) | required |
| `context_strategy` | How to pass history between agents: `full`, `window`, `summary` | `summary` |
| `context_window` | Number of recent messages to include in full (for `window`/`summary`) | `4` |
| `max_content_length` | Truncate each message to this many characters | `3000` |

### Context Strategies

Agents don't share memory — Forge acts as broker and decides what context to forward.

- **`summary`** (default): Older messages are compressed to one-line summaries. The most recent N messages (set by `context_window`) are passed in full. Best balance of context quality and token usage.
- **`window`**: Only the last N messages are passed, older ones are dropped entirely. Lowest token usage.
- **`full`**: All messages from all rounds are passed in full (each truncated to `max_content_length`). Most context but token-heavy.

### Execution Flow

1. Forge sends `initial_prompt` + role to the first agent
2. Agent responds → Forge collects the response
3. Forge builds context (per `context_strategy`) and sends to the next agent
4. Repeat through all agents = 1 round
5. Continue rounds until `stop_condition` or `max_rounds`

### Stop Conditions

- `"any agent says DONE"` — stops when any agent includes "DONE" in its response
- `"both agents say DONE"` / `"all agents say DONE"` — stops when all agents have said "DONE"
- If no stop condition, runs until `max_rounds`

### UI

Conversation pipelines show a chat-like view with color-coded agent bubbles, round numbers, and linked task IDs. The sidebar shows round progress (e.g., R3/10).

### Example: Code Review Dialogue

```yaml
name: review-dialogue
type: conversation
description: "Two agents discuss code quality"
input:
  project: "Project name"
  pr_number: "PR number to review"
agents:
  - id: reviewer
    agent: claude
    role: "You are a code reviewer. Find bugs, security issues, and suggest improvements."
  - id: author
    agent: claude
    role: "You are the code author. Address review feedback, explain design decisions, and fix issues."
max_rounds: 5
stop_condition: "all agents say DONE"
initial_prompt: "Review PR #{{input.pr_number}} in project {{input.project}}. Reviewer: analyze the diff. Author: be ready to address feedback."
```

## Pipeline Model

In **Settings → Pipeline Model**, you can select which Claude model runs pipeline tasks. Set to `default` to use the same model as regular tasks.

## Storage

- Workflow YAML: `~/.forge/data/flows/`
- Execution state: `~/.forge/data/pipelines/`
- Binding config & run history: SQLite database (`~/.forge/data/forge.db`)

## Tips for Writing Workflows

1. **Start with shell nodes** for setup (git checkout, environment checks)
2. **Use `__SKIP__`** for optional steps with precondition checks
3. **Extract outputs** to pass data between nodes
4. **Use routes** for conditional logic (simple/complex paths, retry loops)
5. **Keep prompts focused** — each node should do one thing well
6. **Test manually first** before setting up schedules
7. **Use `depends_on`** to control execution order; nodes without dependencies run in parallel
