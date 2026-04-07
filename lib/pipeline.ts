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
import { getAgent, listAgents } from './agents';
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
  mode?: 'claude' | 'shell' | 'plugin';  // default: 'claude', 'shell' runs command, 'plugin' runs plugin action
  agent?: string;              // agent ID (default: from settings)
  branch?: string;             // auto checkout this branch before running (supports templates)
  // Plugin mode fields
  plugin?: string;             // plugin ID (e.g., 'jenkins', 'docker')
  pluginAction?: string;       // action name (e.g., 'trigger', 'build'), defaults to plugin's defaultAction
  pluginParams?: Record<string, any>;  // per-use parameters
  pluginWait?: boolean;        // auto-run 'wait' action after main action
  dependsOn: string[];
  outputs: { name: string; extract: 'result' | 'git_diff' | 'stdout' | 'plugin' }[];
  routes: { condition: string; next: string }[];
  maxIterations: number;
}

// ─── Conversation Mode Types ──────────────────────────────

export interface ConversationAgent {
  id: string;           // logical ID within this conversation (e.g., 'architect', 'implementer')
  agent: string;        // agent registry ID (e.g., 'claude', 'codex', 'aider')
  role: string;         // system prompt / role description
  project?: string;     // project context (optional, defaults to workflow input.project)
}

export interface ConversationMessage {
  round: number;
  agentId: string;      // logical ID from ConversationAgent
  agentName: string;    // display name (resolved from registry)
  content: string;
  timestamp: string;
  taskId?: string;      // backing task ID
  status: 'pending' | 'running' | 'done' | 'failed';
}

export interface ConversationConfig {
  agents: ConversationAgent[];
  maxRounds: number;           // max back-and-forth rounds
  stopCondition?: string;      // e.g., "all agents say DONE", "any agent says DONE"
  initialPrompt: string;       // the seed prompt to kick off the conversation
  contextStrategy?: 'full' | 'window' | 'summary';  // how to pass history, default: 'summary'
  contextWindow?: number;      // for 'window'/'summary': how many recent messages to include in full (default: 4)
  maxContentLength?: number;   // truncate each message to this length (default: 3000)
}

// ─── Workflow ─────────────────────────────────────────────

