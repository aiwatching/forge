/**
 * Workflow (Flow) engine — loads YAML flow definitions and executes them.
 *
 * Flow files live in ~/.forge/flows/*.yaml
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { createTask } from './task-manager';
import { getProjectInfo } from './projects';
import type { Task } from '@/src/types';
import { getDataDir } from './dirs';

const FLOWS_DIR = join(getDataDir(), 'flows');

export interface FlowStep {
  project: string;
  prompt: string;
  priority?: number;
  dependsOn?: string;  // step name to wait for
}

export interface Flow {
  name: string;
  description?: string;
  schedule?: string;    // cron expression for auto-trigger
  steps: FlowStep[];
}

export function listFlows(): Flow[] {
  if (!existsSync(FLOWS_DIR)) return [];

  return readdirSync(FLOWS_DIR)
    .filter(f => f.endsWith('.yaml') || f.endsWith('.yml'))
    .map(f => {
      try {
        const raw = readFileSync(join(FLOWS_DIR, f), 'utf-8');
        const parsed = YAML.parse(raw);
        return {
          name: parsed.name || f.replace(/\.ya?ml$/, ''),
          description: parsed.description,
          schedule: parsed.schedule,
          steps: parsed.steps || [],
        } as Flow;
      } catch {
        return null;
      }
    })
    .filter(Boolean) as Flow[];
}

export function getFlow(name: string): Flow | null {
  return listFlows().find(f => f.name === name) || null;
}

/**
 * Run a flow — creates tasks for each step.
 * Steps without dependsOn run immediately (queued).
 * Steps with dependsOn will be handled by a follow-up mechanism.
 */
export function runFlow(name: string): { flow: Flow; tasks: Task[] } {
  const flow = getFlow(name);
  if (!flow) throw new Error(`Flow not found: ${name}`);

  const tasks: Task[] = [];

  for (const step of flow.steps) {
    const project = getProjectInfo(step.project);
    if (!project) {
      console.error(`[flow] Project not found: ${step.project}, skipping step`);
      continue;
    }

    const task = createTask({
      projectName: project.name,
      projectPath: project.path,
      prompt: step.prompt,
      priority: step.priority || 0,
    });

    tasks.push(task);
  }

  return { flow, tasks };
}
