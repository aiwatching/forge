/**
 * Pipeline Scheduler — manages project-pipeline bindings, scheduled execution,
 * and issue scanning (replaces issue-scanner.ts).
 *
 * Each project can bind multiple workflows. Each binding has:
 * - config: JSON with workflow-specific settings (interval, scanType, labels, baseBranch)
 * - enabled: on/off toggle
 * - scheduled execution via config.interval (minutes, 0 = manual only)
 * - config.scanType: 'github-issues' enables automatic issue scanning + dedup
 */

import { getDb } from '@/src/core/db/database';
import { getDbPath } from '@/src/config';
import { startPipeline, getPipeline } from './pipeline';
import { randomUUID } from 'node:crypto';
import { execSync } from 'node:child_process';

function db() { return getDb(getDbPath()); }

/** Normalize SQLite datetime('now') → ISO 8601 UTC string. */
function toIsoUTC(s: string | null): string | null {
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) return s.replace(' ', 'T') + 'Z';
  return s;
}

export interface ProjectPipelineBinding {
  id: number;
  projectPath: string;
  projectName: string;
  workflowName: string;
  enabled: boolean;
  config: Record<string, any>; // interval, scanType, labels, baseBranch, etc.
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
  dedupKey: string | null;
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

export function recordRun(projectPath: string, workflowName: string, pipelineId: string, dedupKey?: string): string {
  const id = randomUUID().slice(0, 8);
  db().prepare(`
    INSERT INTO pipeline_runs (id, project_path, workflow_name, pipeline_id, status, dedup_key)
    VALUES (?, ?, ?, ?, 'running', ?)
  `).run(id, projectPath, workflowName, pipelineId, dedupKey || null);
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
    dedupKey: r.dedup_key || null,
    createdAt: toIsoUTC(r.created_at) ?? r.created_at,
  }));
}

export function deleteRun(id: string): void {
  db().prepare('DELETE FROM pipeline_runs WHERE id = ?').run(id);
}

// ─── Dedup ──────────────────────────────────────────────

function isDuplicate(projectPath: string, workflowName: string, dedupKey: string): boolean {
  const row = db().prepare(
    'SELECT status FROM pipeline_runs WHERE project_path = ? AND workflow_name = ? AND dedup_key = ? ORDER BY created_at DESC LIMIT 1'
  ).get(projectPath, workflowName, dedupKey) as { status: string } | undefined;
  if (!row) return false;
  // Failed runs are not duplicates — allow retry
  return row.status !== 'failed';
}

export function resetDedup(projectPath: string, workflowName: string, dedupKey: string): void {
  db().prepare(
    'DELETE FROM pipeline_runs WHERE project_path = ? AND workflow_name = ? AND dedup_key = ?'
  ).run(projectPath, workflowName, dedupKey);
}

// ─── Trigger ─────────────────────────────────────────────

