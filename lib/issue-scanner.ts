/**
 * Issue Scanner — periodically scans GitHub issues for configured projects
 * and triggers issue-auto-fix pipeline for new issues.
 *
 * Per-project config stored in DB:
 *   - enabled: boolean
 *   - interval: minutes (0 = manual only)
 *   - labels: string[] (only process issues with these labels, empty = all)
 *   - baseBranch: string (default: auto-detect)
 */

import { execSync } from 'node:child_process';
import { getDb } from '@/src/core/db/database';
import { getDbPath } from '@/src/config';
import { startPipeline } from './pipeline';
import { loadSettings } from './settings';
import { homedir } from 'node:os';

function db() { return getDb(getDbPath()); }

export interface IssueAutofixConfig {
  projectPath: string;
  projectName: string;
  enabled: boolean;
  interval: number;      // minutes, 0 = manual
  labels: string[];      // filter labels
  baseBranch: string;    // default: '' (auto-detect)
}

// ─── DB setup ────────────────────────────────────────────

export function ensureTable() {
  db().exec(`
    CREATE TABLE IF NOT EXISTS issue_autofix_config (
      project_path TEXT PRIMARY KEY,
      project_name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0,
      interval_min INTEGER NOT NULL DEFAULT 30,
      labels TEXT NOT NULL DEFAULT '[]',
      base_branch TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS issue_autofix_processed (
      project_path TEXT NOT NULL,
      issue_number INTEGER NOT NULL,
      pipeline_id TEXT,
      pr_number INTEGER,
      status TEXT NOT NULL DEFAULT 'processing',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (project_path, issue_number)
    );
  `);
}

// ─── Config CRUD ─────────────────────────────────────────

export function getConfig(projectPath: string): IssueAutofixConfig | null {
  ensureTable();
  const row = db().prepare('SELECT * FROM issue_autofix_config WHERE project_path = ?').get(projectPath) as any;
  if (!row) return null;
  return {
    projectPath: row.project_path,
    projectName: row.project_name,
    enabled: !!row.enabled,
    interval: row.interval_min,
    labels: JSON.parse(row.labels || '[]'),
    baseBranch: row.base_branch || '',
  };
}

