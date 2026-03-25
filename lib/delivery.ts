/**
 * Delivery Engine — multi-agent orchestrated software delivery.
 *
 * Phases: Analyze → Implement → Test → Review
 * Each phase runs as one or more Tasks via the existing task system.
 * Artifacts (structured documents) pass between phases.
 * Completely independent from the pipeline system.
 */

import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createTask, getTask, onTaskEvent } from './task-manager';
import { getProjectInfo } from './projects';
import { loadSettings } from './settings';
import { createArtifact, listArtifacts, extractArtifacts, writeArtifactToProject } from './artifacts';
import type { Artifact, ArtifactType } from './artifacts';
import { getDataDir } from './dirs';

const DELIVERIES_DIR = join(getDataDir(), 'deliveries');

function ensureDir() {
  if (!existsSync(DELIVERIES_DIR)) mkdirSync(DELIVERIES_DIR, { recursive: true });
}

// ─── Types ────────────────────────────────────────────────

export type PhaseName = 'analyze' | 'implement' | 'test' | 'review';
export type PhaseStatus = 'pending' | 'waiting_human' | 'running' | 'done' | 'failed' | 'skipped';

export interface DeliveryPhase {
  name: PhaseName;
  status: PhaseStatus;
  agentRole: string;
  agentId: string;       // agent registry ID
  taskIds: string[];
  inputArtifactTypes: ArtifactType[];  // which artifact types this phase consumes
  outputArtifactIds: string[];
  startedAt?: string;
  completedAt?: string;
  error?: string;
  interactions: { from: string; message: string; taskId?: string; timestamp: string }[];
  // Custom metadata (from user-defined phases)
  _waitForHuman?: boolean;
  _label?: string;
  _icon?: string;
  _outputArtifactName?: string;
  _outputArtifactType?: ArtifactType;
}

export interface Delivery {
  id: string;
  title: string;
  status: 'running' | 'paused' | 'done' | 'failed' | 'cancelled';
  input: {
    prUrl?: string;
    description?: string;
    project: string;
    projectPath: string;
  };
  phases: DeliveryPhase[];
  currentPhaseIndex: number;
  createdAt: string;
  completedAt?: string;
}

// ─── Persistence ──────────────────────────────────────────

function deliveryPath(id: string): string {
  return join(DELIVERIES_DIR, id, 'delivery.json');
}

function saveDelivery(d: Delivery): void {
  ensureDir();
  const dir = join(DELIVERIES_DIR, d.id);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(deliveryPath(d.id), JSON.stringify(d, null, 2));
}

export function getDelivery(id: string): Delivery | null {
  try {
    return JSON.parse(readFileSync(deliveryPath(id), 'utf-8'));
  } catch { return null; }
}

export function listDeliveries(): Delivery[] {
  ensureDir();
  const dirs = readdirSync(DELIVERIES_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);

  return dirs
    .map(id => getDelivery(id))
    .filter(Boolean)
    .sort((a, b) => b!.createdAt.localeCompare(a!.createdAt)) as Delivery[];
}

export function deleteDelivery(id: string): boolean {
  const dir = join(DELIVERIES_DIR, id);
  if (!existsSync(dir)) return false;
  try { rmSync(dir, { recursive: true }); return true; } catch { return false; }
}

// ─── Default Phase Configs ────────────────────────────────