export interface Workflow {
  name: string;
  type?: 'dag' | 'conversation';  // default: 'dag'
  description?: string;
  vars: Record<string, string>;
  input: Record<string, string>;  // required input fields
  nodes: Record<string, WorkflowNode>;
  // Conversation mode fields (only when type === 'conversation')
  conversation?: ConversationConfig;
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
  type?: 'dag' | 'conversation';  // default: 'dag'
  status: 'running' | 'done' | 'failed' | 'cancelled';
  input: Record<string, string>;
  vars: Record<string, string>;
  nodes: Record<string, PipelineNodeState>;
  nodeOrder: string[];  // for UI display
  createdAt: string;
  completedAt?: string;
  // Conversation mode state
  conversation?: {
    config: ConversationConfig;
    messages: ConversationMessage[];
    currentRound: number;
    currentAgentIndex: number;  // index into config.agents
  };
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
      BASE="{{input.base_branch}}" && \
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
      if [ -z "$ISSUE_ID" ]; then echo "__SKIP__ No issue_id provided" && exit 0; fi && \
      SETUP_INFO=$'{{nodes.setup.outputs.info}}' && \
      REPO=$(echo "$SETUP_INFO" | grep REPO= | cut -d= -f2) && \
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
      SETUP_INFO=$'{{nodes.setup.outputs.info}}' && \
      REPO=$(echo "$SETUP_INFO" | grep REPO= | cut -d= -f2) && \
      BRANCH=$(git branch --show-current) && \
      git push -u origin "$BRANCH" --force-with-lease 2>&1 && \
      PR_URL=$(gh pr create --title "Fix #{{input.issue_id}}" \
        --body "Auto-fix by Forge Pipeline for issue #{{input.issue_id}}." -R "$REPO" 2>/dev/null || \
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
      SETUP_INFO=$'{{nodes.setup.outputs.info}}' && \
      ORIG=$(echo "$SETUP_INFO" | grep ORIG_BRANCH= | cut -d= -f2) && \
      PR_URL=$'{{nodes.push-and-pr.outputs.pr_url}}' && \
      if [ -n "$(git status --porcelain)" ]; then
        echo "Issue #{{input.issue_id}} — PR: $PR_URL (staying on $(git branch --show-current))"
      else
        git checkout "$ORIG" 2>/dev/null || true
        echo "Issue #{{input.issue_id}} — PR: $PR_URL (switched back to $ORIG)"
      fi
    outputs:
      - name: result
        extract: stdout
`,
  'multi-agent-collaboration': `
name: multi-agent-collaboration
type: conversation
description: "Two agents collaborate: one designs, one implements"
input:
  project: "Project name"
  task: "What to build or fix"
agents:
  - id: architect
    agent: claude
    role: "You are a software architect. Round 1: design the solution with clear steps. Later rounds: review the implementation and say DONE if satisfied."
  - id: implementer
    agent: claude
    role: "You are a developer. Implement what the architect designs. After implementing, say DONE."
max_rounds: 3
stop_condition: "both agents say DONE"
initial_prompt: "Task: {{input.task}}"
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
  const workflowType = parsed.type || 'dag';
  const nodes: Record<string, WorkflowNode> = {};

  for (const [id, def] of Object.entries(parsed.nodes || {})) {
    const n = def as any;
    nodes[id] = {
      id,
      project: n.project || '',
      prompt: n.prompt || '',
      mode: n.mode || (n.plugin ? 'plugin' : 'claude'),
      agent: n.agent || undefined,
      branch: n.branch || undefined,
      plugin: n.plugin || undefined,
      pluginAction: n.plugin_action || n.pluginAction || undefined,
      pluginParams: n.plugin_params || n.pluginParams || n.params || undefined,
      pluginWait: n.plugin_wait || n.pluginWait || n.wait || false,
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

  // Parse conversation config
  let conversation: ConversationConfig | undefined;
  if (workflowType === 'conversation' && parsed.agents) {
    conversation = {
      agents: (parsed.agents as any[]).map((a: any) => ({
        id: a.id,
        agent: a.agent || 'claude',
        role: a.role || '',
        project: a.project || undefined,
      })),
      maxRounds: parsed.max_rounds || parsed.maxRounds || 10,
      stopCondition: parsed.stop_condition || parsed.stopCondition || undefined,
      initialPrompt: parsed.initial_prompt || parsed.initialPrompt || '',
      contextStrategy: parsed.context_strategy || parsed.contextStrategy || 'summary',
      contextWindow: parsed.context_window || parsed.contextWindow || 4,
      maxContentLength: parsed.max_content_length || parsed.maxContentLength || 3000,
    };
  }

  return {
    name: parsed.name || 'unnamed',
    type: workflowType,
    description: parsed.description,
    vars: parsed.vars || {},
    input: parsed.input || {},
    nodes,
    conversation,
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

/** Escape a string for safe embedding in single-quoted shell strings */
function shellEscape(s: string): string {
  // Replace single quotes with '\'' (end quote, escaped quote, start quote)
  return s.replace(/'/g, "'\\''");
}

/** Escape a string for safe embedding in $'...' shell strings (ANSI-C quoting) */
function shellEscapeAnsiC(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
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

    return shellMode ? shellEscapeAnsiC(value) : value;
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

  // Conversation mode — separate execution path
  if (workflow.type === 'conversation' && workflow.conversation) {
    return startConversationPipeline(workflow, input);
  }

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

// ─── Conversation State Type (extracted to avoid Turbopack parse issues) ──
type ConversationState = {
  config: ConversationConfig;
  messages: ConversationMessage[];
  currentRound: number;
  currentAgentIndex: number;
};

// ─── Conversation Mode Execution ──────────────────────────

function startConversationPipeline(workflow: Workflow, input: Record<string, string>): Pipeline {
  const conv = workflow.conversation!;
  const id = randomUUID().slice(0, 8);

  // Resolve agent display names
  const agentNames: Record<string, string> = {};
  const allAgents = listAgents();
  for (const ca of conv.agents) {
    const found = allAgents.find(a => a.id === ca.agent);
    agentNames[ca.id] = found?.name || ca.agent;
  }

  const pipeline: Pipeline = {
    id,
    workflowName: workflow.name,
    type: 'conversation',
    status: 'running',
    input,
    vars: { ...workflow.vars },
    nodes: {},
    nodeOrder: [],
    createdAt: new Date().toISOString(),
    conversation: {
      config: {
        ...conv,
        // Store resolved initial prompt so buildConversationContext uses it
        initialPrompt: conv.initialPrompt.replace(/\{\{input\.(\w+)\}\}/g, (_, key) => input[key] || ''),
      },
      messages: [],
      currentRound: 1,
      currentAgentIndex: 0,
    },
  };

  savePipeline(pipeline);

  const resolvedPrompt = pipeline.conversation!.config.initialPrompt;

  // Start the first round
  scheduleNextConversationTurn(pipeline, resolvedPrompt, agentNames);

  return pipeline;
}

function scheduleNextConversationTurn(pipeline: Pipeline, contextForAgent: string, agentNames?: Record<string, string>) {
  const conv = pipeline.conversation!;
  const config = conv.config;
  const agentDef = config.agents[conv.currentAgentIndex];

  if (!agentDef) {
    pipeline.status = 'failed';
    pipeline.completedAt = new Date().toISOString();
    savePipeline(pipeline);
    return;
  }

  // Resolve project
  const projectName = agentDef.project || pipeline.input.project || '';
  const projectInfo = getProjectInfo(projectName);
  if (!projectInfo) {
    pipeline.status = 'failed';
    pipeline.completedAt = new Date().toISOString();
    savePipeline(pipeline);
    notifyPipelineComplete(pipeline);
    return;
  }

  // Build the prompt: role context + conversation history + new message
  const rolePrefix = agentDef.role ? `[Your role: ${agentDef.role}]\n\n` : '';
  const fullPrompt = `${rolePrefix}${contextForAgent}`;

  // Create a task for this agent's turn
  const task = createTask({
    projectName: projectInfo.name,
    projectPath: projectInfo.path,
    prompt: fullPrompt,
    mode: 'prompt',
    agent: agentDef.agent,
    conversationId: '', // fresh session — no resume for conversation mode
  });
  pipelineTaskIds.add(task.id);

  // Add pending message
  const names = agentNames || resolveAgentNames(config.agents);
  conv.messages.push({
    round: conv.currentRound,
    agentId: agentDef.id,
    agentName: names[agentDef.id] || agentDef.agent,
    content: '',
    timestamp: new Date().toISOString(),
    taskId: task.id,
    status: 'running',
  });

  savePipeline(pipeline);

  // Listen for this task to complete
  setupConversationTaskListener(pipeline.id, task.id);
}

function resolveAgentNames(agents: ConversationAgent[]): Record<string, string> {
  const allAgents = listAgents();
  const names: Record<string, string> = {};
  for (const ca of agents) {
    const found = allAgents.find(a => a.id === ca.agent);
    names[ca.id] = found?.name || ca.agent;
  }
  return names;
}

function setupConversationTaskListener(pipelineId: string, taskId: string) {
  const cleanup = onTaskEvent((evtTaskId, event, data) => {
    if (evtTaskId !== taskId) return;
    if (event !== 'status') return;
    if (data !== 'done' && data !== 'failed') return;

    cleanup(); // one-shot listener

    const pipeline = getPipeline(pipelineId);
    if (!pipeline || pipeline.status !== 'running' || !pipeline.conversation) return;

    const conv = pipeline.conversation;
    const config = conv.config;
    const msgIndex = conv.messages.findIndex(m => m.taskId === taskId);
    if (msgIndex < 0) return;

    const task = getTask(taskId);

    if (data === 'failed' || !task) {
      conv.messages[msgIndex].status = 'failed';
      conv.messages[msgIndex].content = task?.error || 'Task failed';
      pipeline.status = 'failed';
      pipeline.completedAt = new Date().toISOString();
      savePipeline(pipeline);
      notifyPipelineComplete(pipeline);
      return;
    }

    // Task completed — extract response
    const response = task.resultSummary || '';
    conv.messages[msgIndex].status = 'done';
    conv.messages[msgIndex].content = response;

    // Check stop condition
    if (checkConversationStopCondition(conv, response)) {
      finishConversation(pipeline, 'done');
      return;
    }

    // Move to next agent in round, or next round
    conv.currentAgentIndex++;
    if (conv.currentAgentIndex >= config.agents.length) {
      // Completed a full round
      conv.currentAgentIndex = 0;
      conv.currentRound++;

      if (conv.currentRound > config.maxRounds) {
        finishConversation(pipeline, 'done');
        return;
      }
    }

    savePipeline(pipeline);

    // Build context for next agent: accumulate conversation history
    const contextForNext = buildConversationContext(conv);
    scheduleNextConversationTurn(pipeline, contextForNext);
  });
}

/**
 * Build context string for the next agent in conversation.
 *
 * Three strategies:
 *   - 'full'    : pass ALL history as-is (token-heavy, good for short convos)
 *   - 'window'  : pass only the last N messages in full, drop older ones
 *   - 'summary' : pass older messages as one-line summaries + last N in full (default)
 */
function buildConversationContext(conv: ConversationState): string {
  const config = conv.config;
  const strategy = config.contextStrategy || 'summary';
  const windowSize = config.contextWindow || 4;
  const maxLen = config.maxContentLength || 3000;

  const doneMessages = conv.messages.filter(m => m.status === 'done' && m.content);

  let context = `[Conversation — Round ${conv.currentRound}]\n\n`;
  context += `Task: ${config.initialPrompt}\n\n`;

  if (doneMessages.length === 0) {
    context += `--- Your Turn ---\nYou are the first to respond. Please address the task above. If you believe the task is complete, include "DONE" in your response.`;
    return context;
  }

  context += `--- Conversation History ---\n\n`;

  if (strategy === 'full') {
    // Full: all messages, truncated per maxLen
    for (const msg of doneMessages) {
      context += formatMessage(msg, config, maxLen);
    }
  } else if (strategy === 'window') {
    // Window: only last N messages
    const recent = doneMessages.slice(-windowSize);
    if (doneMessages.length > windowSize) {
      context += `[... ${doneMessages.length - windowSize} earlier messages omitted ...]\n\n`;
    }
    for (const msg of recent) {
      context += formatMessage(msg, config, maxLen);
    }
  } else {
    // Summary (default): older messages as one-line summaries, recent in full
    const cutoff = doneMessages.length - windowSize;
    if (cutoff > 0) {
      context += `[Previous rounds summary]\n`;
      for (let i = 0; i < cutoff; i++) {
        const msg = doneMessages[i];
        const summary = extractSummaryLine(msg.content);
        context += `  R${msg.round} ${msg.agentName}: ${summary}\n`;
      }
      context += `\n`;
    }
    // Recent messages in full
    const recent = doneMessages.slice(Math.max(0, cutoff));
    for (const msg of recent) {
      context += formatMessage(msg, config, maxLen);
    }
  }

  context += `--- Your Turn ---\nRespond based on the conversation above. If you believe the task is complete, include "DONE" in your response.`;
  return context;
}

function formatMessage(msg: ConversationMessage, config: ConversationConfig, maxLen: number): string {
  const agentDef = config.agents.find(a => a.id === msg.agentId);
  const label = `${msg.agentName} (${agentDef?.id || '?'})`;
  const content = msg.content.length > maxLen
    ? msg.content.slice(0, maxLen) + '\n[... truncated]'
    : msg.content;
  return `[${label} — Round ${msg.round}]:\n${content}\n\n`;
}

/** Extract a one-line summary from agent output (first meaningful line or first 120 chars) */
function extractSummaryLine(content: string): string {
  const lines = content.split('\n').map(l => l.trim()).filter(l => l.length > 10);
  const first = lines[0] || content.slice(0, 120);
  return first.length > 120 ? first.slice(0, 117) + '...' : first;
}

function checkConversationStopCondition(conv: ConversationState, latestResponse: string): boolean {
  const condition = conv.config.stopCondition;
  if (!condition) return false;

  const lower = condition.toLowerCase();

  // "any agent says DONE"
  if (lower.includes('any') && lower.includes('done')) {
    return latestResponse.toUpperCase().includes('DONE');
  }

  // "all agents say DONE" / "both agents say DONE"
  if ((lower.includes('all') || lower.includes('both')) && lower.includes('done')) {
    // Only check messages from the CURRENT round — don't mix rounds
    const currentRound = conv.currentRound;
    const agentIds = conv.config.agents.map(a => a.id);
    const roundMessages = new Map<string, string>();
    for (const msg of conv.messages) {
      if (msg.status === 'done' && msg.round === currentRound && msg.agentId !== 'user') {
        roundMessages.set(msg.agentId, msg.content);
      }
    }
    // All agents in this round must have responded AND said DONE
    return agentIds.every(id => {
      const content = roundMessages.get(id);
      return content && content.toUpperCase().includes('DONE');
    });
  }

  // Default: check if latest response contains DONE
  return latestResponse.toUpperCase().includes('DONE');
}

/** Cleanly finish a conversation — cancel any still-running tasks, mark messages */
function finishConversation(pipeline: Pipeline, status: 'done' | 'failed') {
  const conv = pipeline.conversation!;
  for (const msg of conv.messages) {
    if (msg.status === 'running' && msg.taskId) {
      // Cancel the running task
      try { const { cancelTask } = require('./task-manager'); cancelTask(msg.taskId); } catch {}
      msg.status = status === 'done' ? 'done' : 'failed';
      if (!msg.content) msg.content = status === 'done' ? '(conversation ended)' : '(conversation failed)';
    }
    if (msg.status === 'pending') {
      msg.status = 'failed';
    }
  }
  pipeline.status = status;
  pipeline.completedAt = new Date().toISOString();
  savePipeline(pipeline);
  notifyPipelineComplete(pipeline);
}

/** Cancel a conversation pipeline */
export function cancelConversation(pipelineId: string): boolean {
  const pipeline = getPipeline(pipelineId);
  if (!pipeline || pipeline.status !== 'running' || !pipeline.conversation) return false;

  // Cancel any running task
  for (const msg of pipeline.conversation.messages) {
    if (msg.status === 'running' && msg.taskId) {
      const { cancelTask } = require('./task-manager');
      cancelTask(msg.taskId);
    }
    if (msg.status === 'pending') msg.status = 'failed';
  }

  pipeline.status = 'cancelled';
  pipeline.completedAt = new Date().toISOString();
  savePipeline(pipeline);
  return true;
}

/**
 * Inject a user message into a running conversation.
 * Waits for current agent to finish, then sends the injected message
 * as additional context to the specified agent on the next turn.
 */
export function injectConversationMessage(pipelineId: string, targetAgentId: string, message: string): boolean {
  const pipeline = getPipeline(pipelineId);
  if (!pipeline || pipeline.status !== 'running' || !pipeline.conversation) {
    throw new Error('Pipeline not running or not a conversation');
  }

  const conv = pipeline.conversation;
  const agentDef = conv.config.agents.find(a => a.id === targetAgentId);
  if (!agentDef) throw new Error(`Agent not found: ${targetAgentId}`);

  // Add a "user" message to the conversation
  conv.messages.push({
    round: conv.currentRound,
    agentId: 'user',
    agentName: 'Operator',
    content: `[@${targetAgentId}] ${message}`,
    timestamp: new Date().toISOString(),
    status: 'done',
  });

  savePipeline(pipeline);

  // If no agent is currently running, immediately schedule the target agent
  const hasRunning = conv.messages.some(m => m.status === 'running');
  if (!hasRunning) {
    // Point to the target agent for next turn
    const targetIdx = conv.config.agents.findIndex(a => a.id === targetAgentId);
    if (targetIdx >= 0) {
      conv.currentAgentIndex = targetIdx;
      savePipeline(pipeline);
      const context = buildConversationContext(conv);
      scheduleNextConversationTurn(pipeline, context);
    }
  }
  // If an agent IS running, the injected message will be included in the next context build

  return true;
}

// ─── Conversation Recovery ────────────────────────────────

function recoverConversationPipeline(pipeline: Pipeline) {
  const conv = pipeline.conversation!;
  const runningMsg = conv.messages.find(m => m.status === 'running');
  if (!runningMsg || !runningMsg.taskId) return;

  const task = getTask(runningMsg.taskId);
  if (!task) {
    // Task gone — mark as done with empty content, try next turn
    runningMsg.status = 'done';
    runningMsg.content = '(no response — task was cleaned up)';
    savePipeline(pipeline);
    advanceConversation(pipeline);
    return;
  }
  if (task.status === 'done') {
    runningMsg.status = 'done';
    runningMsg.content = task.resultSummary || '';
    savePipeline(pipeline);
    advanceConversation(pipeline);
  } else if (task.status === 'failed' || task.status === 'cancelled') {
    runningMsg.status = 'failed';
    runningMsg.content = task.error || 'Task failed';
    pipeline.status = 'failed';
    pipeline.completedAt = new Date().toISOString();
    savePipeline(pipeline);
  } else {
    // Still running — re-attach listener
    setupConversationTaskListener(pipeline.id, runningMsg.taskId);
  }
}

function advanceConversation(pipeline: Pipeline) {
  const conv = pipeline.conversation!;
  const config = conv.config;
  const lastDoneMsg = [...conv.messages].reverse().find(m => m.status === 'done');

  if (lastDoneMsg && checkConversationStopCondition(conv, lastDoneMsg.content)) {
    finishConversation(pipeline, 'done');
    return;
  }

  conv.currentAgentIndex++;
  if (conv.currentAgentIndex >= config.agents.length) {
    conv.currentAgentIndex = 0;
    conv.currentRound++;
    if (conv.currentRound > config.maxRounds) {
      finishConversation(pipeline, 'done');
      return;
    }
  }

  savePipeline(pipeline);
  const contextForNext = buildConversationContext(conv);
  scheduleNextConversationTurn(pipeline, contextForNext);
}

// ─── Recovery: check for stuck pipelines ──────────────────

function recoverStuckPipelines() {
  const pipelines = listPipelines().filter(p => p.status === 'running');
  for (const pipeline of pipelines) {
    // Conversation mode recovery
    if (pipeline.type === 'conversation' && pipeline.conversation) {
      recoverConversationPipeline(pipeline);
      continue;
    }

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

  // Conversation mode
  if (pipeline.type === 'conversation') {
    return cancelConversation(id);
  }

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

async function scheduleReadyNodes(pipeline: Pipeline, workflow: Workflow) {
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

    // All pipeline steps run in git worktree for isolated execution.
    // This ensures the user's working directory is never affected,
    // and avoids "uncommitted changes" conflicts.
    let effectivePath = projectInfo.path;
    const branchName = nodeDef.branch ? resolveTemplate(nodeDef.branch, ctx) : `pipeline/${pipeline.id.slice(0, 8)}`;
    try {
      const { execSync } = require('node:child_process');
      const worktreePath = `${projectInfo.path}/.forge/worktrees/${branchName.replace(/\//g, '-')}`;
      const { mkdirSync } = require('node:fs');
      mkdirSync(`${projectInfo.path}/.forge/worktrees`, { recursive: true });

      // Create branch if needed
      try { execSync(`git branch ${branchName}`, { cwd: projectInfo.path, stdio: 'pipe' }); } catch {}

      // Create or reuse worktree
      try {
        execSync(`git worktree add "${worktreePath}" ${branchName}`, { cwd: projectInfo.path, stdio: 'pipe' });
        console.log(`[pipeline] Created worktree: ${worktreePath} (branch: ${branchName})`);
      } catch {
        const { existsSync } = require('node:fs');
        if (existsSync(worktreePath)) {
          console.log(`[pipeline] Reusing worktree: ${worktreePath}`);
        } else {
          try { execSync(`git worktree remove "${worktreePath}" --force`, { cwd: projectInfo.path, stdio: 'pipe' }); } catch {}
          execSync(`git worktree add "${worktreePath}" ${branchName}`, { cwd: projectInfo.path, stdio: 'pipe' });
          console.log(`[pipeline] Recreated worktree: ${worktreePath}`);
        }
      }

      effectivePath = worktreePath;
      (nodeState as any).worktreePath = worktreePath;
      (nodeState as any).worktreeBranch = branchName;
    } catch (e: any) {
      console.warn(`[pipeline] Worktree creation failed, falling back to project dir: ${e.message}`);
    }

    // ── Plugin mode: execute plugin action directly ──
    if (nodeDef.mode === 'plugin' && nodeDef.plugin) {
      nodeState.status = 'running';
      nodeState.startedAt = new Date().toISOString();
      savePipeline(pipeline);
      notifyStep(pipeline, nodeId, 'running');

      try {
        const { getInstalledPlugin } = await import('./plugins/registry');
        const { executePluginWithWait } = await import('./plugins/executor');

        const inst = getInstalledPlugin(nodeDef.plugin);
        if (!inst) throw new Error(`Plugin "${nodeDef.plugin}" not installed`);
        if (!inst.enabled) throw new Error(`Plugin "${nodeDef.plugin}" is disabled`);

        // Resolve template params
        const resolvedParams: Record<string, any> = {};
        for (const [k, v] of Object.entries(nodeDef.pluginParams || {})) {
          resolvedParams[k] = typeof v === 'string' ? resolveTemplate(v, ctx) : v;
        }

        const actionName = nodeDef.pluginAction || inst.definition.defaultAction || Object.keys(inst.definition.actions)[0];
        const result = await executePluginWithWait(inst, actionName, resolvedParams, nodeDef.pluginWait);

        if (result.ok) {
          nodeState.status = 'done';
          nodeState.completedAt = new Date().toISOString();
          // Store plugin outputs
          for (const [name, value] of Object.entries(result.output)) {
            nodeState.outputs[name] = typeof value === 'string' ? value : JSON.stringify(value);
          }
          savePipeline(pipeline);
          notifyStep(pipeline, nodeId, 'done');
          console.log(`[pipeline] Plugin ${nodeDef.plugin}.${actionName}: done (${result.duration}ms)`);
        } else {
          throw new Error(result.error || 'Plugin action failed');
        }
      } catch (err: any) {
        nodeState.status = 'failed';
        nodeState.error = err.message;
        nodeState.completedAt = new Date().toISOString();
        savePipeline(pipeline);
        notifyStep(pipeline, nodeId, 'failed', err.message);
        console.error(`[pipeline] Plugin ${nodeDef.plugin}: failed — ${err.message}`);
      }
      continue;
    }

    // ── Shell/Agent mode: create task ──
    const taskMode = nodeDef.mode === 'shell' ? 'shell' : 'prompt';
    const task = createTask({
      projectName: projectInfo.name,
      projectPath: effectivePath,
      prompt,
      mode: taskMode as any,
      agent: nodeDef.agent || undefined,
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

    // Log worktree info for user review
    for (const [nodeId, state] of Object.entries(pipeline.nodes)) {
      const wt = (state as any).worktreePath;
      const branch = (state as any).worktreeBranch;
      if (wt && branch) {
        console.log(`[pipeline] Worktree preserved: ${wt} (branch: ${branch}) — review changes, then: git worktree remove "${wt}"`);
      }
    }

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

      // Convention: if stdout contains __SKIP__, mark node as skipped (downstream nodes will also skip)
      const outputStr = task.resultSummary || '';
      if (outputStr.includes('__SKIP__')) {
        nodeState.status = 'skipped';
        nodeState.completedAt = new Date().toISOString();
        savePipeline(pipeline);
        scheduleReadyNodes(pipeline, workflow);
        checkPipelineCompletion(pipeline);
        return;
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
