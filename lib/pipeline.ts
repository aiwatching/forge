/**
 * Pipeline Engine — DAG-based workflow orchestration on top of the Task system.
 *
 * Workflow YAML → Pipeline instance → Nodes executed as Tasks
 * Supports: dependencies, output passing, conditional routing, parallel execution, notifications.
 */

import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import YAML from 'yaml';
import { createTask, getTask, onTaskEvent } from './task-manager';
import { getProjectInfo } from './projects';
import { loadSettings } from './settings';
import type { Task } from '@/src/types';

const PIPELINES_DIR = join(homedir(), '.forge', 'pipelines');
const WORKFLOWS_DIR = join(homedir(), '.forge', 'flows');

// ─── Types ────────────────────────────────────────────────

export interface WorkflowNode {
  id: string;
  project: string;
  prompt: string;
  dependsOn: string[];
  outputs: { name: string; extract: 'result' | 'git_diff' }[];
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

export function listWorkflows(): Workflow[] {
  if (!existsSync(WORKFLOWS_DIR)) return [];
  return readdirSync(WORKFLOWS_DIR)
    .filter(f => f.endsWith('.yaml') || f.endsWith('.yml'))
    .map(f => {
      try {
        return parseWorkflow(readFileSync(join(WORKFLOWS_DIR, f), 'utf-8'));
      } catch {
        return null;
      }
    })
    .filter(Boolean) as Workflow[];
}

export function getWorkflow(name: string): Workflow | null {
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

function resolveTemplate(template: string, ctx: {
  input: Record<string, string>;
  vars: Record<string, string>;
  nodes: Record<string, PipelineNodeState>;
}): string {
  return template.replace(/\{\{(.*?)\}\}/g, (_, expr) => {
    const path = expr.trim();

    // {{input.xxx}}
    if (path.startsWith('input.')) return ctx.input[path.slice(6)] || '';

    // {{vars.xxx}}
    if (path.startsWith('vars.')) return ctx.vars[path.slice(5)] || '';

    // {{nodes.xxx.outputs.yyy}}
    const nodeMatch = path.match(/^nodes\.(\w+)\.outputs\.(\w+)$/);
    if (nodeMatch) {
      const [, nodeId, outputName] = nodeMatch;
      return ctx.nodes[nodeId]?.outputs[outputName] || '';
    }

    return `{{${path}}}`;
  });
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
    const project = resolveTemplate(nodeDef.project, ctx);
    const prompt = resolveTemplate(nodeDef.prompt, ctx);

    const projectInfo = getProjectInfo(project);
    if (!projectInfo) {
      nodeState.status = 'failed';
      nodeState.error = `Project not found: ${project}`;
      savePipeline(pipeline);
      notifyStep(pipeline, nodeId, 'failed', nodeState.error);
      continue;
    }

    // Create task
    const task = createTask({
      projectName: projectInfo.name,
      projectPath: projectInfo.path,
      prompt,
    });

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
      notifyStep(pipeline, nodeId, 'done');
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