const DEFAULT_PHASES: Omit<DeliveryPhase, 'agentId'>[] = [
  {
    name: 'analyze',
    status: 'pending',
    agentRole: `You are a Product Manager. Analyze the requirements and produce a structured requirements document.

Your tasks:
1. Read the input (PR, description, or project code)
2. Break down into clear functional requirements
3. Identify edge cases and dependencies
4. Output the requirements document

Output your analysis between artifact markers:
===ARTIFACT:requirements.md===
# Requirements
## Overview
...
## Functional Requirements
1. ...
## Edge Cases
...
===ARTIFACT:requirements.md===`,
    taskIds: [],
    inputArtifactTypes: [],
    outputArtifactIds: [],
    interactions: [],
  },
  {
    name: 'implement',
    status: 'pending',
    agentRole: `You are a Senior Software Engineer. Based on the requirements, design the architecture and implement the solution.

Your tasks:
1. Read the requirements document
2. Design the architecture (modules, interfaces, data flow)
3. Implement each module
4. Commit your changes

Output your architecture document between artifact markers:
===ARTIFACT:architecture.md===
# Architecture Design
## Overview
...
## Modules
...
## Implementation Notes
...
===ARTIFACT:architecture.md===`,
    taskIds: [],
    inputArtifactTypes: ['requirements'],
    outputArtifactIds: [],
    interactions: [],
  },
  {
    name: 'test',
    status: 'pending',
    agentRole: `You are a QA Engineer. Based on the requirements and architecture, design and run tests.

Your tasks:
1. Read the requirements and architecture documents
2. Design test cases covering all requirements
3. Write and run the tests
4. Report results

Output your test plan between artifact markers:
===ARTIFACT:test-plan.md===
# Test Plan
## Test Cases
1. ...
## Results
...
===ARTIFACT:test-plan.md===`,
    taskIds: [],
    inputArtifactTypes: ['requirements', 'architecture'],
    outputArtifactIds: [],
    interactions: [],
  },
  {
    name: 'review',
    status: 'pending',
    agentRole: `You are a Code Reviewer. Review the entire delivery: requirements, architecture, implementation, and test results.

Your tasks:
1. Read all artifacts from previous phases
2. Review code changes (git diff)
3. Check if requirements are met
4. Check test coverage
5. Approve or request changes

Output your review between artifact markers:
===ARTIFACT:review-report.md===
# Review Report
## Status: APPROVED / CHANGES_REQUESTED
## Findings
...
## Verdict
...
===ARTIFACT:review-report.md===`,
    taskIds: [],
    inputArtifactTypes: ['requirements', 'architecture', 'test-plan', 'code-diff'],
    outputArtifactIds: [],
    interactions: [],
  },
];

// ─── Role Presets ─────────────────────────────────────────

export interface RolePreset {
  id: string;
  label: string;
  icon: string;
  role: string;
  inputArtifactTypes: ArtifactType[];
  outputArtifactName: string;
  outputArtifactType: ArtifactType;
  waitForHuman?: boolean;  // pause after completion for approval
}

export const ROLE_PRESETS: RolePreset[] = [
  {
    id: 'pm', label: 'PM - Analyze', icon: '📋',
    role: 'You are a Product Manager. Analyze the requirements, break down into modules, identify edge cases.',
    inputArtifactTypes: [],
    outputArtifactName: 'requirements.md', outputArtifactType: 'requirements',
    waitForHuman: true,
  },
  {
    id: 'engineer', label: 'Engineer - Implement', icon: '🔨',
    role: 'You are a Senior Engineer. Design the architecture and implement the solution based on the requirements.',
    inputArtifactTypes: ['requirements'],
    outputArtifactName: 'architecture.md', outputArtifactType: 'architecture',
  },
  {
    id: 'qa', label: 'QA - Test', icon: '🧪',
    role: 'You are a QA Engineer. Design test cases from the requirements and architecture, then run them.',
    inputArtifactTypes: ['requirements', 'architecture'],
    outputArtifactName: 'test-plan.md', outputArtifactType: 'test-plan',
  },
  {
    id: 'reviewer', label: 'Reviewer', icon: '🔍',
    role: 'You are a Code Reviewer. Review all artifacts, check code quality, approve or request changes.',
    inputArtifactTypes: ['requirements', 'architecture', 'test-plan', 'code-diff'],
    outputArtifactName: 'review-report.md', outputArtifactType: 'review-report',
  },
  {
    id: 'devops', label: 'DevOps - Deploy', icon: '🚀',
    role: 'You are a DevOps engineer. Set up CI/CD, deployment configs, and infrastructure.',
    inputArtifactTypes: ['architecture'],
    outputArtifactName: 'deploy-plan.md', outputArtifactType: 'custom',
  },
  {
    id: 'security', label: 'Security Audit', icon: '🔒',
    role: 'You are a security auditor. Review code for vulnerabilities, check OWASP top 10, suggest fixes.',
    inputArtifactTypes: ['architecture', 'code-diff'],
    outputArtifactName: 'security-report.md', outputArtifactType: 'review-report',
  },
  {
    id: 'docs', label: 'Tech Writer - Docs', icon: '📝',
    role: 'You are a technical writer. Write API documentation, README updates, and user guides based on the implementation.',
    inputArtifactTypes: ['requirements', 'architecture'],
    outputArtifactName: 'documentation.md', outputArtifactType: 'custom',
  },
];

