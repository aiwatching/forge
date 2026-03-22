/**
 * Pipeline Engine — DAG-based workflow orchestration on top of the Task system.
 *
 * Workflow YAML → Pipeline instance → Nodes executed as Tasks
 * Supports: dependencies, output passing, conditional routing, parallel execution, notifications.
 */

import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { createTask, getTask, onTaskEvent, taskModelOverrides } from './task-manager';
import { getProjectInfo } from './projects';
import { loadSettings } from './settings';
import type { Task } from '@/src/types';
import { getDataDir } from './dirs';

const PIPELINES_DIR = join(getDataDir(), 'pipelines');
const WORKFLOWS_DIR = join(getDataDir(), 'flows');

// Track pipeline task IDs so terminal notifications can skip them (persists across hot-reloads)
const pipelineTaskKey = Symbol.for('mw-pipeline-task-ids');
const gPipeline = globalThis as any;
if (!gPipeline[pipelineTaskKey]) gPipeline[pipelineTaskKey] = new Set<string>();
export const pipelineTaskIds: Set<string> = gPipeline[pipelineTaskKey];

// ─── Types ────────────────────────────────────────────────

export interface WorkflowNode {
  id: string;
  project: string;
  prompt: string;
  mode?: 'claude' | 'shell';  // default: 'claude' (claude -p), 'shell' runs raw shell command
  branch?: string;             // auto checkout this branch before running (supports templates)
  dependsOn: string[];
  outputs: { name: string; extract: 'result' | 'git_diff' | 'stdout' }[];
  routes: { condition: string; next: string }[];
  maxIterations: number;
}

export interface Workflow {
  name: string;
  description?: string;
  vars: Record<string, string>;
  input: Record<string, string>;  // required input fields
  nodes: Record<string, WorkflowNode>;
}

export type PipelineNodeStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

export interface PipelineNodeState {
  status: PipelineNodeStatus;
  taskId?: string;
  outputs: Record<string, string>;
  iterations: number;
  startedAt?: string;
  completedAt?: string;
  error?: string;
}

export interface Pipeline {
  id: string;
  workflowName: string;
  status: 'running' | 'done' | 'failed' | 'cancelled';
  input: Record<string, string>;
  vars: Record<string, string>;
  nodes: Record<string, PipelineNodeState>;
  nodeOrder: string[];  // for UI display
  createdAt: string;
  completedAt?: string;
}

// ─── Workflow Loading ─────────────────────────────────────

// ─── Built-in workflows ──────────────────────────────────

