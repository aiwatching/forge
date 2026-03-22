/**
 * Pipeline Scheduler — manages project-pipeline bindings and scheduled execution.
 * Replaces issue-scanner with a generic approach.
 *
 * Each project can bind multiple workflows. Each binding has:
 * - config: JSON with workflow-specific settings (e.g. interval, labels for issue pipelines)
 * - enabled: on/off toggle
 * - scheduled execution via config.interval (minutes, 0 = manual only)
 */

import { getDb } from '@/src/core/db/database';
import { getDbPath } from '@/src/config';
import { startPipeline, getPipeline } from './pipeline';
import { randomUUID } from 'node:crypto';

function db() { return getDb(getDbPath()); }

/** Normalize SQLite datetime('now') → ISO 8601 UTC string. */
function toIsoUTC(s: string | null): string | null {
  if (!s) return null;
  // SQLite datetime('now') → 'YYYY-MM-DD HH:MM:SS' (UTC, no indicator)
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) return s.replace(' ', 'T') + 'Z';
  return s;
}

export interface ProjectPipelineBinding {
  id: number;
  projectPath: string;
  projectName: string;
  workflowName: string;
  enabled: boolean;
  config: Record<string, any>; // interval (minutes), labels, baseBranch, etc.
  lastRunAt: string | null;
  createdAt: string;
}

export interface PipelineRun {
  id: string;
  projectPath: string;
  workflowName: string;
  pipelineId: string;
  status: string;
  summary: string;
  createdAt: string;
}

// ─── Bindings CRUD ───────────────────────────────────────

export function getBindings(projectPath: string): ProjectPipelineBinding[] {
  return (db().prepare('SELECT * FROM project_pipelines WHERE project_path = ? ORDER BY created_at ASC')
    .all(projectPath) as any[]).map(r => ({
      id: r.id,
      projectPath: r.project_path,
      projectName: r.project_name,
      workflowName: r.workflow_name,
      enabled: !!r.enabled,
      config: JSON.parse(r.config || '{}'),
      lastRunAt: toIsoUTC(r.last_run_at),
      createdAt: toIsoUTC(r.created_at) ?? r.created_at,
    }));
}

export function getAllScheduledBindings(): ProjectPipelineBinding[] {
  return (db().prepare('SELECT * FROM project_pipelines WHERE enabled = 1')
    .all() as any[]).map(r => ({
      id: r.id,
      projectPath: r.project_path,
      projectName: r.project_name,
      workflowName: r.workflow_name,
      enabled: true,
      config: JSON.parse(r.config || '{}'),
      lastRunAt: toIsoUTC(r.last_run_at),
      createdAt: toIsoUTC(r.created_at) ?? r.created_at,
    })).filter(b => b.config.interval && b.config.interval > 0);
}

export function addBinding(projectPath: string, projectName: string, workflowName: string, config?: Record<string, any>): void {
  db().prepare(`
    INSERT OR REPLACE INTO project_pipelines (project_path, project_name, workflow_name, config)
    VALUES (?, ?, ?, ?)
  `).run(projectPath, projectName, workflowName, JSON.stringify(config || {}));
}

export function removeBinding(projectPath: string, workflowName: string): void {
  db().prepare('DELETE FROM project_pipelines WHERE project_path = ? AND workflow_name = ?')
    .run(projectPath, workflowName);
}

export function updateBinding(projectPath: string, workflowName: string, updates: { enabled?: boolean; config?: Record<string, any> }): void {
  if (updates.enabled !== undefined) {
    db().prepare('UPDATE project_pipelines SET enabled = ? WHERE project_path = ? AND workflow_name = ?')
      .run(updates.enabled ? 1 : 0, projectPath, workflowName);
  }
  if (updates.config) {
    db().prepare('UPDATE project_pipelines SET config = ? WHERE project_path = ? AND workflow_name = ?')
      .run(JSON.stringify(updates.config), projectPath, workflowName);
  }
}

function updateLastRunAt(projectPath: string, workflowName: string): void {
  db().prepare('UPDATE project_pipelines SET last_run_at = ? WHERE project_path = ? AND workflow_name = ?')
    .run(new Date().toISOString(), projectPath, workflowName);
}

// ─── Runs ────────────────────────────────────────────────

export function recordRun(projectPath: string, workflowName: string, pipelineId: string): string {
  const id = randomUUID().slice(0, 8);
  db().prepare(`
    INSERT INTO pipeline_runs (id, project_path, workflow_name, pipeline_id, status)
    VALUES (?, ?, ?, ?, 'running')
  `).run(id, projectPath, workflowName, pipelineId);
  return id;
}

export function updateRun(pipelineId: string, status: string, summary?: string): void {
  if (summary) {
    db().prepare('UPDATE pipeline_runs SET status = ?, summary = ? WHERE pipeline_id = ?')
      .run(status, summary, pipelineId);
  } else {
    db().prepare('UPDATE pipeline_runs SET status = ? WHERE pipeline_id = ?')
      .run(status, pipelineId);
  }
}

