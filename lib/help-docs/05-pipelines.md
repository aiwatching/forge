# Pipelines (Workflows)

## What Are Pipelines?

Pipelines chain multiple tasks into a DAG (directed acyclic graph). Each step can depend on previous steps, pass outputs forward, and run in parallel.

## YAML Workflow Format

```yaml
name: my-workflow
description: "What this workflow does"
input:
  feature: "Feature description"
vars:
  project: my-app
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
    prompt: "Implement: {{nodes.design.outputs.spec}}"
  review:
    project: "{{vars.project}}"
    depends_on: [implement]
    prompt: "Review the changes"
```

## Node Options

| Field | Description |
|-------|-------------|
| `project` | Project name (supports `{{vars.xxx}}` templates) |
| `prompt` | Claude Code prompt or shell command |
| `mode` | `claude` (default) or `shell` |
| `branch` | Auto-checkout branch before running |
| `depends_on` | List of node IDs that must complete first |
| `outputs` | Extract results: `result`, `git_diff`, or `stdout` |
| `routes` | Conditional routing to next nodes |

## Template Variables

- `{{input.xxx}}` — pipeline input values
- `{{vars.xxx}}` — workflow variables
- `{{nodes.xxx.outputs.yyy}}` — outputs from previous nodes

## Built-in Workflows

### issue-fix-and-review
Complete issue resolution pipeline: fetch issue → fix code → create PR → review code → notify.

Steps: setup → fetch-issue → fix-code → push-and-pr → review → cleanup

Input: `issue_id`, `project`, `base_branch` (optional), `extra_context` (optional)

## CLI

```bash
forge flows              # list available workflows
forge run my-workflow    # execute a workflow
```

## Import a Workflow

1. In Pipelines tab, click **Import**
2. Paste YAML workflow content
3. Click **Save Workflow**

Or save YAML directly to `~/.forge/data/flows/<name>.yaml`.

To create a workflow via Help AI: ask "Create a pipeline that does X" — the AI will generate the YAML for you to import.

## Creating Workflows via API

```bash
curl -X POST http://localhost:3000/api/pipelines \
  -H 'Content-Type: application/json' \
  -d '{"action": "save-workflow", "yaml": "name: my-flow\nnodes:\n  step1:\n    project: my-project\n    prompt: do something"}'
```

## Storage

- Workflow YAML: `~/.forge/data/flows/`
- Execution state: `~/.forge/data/pipelines/`