export const BUILTIN_WORKFLOWS: Record<string, string> = {
  'issue-fix-and-review': `
name: issue-fix-and-review
description: "Fetch GitHub issue → fix code → create PR → review PR → notify"
input:
  issue_id: "GitHub issue number"
  project: "Project name"
  base_branch: "Base branch (default: auto-detect)"
  extra_context: "Additional instructions for the fix (optional)"
nodes:
  setup:
    mode: shell
    project: "{{input.project}}"
    prompt: |
      cd "$(git rev-parse --show-toplevel)" && \
      if [ -n "$(git status --porcelain)" ]; then echo "ERROR: Working directory has uncommitted changes. Please commit or stash first." && exit 1; fi && \
      ORIG_BRANCH=$(git branch --show-current || git rev-parse --short HEAD) && \
      REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || git remote get-url origin | sed 's/.*github.com[:/]//;s/.git$//') && \
      BASE={{input.base_branch}} && \
      if [ -z "$BASE" ] || [ "$BASE" = "auto-detect" ]; then BASE=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@' || echo main); fi && \
      git checkout "$BASE" 2>/dev/null || true && \
      git pull origin "$BASE" 2>/dev/null || true && \
      OLD_BRANCH=$(git branch --list "fix/{{input.issue_id}}-*" | head -1 | tr -d ' *') && \
      if [ -n "$OLD_BRANCH" ]; then git branch -D "$OLD_BRANCH" 2>/dev/null || true; fi && \
      echo "REPO=$REPO" && echo "BASE=$BASE" && echo "ORIG_BRANCH=$ORIG_BRANCH"
    outputs:
      - name: info
        extract: stdout
  fetch-issue:
    mode: shell
    project: "{{input.project}}"
    depends_on: [setup]
    prompt: |
      ISSUE_ID="{{input.issue_id}}" && \
      if [ -z "$ISSUE_ID" ]; then echo "No issue_id provided" && exit 1; fi && \
      REPO=$(echo '{{nodes.setup.outputs.info}}' | grep REPO= | cut -d= -f2) && \
      gh issue view "$ISSUE_ID" --json title,body,labels,number -R "$REPO"
    outputs:
      - name: issue_json
        extract: stdout
  fix-code:
    project: "{{input.project}}"
    depends_on: [fetch-issue]
    prompt: |
      A GitHub issue needs to be fixed. Here is the issue data:

      {{nodes.fetch-issue.outputs.issue_json}}

      Steps:
      1. Create a new branch from the current branch (which is already on the base). Name format: fix/{{input.issue_id}}-<short-description> (e.g. fix/3-add-validation, fix/15-null-pointer). Any old branch for this issue has been cleaned up.
      2. Analyze the issue and fix the code.
      3. Stage and commit with a message referencing #{{input.issue_id}}.

      Base branch info: {{nodes.setup.outputs.info}}

      Additional context from user: {{input.extra_context}}
    outputs:
      - name: summary
        extract: result
      - name: diff
        extract: git_diff
  push-and-pr:
    mode: shell
    project: "{{input.project}}"
    depends_on: [fix-code]
    prompt: |
      REPO=$(echo '{{nodes.setup.outputs.info}}' | grep REPO= | cut -d= -f2) && \
      BRANCH=$(git branch --show-current) && \
      git push -u origin "$BRANCH" --force-with-lease 2>&1 && \
      PR_URL=$(gh pr create --title 'Fix #{{input.issue_id}}' \
        --body 'Auto-fix by Forge Pipeline for issue #{{input.issue_id}}.' -R "$REPO" 2>/dev/null || \
        gh pr view "$BRANCH" --json url -q .url -R "$REPO" 2>/dev/null) && \
      echo "$PR_URL"
    outputs:
      - name: pr_url
        extract: stdout
  review:
    project: "{{input.project}}"
    depends_on: [push-and-pr]
    prompt: |
      Review the code changes for issue #{{input.issue_id}}.

      Fix summary: {{nodes.fix-code.outputs.summary}}

      Git diff:
      {{nodes.fix-code.outputs.diff}}

      Check for:
      - Bugs and logic errors
      - Security vulnerabilities
      - Performance issues
      - Whether the fix actually addresses the issue

      Respond with:
      1. APPROVED or CHANGES_REQUESTED
      2. Specific issues found with file paths and line numbers
    outputs:
      - name: review_result
        extract: result
  cleanup:
    mode: shell
    project: "{{input.project}}"
    depends_on: [review]
    prompt: |
      ORIG=$(echo '{{nodes.setup.outputs.info}}' | grep ORIG_BRANCH= | cut -d= -f2) && \
      if [ -n "$(git status --porcelain)" ]; then
        echo "Issue #{{input.issue_id}} — PR: {{nodes.push-and-pr.outputs.pr_url}} | Review: {{nodes.review.outputs.review_result}} (staying on $(git branch --show-current))"
      else
        git checkout "$ORIG" 2>/dev/null || true
        echo "Issue #{{input.issue_id}} — PR: {{nodes.push-and-pr.outputs.pr_url}} | Review: {{nodes.review.outputs.review_result}} (switched back to $ORIG)"
      fi
    outputs:
      - name: result
        extract: stdout
`,
};

export interface WorkflowWithMeta extends Workflow {
  builtin?: boolean;
}

