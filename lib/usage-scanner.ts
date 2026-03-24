/**
 * Usage Scanner — scans Claude Code JSONL session files for token usage data.
 * Stores aggregated results in SQLite for fast querying.
 * Supports incremental scanning (only reads new bytes since last scan).
 */

import { readdirSync, readFileSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { getDb } from '@/src/core/db/database';
import { getDbPath } from '@/src/config';
import { getClaudeDir } from './dirs';

function db() { return getDb(getDbPath()); }

// Model pricing per million tokens (API pricing, not subscription)
const PRICING: Record<string, { input: number; output: number }> = {
  'claude-opus-4': { input: 15, output: 75 },
  'claude-sonnet-4': { input: 3, output: 15 },
  'claude-haiku-4': { input: 0.80, output: 4 },
  'default': { input: 3, output: 15 },
};

function getModelFamily(model: string): string {
  if (!model) return 'unknown';
  if (model.includes('opus')) return 'claude-opus-4';
  if (model.includes('haiku')) return 'claude-haiku-4';
  if (model.includes('sonnet')) return 'claude-sonnet-4';
  return 'unknown';
}

function calcCost(family: string, input: number, output: number, cacheRead: number, cacheCreate: number): number {
  const p = PRICING[family] || PRICING['default'];
  return (
    (input * p.input / 1_000_000) +
    (output * p.output / 1_000_000) +
    (cacheRead * p.input * 0.1 / 1_000_000) +
    (cacheCreate * p.input * 0.25 / 1_000_000)
  );
}

function dirToProjectPath(dirName: string): string {
  return dirName.replace(/^-/, '/').replace(/-/g, '/');
}

function dirToProjectName(dirName: string): string {
  return dirToProjectPath(dirName).split('/').pop() || dirName;
}

interface UsageEntry {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheCreate: number;
  timestamp: string;
}

/** Parse JSONL content for assistant usage entries */
function parseUsageFromContent(content: string): UsageEntry[] {
  const entries: UsageEntry[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.type === 'assistant' && obj.message?.usage) {
        const u = obj.message.usage;
        entries.push({
          model: getModelFamily(obj.message.model || ''),
          inputTokens: u.input_tokens || 0,
          outputTokens: u.output_tokens || 0,
          cacheRead: u.cache_read_input_tokens || 0,
          cacheCreate: u.cache_creation_input_tokens || 0,
          timestamp: obj.timestamp || '',
        });
      }
    } catch {}
  }
  return entries;
}

/** Scan all JSONL files, incrementally */
export function scanUsage(): { scanned: number; updated: number; errors: number } {
  const claudeDir = getClaudeDir();
  const projectsDir = join(claudeDir, 'projects');

  let scanned = 0, updated = 0, errors = 0;

  let projectDirs: string[];
  try {
    projectDirs = readdirSync(projectsDir);
  } catch {
    return { scanned: 0, updated: 0, errors: 0 };
  }

  const upsert = db().prepare(`
    INSERT INTO token_usage (session_id, source, project_path, project_name, model, input_tokens, output_tokens, cache_read_tokens, cache_create_tokens, cost_usd, message_count, started_at, completed_at)
    VALUES (?, 'terminal', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id, source, model) DO UPDATE SET
      input_tokens = excluded.input_tokens,
      output_tokens = excluded.output_tokens,
      cache_read_tokens = excluded.cache_read_tokens,
      cache_create_tokens = excluded.cache_create_tokens,
      cost_usd = excluded.cost_usd,
      message_count = excluded.message_count,
      started_at = excluded.started_at,
      completed_at = excluded.completed_at
  `);

  const getScanState = db().prepare('SELECT last_size FROM usage_scan_state WHERE file_path = ?');
  const setScanState = db().prepare(`
    INSERT INTO usage_scan_state (file_path, last_size) VALUES (?, ?)
    ON CONFLICT(file_path) DO UPDATE SET last_size = excluded.last_size, last_scan = datetime('now')
  `);

  for (const projDir of projectDirs) {
    const projPath = join(projectsDir, projDir);
    try { if (!statSync(projPath).isDirectory()) continue; } catch { continue; }

    const projectPath = dirToProjectPath(projDir);
    const projectName = dirToProjectName(projDir);

    let files: string[];
    try {
      files = readdirSync(projPath).filter(f => f.endsWith('.jsonl') && !f.startsWith('agent-'));
    } catch { continue; }

    for (const file of files) {
      const filePath = join(projPath, file);
      const sessionId = basename(file, '.jsonl');
      scanned++;

      try {
        const stat = statSync(filePath);
        const currentSize = stat.size;

        // Check if file changed since last scan
        const scanState = getScanState.get(filePath) as { last_size: number } | undefined;
        const lastSize = scanState?.last_size || 0;

        if (currentSize === lastSize) continue; // No change

        // Read full file (for accurate aggregation) or incremental
        // For simplicity and correctness, always read full file and replace
        const content = readFileSync(filePath, 'utf-8');
        const entries = parseUsageFromContent(content);

        if (entries.length === 0) {
          setScanState.run(filePath, currentSize);
          continue;
        }

        // Aggregate by model
        const byModel: Record<string, { input: number; output: number; cacheRead: number; cacheCreate: number; count: number; firstTs: string; lastTs: string }> = {};
        for (const e of entries) {
          if (!byModel[e.model]) {
            byModel[e.model] = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, count: 0, firstTs: e.timestamp, lastTs: e.timestamp };
          }
          const m = byModel[e.model];
          m.input += e.inputTokens;
          m.output += e.outputTokens;
          m.cacheRead += e.cacheRead;
          m.cacheCreate += e.cacheCreate;
          m.count++;
          if (e.timestamp && e.timestamp < m.firstTs) m.firstTs = e.timestamp;
          if (e.timestamp && e.timestamp > m.lastTs) m.lastTs = e.timestamp;
        }

        // Upsert per model
        for (const [model, d] of Object.entries(byModel)) {
          const cost = calcCost(model, d.input, d.output, d.cacheRead, d.cacheCreate);
          upsert.run(sessionId, projectPath, projectName, model, d.input, d.output, d.cacheRead, d.cacheCreate, cost, d.count, d.firstTs, d.lastTs);
        }

        setScanState.run(filePath, currentSize);
        updated++;
      } catch {
        errors++;
      }
    }
  }

  return { scanned, updated, errors };
}