export function triggerPipeline(
  projectPath: string, projectName: string, workflowName: string,
  extraInput?: Record<string, any>, dedupKey?: string
): { pipelineId: string; runId: string } {
  const input: Record<string, string> = {
    project: projectName,
    ...extraInput,
  };

  const pipeline = startPipeline(workflowName, input);
  const runId = recordRun(projectPath, workflowName, pipeline.id, dedupKey);
  updateLastRunAt(projectPath, workflowName);
  console.log(`[pipeline-scheduler] Triggered ${workflowName} for ${projectName} (pipeline: ${pipeline.id}${dedupKey ? ', dedup: ' + dedupKey : ''})`);
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

// ─── GitHub Issue Scanning ──────────────────────────────

function getRepoFromProject(projectPath: string): string | null {
  try {
    return execSync('gh repo view --json nameWithOwner -q .nameWithOwner', {
      cwd: projectPath, encoding: 'utf-8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'],
    }).trim() || null;
  } catch {
    try {
      const url = execSync('git remote get-url origin', {
        cwd: projectPath, encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      return url.replace(/.*github\.com[:/]/, '').replace(/\.git$/, '') || null;
    } catch { return null; }
  }
}

function fetchOpenIssues(projectPath: string, labels: string[]): { number: number; title: string; error?: string }[] {
  const repo = getRepoFromProject(projectPath);
  if (!repo) return [{ number: -1, title: '', error: 'Could not detect GitHub repo. Run: gh auth login' }];
  try {
    const labelFilter = labels.length > 0 ? ` --label "${labels.join(',')}"` : '';
    const out = execSync(`gh issue list --state open --limit 30 --json number,title${labelFilter} -R ${repo}`, {
      cwd: projectPath, encoding: 'utf-8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'],
    });
    return JSON.parse(out) || [];
  } catch (e: any) {
    const msg = e.stderr?.toString() || e.message || 'gh CLI failed';
    return [{ number: -1, title: '', error: msg.includes('auth') ? 'GitHub CLI not authenticated. Run: gh auth login' : msg }];
  }
}

export function scanAndTriggerIssues(binding: ProjectPipelineBinding): { triggered: number; issues: number[]; total: number; pending: number; error?: string } {
  const labels: string[] = binding.config.labels || [];
  const issues = fetchOpenIssues(binding.projectPath, labels);

  // Check for errors
  if (issues.length === 1 && (issues[0] as any).error) {
    return { triggered: 0, issues: [], total: 0, pending: 0, error: (issues[0] as any).error };
  }

  // Check if there's already a running pipeline for this project+workflow — only one at a time
  // to prevent concurrent git operations on the same repo
  const recentRuns = getRuns(binding.projectPath, binding.workflowName, 5);
  const hasRunning = recentRuns.some(r => r.status === 'running');

  // Batch dedup check — one query instead of N
  const processedKeys = new Set(
    (db().prepare(
      'SELECT dedup_key FROM pipeline_runs WHERE project_path = ? AND workflow_name = ? AND dedup_key IS NOT NULL AND status != ?'
    ).all(binding.projectPath, binding.workflowName, 'failed') as { dedup_key: string }[])
    .map(r => r.dedup_key)
  );

  const newIssues: { number: number; title: string }[] = [];
  for (const issue of issues) {
    if (issue.number < 0) continue;
    if (!processedKeys.has(`issue:${issue.number}`)) {
      newIssues.push(issue);
    }
  }

  if (newIssues.length === 0) {
    updateLastRunAt(binding.projectPath, binding.workflowName);
    return { triggered: 0, issues: [], total: issues.length, pending: 0 };
  }

  // Only trigger ONE issue at a time to avoid concurrent git conflicts
  // Next issue will be triggered on the next scan cycle
  if (hasRunning) {
    console.log(`[pipeline-scheduler] Issue scan: ${newIssues.length} new issues for ${binding.projectName}, waiting for current pipeline to finish`);
    return { triggered: 0, issues: [], total: issues.length, pending: newIssues.length };
  }

  const issue = newIssues[0];
  const dedupKey = `issue:${issue.number}`;
  // Remove old failed run so new dedup_key insert won't conflict
  db().prepare('DELETE FROM pipeline_runs WHERE project_path = ? AND workflow_name = ? AND dedup_key = ? AND status = ?')
    .run(binding.projectPath, binding.workflowName, dedupKey, 'failed');
  try {
    triggerPipeline(
      binding.projectPath, binding.projectName, binding.workflowName,
      {
        issue_id: String(issue.number),
        base_branch: binding.config.baseBranch || 'auto-detect',
      },
      dedupKey
    );
    console.log(`[pipeline-scheduler] Issue scan: triggered #${issue.number} "${issue.title}" for ${binding.projectName} (${newIssues.length - 1} more pending)`);
  } catch (e: any) {
    console.error(`[pipeline-scheduler] Issue scan: failed to trigger #${issue.number}:`, e.message);
    return { triggered: 0, issues: [], total: issues.length, pending: newIssues.length, error: e.message };
  }

  updateLastRunAt(binding.projectPath, binding.workflowName);
  return { triggered: 1, issues: [issue.number], total: issues.length, pending: newIssues.length - 1 };
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

      if (elapsed < intervalMs) continue;

      try {
        const isIssueWorkflow = binding.workflowName === 'issue-fix-and-review' || binding.workflowName === 'issue-auto-fix' || binding.config.scanType === 'github-issues';
        if (isIssueWorkflow) {
          // Issue scan mode: fetch issues → dedup → trigger per issue
          console.log(`[pipeline-scheduler] Scheduled issue scan: ${binding.workflowName} for ${binding.projectName}`);
          scanAndTriggerIssues(binding);
        } else {
          // Normal mode: single trigger (skip if still running)
          const recentRuns = getRuns(binding.projectPath, binding.workflowName, 1);
          if (recentRuns.length > 0 && recentRuns[0].status === 'running') continue;

          console.log(`[pipeline-scheduler] Scheduled trigger: ${binding.workflowName} for ${binding.projectName}`);
          triggerPipeline(binding.projectPath, binding.projectName, binding.workflowName, binding.config.input);
        }
      } catch (e: any) {
        console.error(`[pipeline-scheduler] Scheduled trigger failed for ${binding.workflowName}:`, e.message);
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