export function listWorkflows(): WorkflowWithMeta[] {
  // User workflows
  const userWorkflows: WorkflowWithMeta[] = [];
  if (existsSync(WORKFLOWS_DIR)) {
    for (const f of readdirSync(WORKFLOWS_DIR).filter(f => f.endsWith('.yaml') || f.endsWith('.yml'))) {
      try {
        userWorkflows.push({ ...parseWorkflow(readFileSync(join(WORKFLOWS_DIR, f), 'utf-8')), builtin: false });
      } catch {}
    }
  }

  // Built-in workflows (don't override user ones with same name)
  const userNames = new Set(userWorkflows.map(w => w.name));
  const builtins: WorkflowWithMeta[] = [];
  for (const [, yaml] of Object.entries(BUILTIN_WORKFLOWS)) {
    try {
      const w = parseWorkflow(yaml);
      if (!userNames.has(w.name)) {
        builtins.push({ ...w, builtin: true });
      }
    } catch {}
  }

  return [...builtins, ...userWorkflows];
}

export function getWorkflow(name: string): WorkflowWithMeta | null {
  return listWorkflows().find(w => w.name === name) || null;
}

function parseWorkflow(raw: string): Workflow {
  const parsed = YAML.parse(raw);
  const nodes: Record<string, WorkflowNode> = {};

  for (const [id, def] of Object.entries(parsed.nodes || {})) {
    const n = def as any;
    nodes[id] = {
      id,
      project: n.project || '',
      prompt: n.prompt || '',
      mode: n.mode || 'claude',
      branch: n.branch || undefined,
      dependsOn: n.depends_on || n.dependsOn || [],
      outputs: (n.outputs || []).map((o: any) => ({
        name: o.name,
        extract: o.extract || 'result',
      })),
      routes: (n.routes || []).map((r: any) => ({
        condition: r.condition || 'default',
        next: r.next,
      })),
      maxIterations: n.max_iterations || n.maxIterations || 3,
    };
  }

  return {
    name: parsed.name || 'unnamed',
    description: parsed.description,
    vars: parsed.vars || {},
    input: parsed.input || {},
    nodes,
  };
}

// ─── Pipeline Persistence ─────────────────────────────────

function ensureDir() {
  if (!existsSync(PIPELINES_DIR)) mkdirSync(PIPELINES_DIR, { recursive: true });
}

function savePipeline(pipeline: Pipeline) {
  ensureDir();
  writeFileSync(join(PIPELINES_DIR, `${pipeline.id}.json`), JSON.stringify(pipeline, null, 2));
}

export function getPipeline(id: string): Pipeline | null {
  try {
    return JSON.parse(readFileSync(join(PIPELINES_DIR, `${id}.json`), 'utf-8'));
  } catch {
    return null;
  }
}

export function deletePipeline(id: string): boolean {
  const filePath = join(PIPELINES_DIR, `${id}.json`);
  try {
    if (existsSync(filePath)) {
      const { unlinkSync } = require('node:fs');
      unlinkSync(filePath);
      return true;
    }
  } catch {}
  return false;
}

export function listPipelines(): Pipeline[] {
  ensureDir();
  return readdirSync(PIPELINES_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try {
        return JSON.parse(readFileSync(join(PIPELINES_DIR, f), 'utf-8')) as Pipeline;
      } catch {
        return null;
      }
    })
    .filter(Boolean) as Pipeline[];
}

// ─── Template Resolution ──────────────────────────────────