export function getRuns(projectPath: string, workflowName?: string, limit = 20): PipelineRun[] {
  const query = workflowName
    ? 'SELECT * FROM pipeline_runs WHERE project_path = ? AND workflow_name = ? ORDER BY created_at DESC LIMIT ?'
    : 'SELECT * FROM pipeline_runs WHERE project_path = ? ORDER BY created_at DESC LIMIT ?';
  const params = workflowName ? [projectPath, workflowName, limit] : [projectPath, limit];
  return (db().prepare(query).all(...params) as any[]).map(r => ({
    id: r.id,
    projectPath: r.project_path,
    workflowName: r.workflow_name,
    pipelineId: r.pipeline_id,
    status: r.status,
    summary: r.summary || '',
    createdAt: toIsoUTC(r.created_at) ?? r.created_at,
  }));
}

export function deleteRun(id: string): void {
  db().prepare('DELETE FROM pipeline_runs WHERE id = ?').run(id);
}

// ─── Trigger ─────────────────────────────────────────────

export function triggerPipeline(projectPath: string, projectName: string, workflowName: string, extraInput?: Record<string, any>): { pipelineId: string; runId: string } {
  const input: Record<string, string> = {
    project: projectName,
    ...extraInput,
  };

  const pipeline = startPipeline(workflowName, input);
  const runId = recordRun(projectPath, workflowName, pipeline.id);
  updateLastRunAt(projectPath, workflowName);
  console.log(`[pipeline-scheduler] Triggered ${workflowName} for ${projectName} (pipeline: ${pipeline.id})`);
  return { pipelineId: pipeline.id, runId };
}

// ─── Status sync (called from pipeline completion) ───────

export function syncRunStatus(pipelineId: string): void {
  const pipeline = getPipeline(pipelineId);
  if (!pipeline) return;

  // Build summary from outputs
  let summary = '';
  for (const [nodeId, node] of Object.entries(pipeline.nodes)) {
    if (node.outputs && Object.keys(node.outputs).length > 0) {
      for (const [key, val] of Object.entries(node.outputs)) {
        if (val && typeof val === 'string' && val.length < 500) {
          summary += `${nodeId}.${key}: ${val.slice(0, 200)}\n`;
        }
      }
    }
  }

  updateRun(pipelineId, pipeline.status, summary.trim());
}

// ─── Periodic Scheduler ─────────────────────────────────

const schedulerKey = Symbol.for('forge-pipeline-scheduler');
const gAny = globalThis as any;
if (!gAny[schedulerKey]) gAny[schedulerKey] = { started: false, timer: null as NodeJS.Timeout | null };
const schedulerState = gAny[schedulerKey] as { started: boolean; timer: NodeJS.Timeout | null };

const CHECK_INTERVAL_MS = 60 * 1000; // check every 60s

export function startScheduler(): void {
  if (schedulerState.started) return;
  schedulerState.started = true;

  // Check on startup after a short delay
  setTimeout(() => tickScheduler(), 5000);

  // Then check periodically
  schedulerState.timer = setInterval(() => tickScheduler(), CHECK_INTERVAL_MS);
  console.log('[pipeline-scheduler] Scheduler started (checking every 60s)');
}

export function stopScheduler(): void {
  if (schedulerState.timer) {
    clearInterval(schedulerState.timer);
    schedulerState.timer = null;
  }
  schedulerState.started = false;
}

function tickScheduler(): void {
  try {
    const bindings = getAllScheduledBindings();
    const now = Date.now();

    for (const binding of bindings) {
      const intervalMs = binding.config.interval * 60 * 1000;
      const lastRun = binding.lastRunAt ? new Date(binding.lastRunAt).getTime() : 0;
      const elapsed = now - lastRun;

      if (elapsed >= intervalMs) {
        // Check if there's already a running pipeline for this binding
        const recentRuns = getRuns(binding.projectPath, binding.workflowName, 1);
        if (recentRuns.length > 0 && recentRuns[0].status === 'running') {
          continue; // skip if still running
        }

        try {
          console.log(`[pipeline-scheduler] Scheduled trigger: ${binding.workflowName} for ${binding.projectName}`);
          triggerPipeline(binding.projectPath, binding.projectName, binding.workflowName, binding.config.input);
        } catch (e: any) {
          console.error(`[pipeline-scheduler] Scheduled trigger failed for ${binding.workflowName}:`, e.message);
        }
      }
    }
  } catch (e: any) {
    console.error('[pipeline-scheduler] Tick error:', e.message);
  }
}

/** Get next scheduled run time for a binding */
export function getNextRunTime(binding: ProjectPipelineBinding): string | null {
  if (!binding.enabled || !binding.config.interval || binding.config.interval <= 0) return null;
  const intervalMs = binding.config.interval * 60 * 1000;
  const lastRun = binding.lastRunAt ? new Date(binding.lastRunAt).getTime() : new Date(binding.createdAt).getTime();
  return new Date(lastRun + intervalMs).toISOString();
}
