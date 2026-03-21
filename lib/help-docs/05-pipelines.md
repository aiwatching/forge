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

### issue-auto-fix
Fetches a GitHub issue → fixes code on new branch → creates PR.

Input: `issue_id`, `project`, `base_branch` (optional)

### pr-review
Fetches PR diff → AI code review → posts result.

Input: `pr_number`, `project`

## CLI

```bash
forge flows              # list available workflows
forge run my-workflow    # execute a workflow
```

## Storage

- Workflow YAML: `~/.forge/data/flows/`
- Execution state: `~/.forge/data/pipelines/`