function buildPhasePrompt(p: PhaseInput): string {
  let prompt = p.role;
  prompt += `\n\nOutput your result between artifact markers:\n===ARTIFACT:${p.outputArtifactName}===\n(your output here)\n===ARTIFACT:${p.outputArtifactName}===`;
  return prompt;
}

/** User-defined phase input for creating a delivery */
export interface PhaseInput {
  name: string;         // unique id within this delivery
  label: string;
  icon: string;
  role: string;
  agentId: string;
  inputArtifactTypes: ArtifactType[];
  outputArtifactName: string;
  outputArtifactType: ArtifactType;
  waitForHuman?: boolean;
}

// ─── Create Delivery ──────────────────────────────────────

export function createDelivery(opts: {
  title: string;
  project: string;
  projectPath: string;
  prUrl?: string;
  description?: string;
  agentId?: string;       // default agent for all phases
  customPhases?: PhaseInput[];  // user-defined phases (overrides defaults)
}): Delivery {
  const id = randomUUID().slice(0, 8);
  const defaultAgentId = opts.agentId || loadSettings().defaultAgent || 'claude';

  let phases: DeliveryPhase[];

  if (opts.customPhases && opts.customPhases.length > 0) {
    // Custom phases from user
    phases = opts.customPhases.map(p => ({
      name: p.name as PhaseName,
      status: 'pending' as PhaseStatus,
      agentRole: buildPhasePrompt(p),
      agentId: p.agentId || defaultAgentId,
      taskIds: [],
      inputArtifactTypes: p.inputArtifactTypes,
      outputArtifactIds: [],
      interactions: [],
      _waitForHuman: p.waitForHuman,
      _label: p.label,
      _icon: p.icon,
      _outputArtifactName: p.outputArtifactName,
      _outputArtifactType: p.outputArtifactType,
    }));
  } else {
    // Default 4-phase
    phases = DEFAULT_PHASES.map(p => ({
      ...p,
      agentId: defaultAgentId,
      taskIds: [],
      outputArtifactIds: [],
      interactions: [],
    }));
  }

  const delivery: Delivery = {
    id,
    title: opts.title,
    status: 'running',
    input: {
      project: opts.project,
      projectPath: opts.projectPath,
      prUrl: opts.prUrl,
      description: opts.description,
    },
    phases,
    currentPhaseIndex: 0,
    createdAt: new Date().toISOString(),
  };

  saveDelivery(delivery);

  // Start the first phase
  dispatchPhase(delivery, 0);

  return delivery;
}

// ─── Phase Dispatch ───────────────────────────────────────

function dispatchPhase(delivery: Delivery, phaseIndex: number): void {
  const phase = delivery.phases[phaseIndex];
  if (!phase || phase.status === 'done') return;

  const projectInfo = getProjectInfo(delivery.input.project);
  if (!projectInfo) {
    phase.status = 'failed';
    phase.error = `Project not found: ${delivery.input.project}`;
    saveDelivery(delivery);
    return;
  }

  // Build prompt with artifacts
  const artifacts = listArtifacts(delivery.id);
  const relevantArtifacts = artifacts.filter(a =>
    phase.inputArtifactTypes.includes(a.type)
  );

  let prompt = `[Your role: ${phase.agentRole}]\n\n`;

  // Add input context
  if (phaseIndex === 0) {
    // Analyze phase: include original input
    if (delivery.input.prUrl) {
      prompt += `PR URL: ${delivery.input.prUrl}\n\n`;
    }
    if (delivery.input.description) {
      prompt += `Task Description:\n${delivery.input.description}\n\n`;
    }
    prompt += `Project: ${delivery.input.project} (${delivery.input.projectPath})\n\n`;
    prompt += `Please analyze the project and the task, then produce the requirements document.`;
  } else {
    // Other phases: include relevant artifacts
    if (relevantArtifacts.length > 0) {
      prompt += `--- Input Documents ---\n\n`;
      for (const a of relevantArtifacts) {
        prompt += `=== ${a.name} (${a.type}) ===\n${a.content}\n\n`;
      }
    }

    // Include interactions/feedback
    if (phase.interactions.length > 0) {
      prompt += `--- Feedback/Instructions ---\n\n`;
      for (const i of phase.interactions) {
        prompt += `[${i.from}]: ${i.message}\n\n`;
      }
    }
  }

  // Create task
  const task = createTask({
    projectName: projectInfo.name,
    projectPath: projectInfo.path,
    prompt,
    mode: 'prompt',
    agent: phase.agentId || undefined,
    conversationId: '', // fresh session
  });

  phase.status = 'running';
  phase.taskIds.push(task.id);
  phase.startedAt = phase.startedAt || new Date().toISOString();
  delivery.currentPhaseIndex = phaseIndex;
  saveDelivery(delivery);

  // Listen for completion
  setupDeliveryTaskListener(delivery.id, task.id, phaseIndex);
}