export function saveConfig(config: IssueAutofixConfig): void {
  ensureTable();
  db().prepare(`
    INSERT OR REPLACE INTO issue_autofix_config (project_path, project_name, enabled, interval_min, labels, base_branch)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(config.projectPath, config.projectName, config.enabled ? 1 : 0, config.interval, JSON.stringify(config.labels), config.baseBranch);
}

export function listConfigs(): IssueAutofixConfig[] {
  ensureTable();
  return (db().prepare('SELECT * FROM issue_autofix_config WHERE enabled = 1').all() as any[]).map(row => ({
    projectPath: row.project_path,
    projectName: row.project_name,
    enabled: !!row.enabled,
    interval: row.interval_min,
    labels: JSON.parse(row.labels || '[]'),
    baseBranch: row.base_branch || '',
  }));
}

// ─── Issue scanning ──────────────────────────────────────

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
    const out = execSync(`gh issue list --state open --json number,title${labelFilter} -R ${repo}`, {
      cwd: projectPath, encoding: 'utf-8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'],
    });
    return JSON.parse(out) || [];
  } catch (e: any) {
    const msg = e.stderr?.toString() || e.message || 'gh CLI failed';
    return [{ number: -1, title: '', error: msg.includes('auth') ? 'GitHub CLI not authenticated. Run: gh auth login' : msg }];
  }
}

function isProcessed(projectPath: string, issueNumber: number): boolean {
  const row = db().prepare('SELECT 1 FROM issue_autofix_processed WHERE project_path = ? AND issue_number = ?')
    .get(projectPath, issueNumber);
  return !!row;
}

function markProcessed(projectPath: string, issueNumber: number, pipelineId: string): void {
  db().prepare(`
    INSERT OR REPLACE INTO issue_autofix_processed (project_path, issue_number, pipeline_id, status)
    VALUES (?, ?, ?, 'processing')
  `).run(projectPath, issueNumber, pipelineId);
}

export function updateProcessedStatus(projectPath: string, issueNumber: number, status: string, prNumber?: number): void {
  if (prNumber) {
    db().prepare('UPDATE issue_autofix_processed SET status = ?, pr_number = ? WHERE project_path = ? AND issue_number = ?')
      .run(status, prNumber, projectPath, issueNumber);
  } else {
    db().prepare('UPDATE issue_autofix_processed SET status = ? WHERE project_path = ? AND issue_number = ?')
      .run(status, projectPath, issueNumber);
  }
}

/** Reset a processed issue so it can be re-scanned or retried */
export function resetProcessedIssue(projectPath: string, issueNumber: number): void {
  db().prepare('DELETE FROM issue_autofix_processed WHERE project_path = ? AND issue_number = ?')
    .run(projectPath, issueNumber);
}

export function getProcessedIssues(projectPath: string): { issueNumber: number; pipelineId: string; prNumber: number | null; status: string; createdAt: string }[] {
  ensureTable();
  return (db().prepare('SELECT * FROM issue_autofix_processed WHERE project_path = ? ORDER BY created_at DESC').all(projectPath) as any[]).map(r => ({
    issueNumber: r.issue_number,
    pipelineId: r.pipeline_id,
    prNumber: r.pr_number,
    status: r.status,
    createdAt: r.created_at,
  }));
}

// ─── Scan & trigger ──────────────────────────────────────

export function scanAndTrigger(config: IssueAutofixConfig): { triggered: number; issues: number[]; total: number; error?: string } {
  const issues = fetchOpenIssues(config.projectPath, config.labels);

  // Check for errors
  if (issues.length === 1 && (issues[0] as any).error) {
    return { triggered: 0, issues: [], total: 0, error: (issues[0] as any).error };
  }

  const triggered: number[] = [];

  for (const issue of issues) {
    if (issue.number < 0) continue;
    if (isProcessed(config.projectPath, issue.number)) continue;

    try {
      const pipeline = startPipeline('issue-auto-fix', {
        issue_id: String(issue.number),
        project: config.projectName,
        base_branch: config.baseBranch || 'auto-detect',
      });
      markProcessed(config.projectPath, issue.number, pipeline.id);
      triggered.push(issue.number);
      console.log(`[issue-scanner] Triggered fix for #${issue.number} "${issue.title}" in ${config.projectName} (pipeline: ${pipeline.id})`);
    } catch (e) {
      console.error(`[issue-scanner] Failed to trigger for #${issue.number}:`, e);
    }
  }

  return { triggered: triggered.length, issues: triggered, total: issues.length };
}

// ─── Periodic scanner ────────────────────────────────────

// Use global symbol to prevent multiple workers from starting duplicate scanners
const scannerKey = Symbol.for('forge-issue-scanner');
const gAny = globalThis as any;
if (!gAny[scannerKey]) gAny[scannerKey] = { timers: new Map<string, NodeJS.Timeout>(), started: false };
const scannerState = gAny[scannerKey] as { timers: Map<string, NodeJS.Timeout>; started: boolean };

export function startScanner() {
  if (scannerState.started) return;
  scannerState.started = true;
  ensureTable();
  const configs = listConfigs();
  for (const config of configs) {
    if (config.interval > 0 && !scannerState.timers.has(config.projectPath)) {
      const timer = setInterval(() => {
        try { scanAndTrigger(config); } catch {}
      }, config.interval * 60 * 1000);
      scannerState.timers.set(config.projectPath, timer);
      console.log(`[issue-scanner] Started scanner for ${config.projectName} (every ${config.interval}min)`);
    }
  }
}

export function restartScanner() {
  for (const timer of scannerState.timers.values()) clearInterval(timer);
  scannerState.timers.clear();
  scannerState.started = false;
  startScanner();
}

export function stopScanner(projectPath: string) {
  const timer = scannerState.timers.get(projectPath);
  if (timer) {
    clearInterval(timer);
    scannerState.timers.delete(projectPath);
  }
}