/** Escape a string for safe embedding in shell commands (single-quote wrapping) */
function shellEscape(s: string): string {
  // Replace single quotes with '\'' (end quote, escaped quote, start quote)
  return s.replace(/'/g, "'\\''");
}

function resolveTemplate(template: string, ctx: {
  input: Record<string, string>;
  vars: Record<string, string>;
  nodes: Record<string, PipelineNodeState>;
}, shellMode?: boolean): string {
  return template.replace(/\{\{(.*?)\}\}/g, (_, expr) => {
    const path = expr.trim();
    let value = '';

    // {{input.xxx}}
    if (path.startsWith('input.')) value = ctx.input[path.slice(6)] || '';
    // {{vars.xxx}}
    else if (path.startsWith('vars.')) value = ctx.vars[path.slice(5)] || '';
    // {{nodes.xxx.outputs.yyy}}
    else {
      const nodeMatch = path.match(/^nodes\.([\w-]+)\.outputs\.([\w-]+)$/);
      if (nodeMatch) {
        const [, nodeId, outputName] = nodeMatch;
        value = ctx.nodes[nodeId]?.outputs[outputName] || '';
      } else {
        return `{{${path}}}`;
      }
    }

    return shellMode ? shellEscape(value) : value;
  });
}

// ─── Project-level pipeline lock ─────────────────────────
const projectPipelineLocks = new Map<string, string>(); // projectPath → pipelineId

function acquireProjectLock(projectPath: string, pipelineId: string): boolean {
  const existing = projectPipelineLocks.get(projectPath);
  if (existing && existing !== pipelineId) {
    // Check if the existing pipeline is still running
    const p = getPipeline(existing);
    if (p && p.status === 'running') return false;
    // Stale lock, clear it
  }
  projectPipelineLocks.set(projectPath, pipelineId);
  return true;
}

function releaseProjectLock(projectPath: string, pipelineId: string) {
  if (projectPipelineLocks.get(projectPath) === pipelineId) {
    projectPipelineLocks.delete(projectPath);
  }
}

// ─── Pipeline Execution ───────────────────────────────────

export function startPipeline(workflowName: string, input: Record<string, string>): Pipeline {
  const workflow = getWorkflow(workflowName);
  if (!workflow) throw new Error(`Workflow not found: ${workflowName}`);

  const id = randomUUID().slice(0, 8);
  const nodes: Record<string, PipelineNodeState> = {};
  const nodeOrder = topologicalSort(workflow.nodes);

  for (const nodeId of nodeOrder) {
    nodes[nodeId] = {
      status: 'pending',
      outputs: {},
      iterations: 0,
    };
  }

  const pipeline: Pipeline = {
    id,
    workflowName,
    status: 'running',
    input,
    vars: { ...workflow.vars },
    nodes,
    nodeOrder,
    createdAt: new Date().toISOString(),
  };

  savePipeline(pipeline);

  // Start nodes that have no dependencies
  scheduleReadyNodes(pipeline, workflow);

  // Listen for task completions
  setupTaskListener(pipeline.id);

  return pipeline;
}

// ─── Recovery: check for stuck pipelines ──────────────────

function recoverStuckPipelines() {
  const pipelines = listPipelines().filter(p => p.status === 'running');
  for (const pipeline of pipelines) {
    const workflow = getWorkflow(pipeline.workflowName);
    if (!workflow) continue;

    let changed = false;
    for (const [nodeId, node] of Object.entries(pipeline.nodes)) {
      if (node.status === 'running' && node.taskId) {
        const task = getTask(node.taskId);
        if (!task) {
          // Task gone — mark node as done (task completed and was cleaned up)
          node.status = 'done';
          node.completedAt = new Date().toISOString();
          changed = true;
        } else if (task.status === 'done') {
          // Extract outputs
          const nodeDef = workflow.nodes[nodeId];
          if (nodeDef) {
            for (const outputDef of nodeDef.outputs) {
              if (outputDef.extract === 'result' || outputDef.extract === 'stdout') node.outputs[outputDef.name] = task.resultSummary || '';
              else if (outputDef.extract === 'git_diff') node.outputs[outputDef.name] = task.gitDiff || '';
            }
          }
          node.status = 'done';
          node.completedAt = new Date().toISOString();
          changed = true;
        } else if (task.status === 'failed' || task.status === 'cancelled') {
          node.status = 'failed';
          node.error = task.error || 'Task failed';
          node.completedAt = new Date().toISOString();
          changed = true;
        }
      }
    }

    if (changed) {
      savePipeline(pipeline);
      // Re-setup listener and schedule next nodes
      setupTaskListener(pipeline.id);
      scheduleReadyNodes(pipeline, workflow);
    }
  }
}

// Run recovery every 30 seconds
setInterval(recoverStuckPipelines, 30_000);
// Also run once on load
setTimeout(recoverStuckPipelines, 5000);

export function cancelPipeline(id: string): boolean {
  const pipeline = getPipeline(id);
  if (!pipeline || pipeline.status !== 'running') return false;

  pipeline.status = 'cancelled';
  pipeline.completedAt = new Date().toISOString();

  // Cancel all running tasks
  for (const [, node] of Object.entries(pipeline.nodes)) {
    if (node.status === 'running' && node.taskId) {
      const { cancelTask } = require('./task-manager');
      cancelTask(node.taskId);
    }
    if (node.status === 'pending') node.status = 'skipped';
  }

  savePipeline(pipeline);
  return true;
}

// ─── Node Scheduling ──────────────────────────────────────

function scheduleReadyNodes(pipeline: Pipeline, workflow: Workflow) {
  const ctx = { input: pipeline.input, vars: pipeline.vars, nodes: pipeline.nodes };

  for (const nodeId of pipeline.nodeOrder) {
    const nodeState = pipeline.nodes[nodeId];
    if (nodeState.status !== 'pending') continue;

    const nodeDef = workflow.nodes[nodeId];
    if (!nodeDef) continue;

    // Check all dependencies are done
    const depsReady = nodeDef.dependsOn.every(dep => {
      const depState = pipeline.nodes[dep];
      return depState && depState.status === 'done';
    });

    // Check if any dependency failed (skip this node)
    const depsFailed = nodeDef.dependsOn.some(dep => {
      const depState = pipeline.nodes[dep];
      return depState && (depState.status === 'failed' || depState.status === 'skipped');
    });

    if (depsFailed) {
      nodeState.status = 'skipped';
      savePipeline(pipeline);
      continue;
    }

    if (!depsReady) continue;

    // Resolve templates
    const isShell = nodeDef.mode === 'shell';
    const project = resolveTemplate(nodeDef.project, ctx);
    const prompt = resolveTemplate(nodeDef.prompt, ctx, isShell);

    const projectInfo = getProjectInfo(project);
    if (!projectInfo) {
      nodeState.status = 'failed';
      nodeState.error = `Project not found: ${project}`;
      savePipeline(pipeline);
      notifyStep(pipeline, nodeId, 'failed', nodeState.error);
      continue;
    }

    // Auto checkout branch if specified
    if (nodeDef.branch) {
      const branchName = resolveTemplate(nodeDef.branch, ctx);
      try {
        const { execSync } = require('node:child_process');
        // Create branch if not exists, or switch to it
        try {
          execSync(`git checkout -b ${branchName}`, { cwd: projectInfo.path, stdio: 'pipe' });
        } catch {
          execSync(`git checkout ${branchName}`, { cwd: projectInfo.path, stdio: 'pipe' });
        }
        console.log(`[pipeline] Checked out branch: ${branchName}`);
      } catch (e: any) {
        nodeState.status = 'failed';
        nodeState.error = `Branch checkout failed: ${e.message}`;
        savePipeline(pipeline);
        notifyStep(pipeline, nodeId, 'failed', nodeState.error);
        continue;
      }
    }

    // Create task — mode: 'shell' runs raw command, 'claude' runs claude -p
    const taskMode = nodeDef.mode === 'shell' ? 'shell' : 'prompt';
    const task = createTask({
      projectName: projectInfo.name,
      projectPath: projectInfo.path,
      prompt,
      mode: taskMode as any,
    });
    pipelineTaskIds.add(task.id);
    if (taskMode !== 'shell') {
      const pipelineModel = loadSettings().pipelineModel;
      if (pipelineModel && pipelineModel !== 'default') {
        taskModelOverrides.set(task.id, pipelineModel);
      }
    }

    nodeState.status = 'running';
    nodeState.taskId = task.id;
    nodeState.iterations++;
    nodeState.startedAt = new Date().toISOString();
    savePipeline(pipeline);

    notifyStep(pipeline, nodeId, 'running');
  }

  // Check if pipeline is complete
  checkPipelineCompletion(pipeline);
}

function checkPipelineCompletion(pipeline: Pipeline) {
  const states = Object.values(pipeline.nodes);
  const allDone = states.every(s => s.status === 'done' || s.status === 'skipped' || s.status === 'failed');

  if (allDone && pipeline.status === 'running') {
    const anyFailed = states.some(s => s.status === 'failed');
    pipeline.status = anyFailed ? 'failed' : 'done';
    pipeline.completedAt = new Date().toISOString();
    savePipeline(pipeline);
    notifyPipelineComplete(pipeline);

    // Sync run status to project pipeline runs
    try {
      const { syncRunStatus } = require('./pipeline-scheduler');
      syncRunStatus(pipeline.id);
    } catch {}

    // Release project lock
    const workflow = getWorkflow(pipeline.workflowName);
    if (workflow) {
      const projectNames = new Set(Object.values(workflow.nodes).map(n => n.project));
      for (const pName of projectNames) {
        const pInfo = getProjectInfo(resolveTemplate(pName, { input: pipeline.input, vars: pipeline.vars, nodes: pipeline.nodes }));
        if (pInfo) releaseProjectLock(pInfo.path, pipeline.id);
      }
    }
  }
}

// ─── Task Event Listener ──────────────────────────────────

const activeListeners = new Set<string>();

function setupTaskListener(pipelineId: string) {
  if (activeListeners.has(pipelineId)) return;
  activeListeners.add(pipelineId);

  const cleanup = onTaskEvent((taskId, event, data) => {
    if (event !== 'status') return;
    if (data !== 'done' && data !== 'failed') return;

    const pipeline = getPipeline(pipelineId);
    if (!pipeline || pipeline.status !== 'running') {
      cleanup();
      activeListeners.delete(pipelineId);
      return;
    }

    // Find the node for this task
    const nodeEntry = Object.entries(pipeline.nodes).find(([, n]) => n.taskId === taskId);
    if (!nodeEntry) return;

    const [nodeId, nodeState] = nodeEntry;
    const workflow = getWorkflow(pipeline.workflowName);
    if (!workflow) return;

    const nodeDef = workflow.nodes[nodeId];
    const task = getTask(taskId);

    if (data === 'done' && task) {
      // Extract outputs
      for (const outputDef of nodeDef.outputs) {
        if (outputDef.extract === 'result') {
          nodeState.outputs[outputDef.name] = task.resultSummary || '';
        } else if (outputDef.extract === 'stdout') {
          nodeState.outputs[outputDef.name] = task.resultSummary || '';
        } else if (outputDef.extract === 'git_diff') {
          nodeState.outputs[outputDef.name] = task.gitDiff || '';
        }
      }

      // Check routes for conditional next step
      if (nodeDef.routes.length > 0) {
        const nextNode = evaluateRoutes(nodeDef.routes, nodeState.outputs, pipeline);
        if (nextNode && nextNode !== nodeId) {
          // Route to next node — mark this as done
          nodeState.status = 'done';
          nodeState.completedAt = new Date().toISOString();
          // Reset next node to pending so it gets scheduled
          if (pipeline.nodes[nextNode] && pipeline.nodes[nextNode].status !== 'done') {
            pipeline.nodes[nextNode].status = 'pending';
          }
        } else if (nextNode === nodeId) {
          // Loop back — check iteration limit
          if (nodeState.iterations < nodeDef.maxIterations) {
            nodeState.status = 'pending';
            nodeState.taskId = undefined;
          } else {
            nodeState.status = 'done';
            nodeState.completedAt = new Date().toISOString();
          }
        } else {
          nodeState.status = 'done';
          nodeState.completedAt = new Date().toISOString();
        }
      } else {
        nodeState.status = 'done';
        nodeState.completedAt = new Date().toISOString();
      }

      savePipeline(pipeline);
      // No per-step done notification — only notify on start and failure
    } else if (data === 'failed') {
      nodeState.status = 'failed';
      nodeState.error = task?.error || 'Task failed';
      nodeState.completedAt = new Date().toISOString();
      savePipeline(pipeline);
      notifyStep(pipeline, nodeId, 'failed', nodeState.error);
    }

    // Schedule next ready nodes
    scheduleReadyNodes(pipeline, workflow);
  });
}

function evaluateRoutes(
  routes: { condition: string; next: string }[],
  outputs: Record<string, string>,
  pipeline: Pipeline
): string | null {
  for (const route of routes) {
    if (route.condition === 'default') return route.next;

    // Simple "contains" check: {{outputs.xxx contains 'YYY'}}
    const containsMatch = route.condition.match(/\{\{outputs\.(\w+)\s+contains\s+'([^']+)'\}\}/);
    if (containsMatch) {
      const [, outputName, keyword] = containsMatch;
      if (outputs[outputName]?.includes(keyword)) return route.next;
      continue;
    }

    // Default: treat as truthy check
    return route.next;
  }
  return null;
}

// ─── Topological Sort ─────────────────────────────────────

function topologicalSort(nodes: Record<string, WorkflowNode>): string[] {
  const sorted: string[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();

  function visit(id: string) {
    if (visited.has(id)) return;
    if (visiting.has(id)) return; // cycle — skip
    visiting.add(id);

    const node = nodes[id];
    if (node) {
      for (const dep of node.dependsOn) {
        visit(dep);
      }
      // Also add route targets
      for (const route of node.routes) {
        if (nodes[route.next] && !node.dependsOn.includes(route.next)) {
          // Don't visit route targets in topo sort to avoid cycles
        }
      }
    }

    visiting.delete(id);
    visited.add(id);
    sorted.push(id);
  }

  for (const id of Object.keys(nodes)) {
    visit(id);
  }

  return sorted;
}

// ─── Notifications ────────────────────────────────────────

async function notifyStep(pipeline: Pipeline, nodeId: string, status: string, error?: string) {
  const settings = loadSettings();
  if (!settings.telegramBotToken || !settings.telegramChatId) return;

  const icon = status === 'done' ? '✅' : status === 'failed' ? '❌' : status === 'running' ? '🔄' : '⏳';
  const msg = `${icon} Pipeline ${pipeline.id}/${nodeId}: ${status}${error ? `\n${error}` : ''}`;

  try {
    await fetch(`https://api.telegram.org/bot${settings.telegramBotToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: settings.telegramChatId.split(',')[0].trim(),
        text: msg,
        disable_web_page_preview: true,
      }),
    });
  } catch {}
}

async function notifyPipelineComplete(pipeline: Pipeline) {
  const settings = loadSettings();
  if (!settings.telegramBotToken || !settings.telegramChatId) return;

  const icon = pipeline.status === 'done' ? '🎉' : '💥';
  const nodes = Object.entries(pipeline.nodes)
    .map(([id, n]) => `  ${n.status === 'done' ? '✅' : n.status === 'failed' ? '❌' : '⏭'} ${id}`)
    .join('\n');

  const msg = `${icon} Pipeline ${pipeline.id} (${pipeline.workflowName}) ${pipeline.status}\n\n${nodes}`;

  try {
    await fetch(`https://api.telegram.org/bot${settings.telegramBotToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: settings.telegramChatId.split(',')[0].trim(),
        text: msg,
        disable_web_page_preview: true,
      }),
    });
  } catch {}
}