/** Record usage from task/mobile/pipeline (called when they complete) */
export function recordUsage(opts: {
  sessionId: string;
  source: 'task' | 'mobile' | 'pipeline';
  projectPath: string;
  projectName: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreateTokens?: number;
  taskId?: string;
}): void {
  const family = getModelFamily(opts.model);
  const cost = calcCost(family, opts.inputTokens, opts.outputTokens, opts.cacheReadTokens || 0, opts.cacheCreateTokens || 0);
  const now = new Date().toISOString();

  db().prepare(`
    INSERT INTO token_usage (session_id, source, project_path, project_name, model, input_tokens, output_tokens, cache_read_tokens, cache_create_tokens, cost_usd, message_count, started_at, completed_at, task_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
    ON CONFLICT(session_id, source, model) DO UPDATE SET
      input_tokens = token_usage.input_tokens + excluded.input_tokens,
      output_tokens = token_usage.output_tokens + excluded.output_tokens,
      cost_usd = token_usage.cost_usd + excluded.cost_usd,
      message_count = token_usage.message_count + 1,
      completed_at = excluded.completed_at
  `).run(opts.sessionId, opts.source, opts.projectPath, opts.projectName, family, opts.inputTokens, opts.outputTokens, opts.cacheReadTokens || 0, opts.cacheCreateTokens || 0, cost, now, now, opts.taskId || null);
}

/** Query usage data */
export function queryUsage(opts: {
  days?: number;
  projectName?: string;
  source?: string;
  model?: string;
}): {
  total: { input: number; output: number; cost: number; sessions: number; messages: number };
  byProject: { name: string; input: number; output: number; cost: number; sessions: number }[];
  byModel: { model: string; input: number; output: number; cost: number; messages: number }[];
  byDay: { date: string; input: number; output: number; cost: number }[];
  bySource: { source: string; input: number; output: number; cost: number; messages: number }[];
} {
  let where = '1=1';
  const params: any[] = [];

  if (opts.days) {
    where += ` AND completed_at >= datetime('now', '-${opts.days} days')`;
  }
  if (opts.projectName) {
    where += ' AND project_name = ?';
    params.push(opts.projectName);
  }
  if (opts.source) {
    where += ' AND source = ?';
    params.push(opts.source);
  }
  if (opts.model) {
    where += ' AND model = ?';
    params.push(opts.model);
  }

  // Total
  const totalRow = db().prepare(`
    SELECT COALESCE(SUM(input_tokens), 0) as input, COALESCE(SUM(output_tokens), 0) as output,
           COALESCE(SUM(cost_usd), 0) as cost, COUNT(DISTINCT session_id) as sessions,
           COALESCE(SUM(message_count), 0) as messages
    FROM token_usage WHERE ${where}
  `).get(...params) as any;

  // By project
  const byProject = (db().prepare(`
    SELECT project_name as name, SUM(input_tokens) as input, SUM(output_tokens) as output,
           SUM(cost_usd) as cost, COUNT(DISTINCT session_id) as sessions
    FROM token_usage WHERE ${where}
    GROUP BY project_name ORDER BY cost DESC LIMIT 20
  `).all(...params) as any[]).map(r => ({
    name: r.name, input: r.input, output: r.output, cost: Number(r.cost.toFixed(4)), sessions: r.sessions,
  }));

  // By model
  const byModel = (db().prepare(`
    SELECT model, SUM(input_tokens) as input, SUM(output_tokens) as output,
           SUM(cost_usd) as cost, SUM(message_count) as messages
    FROM token_usage WHERE ${where}
    GROUP BY model ORDER BY cost DESC
  `).all(...params) as any[]).map(r => ({
    model: r.model, input: r.input, output: r.output, cost: Number(r.cost.toFixed(4)), messages: r.messages,
  }));

  // By day
  const byDay = (db().prepare(`
    SELECT date(completed_at) as date, SUM(input_tokens) as input, SUM(output_tokens) as output,
           SUM(cost_usd) as cost
    FROM token_usage WHERE ${where} AND completed_at IS NOT NULL
    GROUP BY date(completed_at) ORDER BY date DESC LIMIT 30
  `).all(...params) as any[]).map(r => ({
    date: r.date, input: r.input, output: r.output, cost: Number(r.cost.toFixed(4)),
  }));

  // By source
  const bySource = (db().prepare(`
    SELECT source, SUM(input_tokens) as input, SUM(output_tokens) as output,
           SUM(cost_usd) as cost, SUM(message_count) as messages
    FROM token_usage WHERE ${where}
    GROUP BY source ORDER BY cost DESC
  `).all(...params) as any[]).map(r => ({
    source: r.source, input: r.input, output: r.output, cost: Number(r.cost.toFixed(4)), messages: r.messages,
  }));

  return {
    total: { input: totalRow.input, output: totalRow.output, cost: Number(totalRow.cost.toFixed(4)), sessions: totalRow.sessions, messages: totalRow.messages },
    byProject, byModel, byDay, bySource,
  };
}