// ─── Task Completion Handler ──────────────────────────────

function setupDeliveryTaskListener(deliveryId: string, taskId: string, phaseIndex: number): void {
  const cleanup = onTaskEvent((evtTaskId, event, data) => {
    if (evtTaskId !== taskId) return;
    if (event !== 'status') return;
    if (data !== 'done' && data !== 'failed') return;

    cleanup();

    const delivery = getDelivery(deliveryId);
    if (!delivery || delivery.status !== 'running') return;

    const phase = delivery.phases[phaseIndex];
    if (!phase) return;

    const task = getTask(taskId);

    if (data === 'failed' || !task) {
      phase.status = 'failed';
      phase.error = task?.error || 'Task failed';
      phase.completedAt = new Date().toISOString();
      delivery.status = 'failed';
      delivery.completedAt = new Date().toISOString();
      saveDelivery(delivery);
      return;
    }

    // Extract artifacts from output
    const output = task.resultSummary || '';
    const extracted = extractArtifacts(output, deliveryId, phase.name);

    // If no structured artifacts found, create a fallback from the full output
    if (extracted.length === 0 && output.trim()) {
      const fallbackName = phase._outputArtifactName || `${phase.name}-output.md`;
      const fallbackType: ArtifactType = phase._outputArtifactType ||
        (phase.name === 'analyze' ? 'requirements' :
         phase.name === 'implement' ? 'architecture' :
         phase.name === 'test' ? 'test-plan' :
         phase.name === 'review' ? 'review-report' : 'custom');

      const fallback = createArtifact(deliveryId, {
        type: fallbackType,
        name: fallbackName,
        content: output,
        producedBy: phase.name,
      });
      extracted.push(fallback);
    }

    phase.outputArtifactIds.push(...extracted.map(a => a.id));

    // Write artifacts to project directory
    for (const a of extracted) {
      try { writeArtifactToProject(a, delivery.input.projectPath); } catch {}
    }

    // Wait for human approval if configured (default: analyze phase)
    const needsHumanApproval = phase._waitForHuman !== undefined ? phase._waitForHuman : phase.name === 'analyze';
    if (needsHumanApproval) {
      phase.status = 'waiting_human';
      saveDelivery(delivery);
      return;
    }

    // Other phases: mark done and advance
    phase.status = 'done';
    phase.completedAt = new Date().toISOString();
    saveDelivery(delivery);

    advanceToNextPhase(delivery);
  });
}

function advanceToNextPhase(delivery: Delivery): void {
  const nextIndex = delivery.currentPhaseIndex + 1;

  if (nextIndex >= delivery.phases.length) {
    // All phases complete
    delivery.status = 'done';
    delivery.completedAt = new Date().toISOString();
    saveDelivery(delivery);
    return;
  }

  dispatchPhase(delivery, nextIndex);
}

// ─── Human Approval (Analyze phase) ──────────────────────

export function approveDeliveryPhase(deliveryId: string, feedback?: string): boolean {
  const delivery = getDelivery(deliveryId);
  if (!delivery) return false;

  // Find any phase waiting for human approval
  const waitingPhase = delivery.phases.find(p => p.status === 'waiting_human');
  if (!waitingPhase) return false;

  if (feedback) {
    waitingPhase.interactions.push({
      from: 'user',
      message: feedback,
      timestamp: new Date().toISOString(),
    });
  }

  waitingPhase.status = 'done';
  waitingPhase.completedAt = new Date().toISOString();
  saveDelivery(delivery);

  advanceToNextPhase(delivery);
  return true;
}

export function rejectDeliveryPhase(deliveryId: string, feedback: string): boolean {
  const delivery = getDelivery(deliveryId);
  if (!delivery) return false;

  const waitingPhase = delivery.phases.find(p => p.status === 'waiting_human');
  if (!waitingPhase) return false;

  const phaseIndex = delivery.phases.indexOf(waitingPhase);
  waitingPhase.interactions.push({
    from: 'user',
    message: `REJECTED: ${feedback}`,
    timestamp: new Date().toISOString(),
  });

  // Re-run the phase with feedback
  waitingPhase.status = 'pending';
  saveDelivery(delivery);

  dispatchPhase(delivery, phaseIndex);
  return true;
}

// ─── Send Message to Agent ────────────────────────────────

export function sendToAgent(deliveryId: string, phaseName: PhaseName, message: string): boolean {
  const delivery = getDelivery(deliveryId);
  if (!delivery || delivery.status !== 'running') return false;

  const phaseIndex = delivery.phases.findIndex(p => p.name === phaseName);
  const phase = delivery.phases[phaseIndex];
  if (!phase) return false;

  phase.interactions.push({
    from: 'user',
    message,
    timestamp: new Date().toISOString(),
  });
  saveDelivery(delivery);

  // If the phase is idle (done or waiting), dispatch a new task with the message
  if (phase.status === 'done' || phase.status === 'waiting_human') {
    phase.status = 'pending';
    saveDelivery(delivery);
    dispatchPhase(delivery, phaseIndex);
    return true;
  }

  // If running, the message will be visible in next interaction
  return true;
}

// ─── Cancel ───────────────────────────────────────────────

export function cancelDelivery(id: string): boolean {
  const delivery = getDelivery(id);
  if (!delivery || delivery.status !== 'running') return false;

  for (const phase of delivery.phases) {
    if (phase.status === 'running') {
      // Cancel running tasks
      for (const taskId of phase.taskIds) {
        try { const { cancelTask } = require('./task-manager'); cancelTask(taskId); } catch {}
      }
      phase.status = 'failed';
    }
    if (phase.status === 'pending' || phase.status === 'waiting_human') {
      phase.status = 'skipped';
    }
  }

  delivery.status = 'cancelled';
  delivery.completedAt = new Date().toISOString();
  saveDelivery(delivery);
  return true;
}

// ─── Retry Phase ──────────────────────────────────────────

export function retryPhase(deliveryId: string, phaseName: PhaseName): boolean {
  const delivery = getDelivery(deliveryId);
  if (!delivery) return false;

  const phaseIndex = delivery.phases.findIndex(p => p.name === phaseName);
  const phase = delivery.phases[phaseIndex];
  if (!phase || phase.status === 'running') return false;

  phase.status = 'pending';
  phase.error = undefined;
  delivery.status = 'running';
  delivery.completedAt = undefined;
  saveDelivery(delivery);

  dispatchPhase(delivery, phaseIndex);
  return true;
}

// ─── Recovery ─────────────────────────────────────────────

function recoverStuckDeliveries(): void {
  try {
    const deliveries = listDeliveries().filter(d => d.status === 'running');
    for (const delivery of deliveries) {
      for (let i = 0; i < delivery.phases.length; i++) {
        const phase = delivery.phases[i];
        if (phase.status !== 'running') continue;

        const lastTaskId = phase.taskIds[phase.taskIds.length - 1];
        if (!lastTaskId) continue;

        const task = getTask(lastTaskId);
        if (!task) {
          phase.status = 'failed';
          phase.error = 'Task not found (cleaned up)';
          phase.completedAt = new Date().toISOString();
          saveDelivery(delivery);
        } else if (task.status === 'done' || task.status === 'failed') {
          // Task finished but we missed the event — re-process
          setupDeliveryTaskListener(delivery.id, lastTaskId, i);
        } else {
          // Still running — re-attach listener
          setupDeliveryTaskListener(delivery.id, lastTaskId, i);
        }
      }
    }
  } catch {}
}

setInterval(recoverStuckDeliveries, 30_000);
setTimeout(recoverStuckDeliveries, 5000);
