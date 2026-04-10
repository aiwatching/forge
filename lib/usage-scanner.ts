/**
 * Usage Scanner — scans Claude Code JSONL session files for token usage data.
 * Stores per-day aggregated results in SQLite for accurate daily breakdown.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { getDb } from '@/src/core/db/database';
import { getDbPath } from '@/src/config';
import { getClaudeDir } from './dirs';

function db() { return getDb(getDbPath()); }

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

function calcCost(family: string, input: number, output: number): number {
  const p = PRICING[family] || PRICING['default'];
  // Only count input + output tokens. Cache tokens excluded from cost estimate
  // because subscriptions (Max/Pro) don't charge per-token for cache.
  return (input * p.input / 1_000_000) + (output * p.output / 1_000_000);
}

function dirToProjectPath(dirName: string): string {
  return dirName.replace(/^-/, '/').replace(/-/g, '/');
}

function dirToProjectName(dirName: string): string {
  return dirToProjectPath(dirName).split('/').pop() || dirName;
}

/** Get local date string from UTC timestamp */
function toLocalDate(ts: string): string {
  if (!ts) return 'unknown';
  try {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  } catch {
    return ts.slice(0, 10) || 'unknown';
  }
}

interface DayModelBucket {
  input: number; output: number; cacheRead: number; cacheCreate: number; count: number;
}

/** Parse JSONL and aggregate by day + model */
function parseByDayModel(content: string): Map<string, DayModelBucket> {
  // key: "day|model"
  const buckets = new Map<string, DayModelBucket>();

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.type === 'assistant' && obj.message?.usage) {
        const u = obj.message.usage;
        const model = getModelFamily(obj.message.model || '');
        const day = toLocalDate(obj.timestamp || '');
        const key = `${day}|${model}`;

        let b = buckets.get(key);
        if (!b) { b = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, count: 0 }; buckets.set(key, b); }
        b.input += u.input_tokens || 0;
        b.output += u.output_tokens || 0;
        b.cacheRead += u.cache_read_input_tokens || 0;
        b.cacheCreate += u.cache_creation_input_tokens || 0;
        b.count++;
      }
    } catch {}
  }
  return buckets;
}

/** Scan all JSONL files */
export function scanUsage(): { scanned: number; updated: number; errors: number } {
  const projectsDir = join(getClaudeDir(), 'projects');
  let scanned = 0, updated = 0, errors = 0;

  let projectDirs: string[];
  try { projectDirs = readdirSync(projectsDir); } catch { return { scanned: 0, updated: 0, errors: 0 }; }

  const upsert = db().prepare(`
    INSERT INTO token_usage (session_id, source, project_path, project_name, model, day, input_tokens, output_tokens, cache_read_tokens, cache_create_tokens, cost_usd, message_count)
    VALUES (?, 'terminal', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id, source, model, day) DO UPDATE SET
      input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens,
      cache_read_tokens = excluded.cache_read_tokens, cache_create_tokens = excluded.cache_create_tokens,
      cost_usd = excluded.cost_usd, message_count = excluded.message_count
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
    try { files = readdirSync(projPath).filter(f => f.endsWith('.jsonl') && !f.startsWith('agent-')); } catch { continue; }

    for (const file of files) {
      const filePath = join(projPath, file);
      const sessionId = basename(file, '.jsonl');
      scanned++;

      try {
        const currentSize = statSync(filePath).size;
        const scanState = getScanState.get(filePath) as { last_size: number } | undefined;
        if (currentSize === (scanState?.last_size || 0)) continue;

        const content = readFileSync(filePath, 'utf-8');
        const buckets = parseByDayModel(content);

        if (buckets.size === 0) { setScanState.run(filePath, currentSize); continue; }

        for (const [key, b] of buckets) {
          const [day, model] = key.split('|');
          const cost = calcCost(model, b.input, b.output);
          upsert.run(sessionId, projectPath, projectName, model, day, b.input, b.output, b.cacheRead, b.cacheCreate, cost, b.count);
        }

        setScanState.run(filePath, currentSize);
        updated++;
      } catch { errors++; }
    }
  }
  return { scanned, updated, errors };
}

/** Record usage from task/mobile/pipeline */
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
  const cost = calcCost(family, opts.inputTokens, opts.outputTokens);
  const day = toLocalDate(new Date().toISOString());

  db().prepare(`
    INSERT INTO token_usage (session_id, source, project_path, project_name, model, day, input_tokens, output_tokens, cache_read_tokens, cache_create_tokens, cost_usd, message_count, task_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
    ON CONFLICT(session_id, source, model, day) DO UPDATE SET
      input_tokens = token_usage.input_tokens + excluded.input_tokens,
      output_tokens = token_usage.output_tokens + excluded.output_tokens,
      cost_usd = token_usage.cost_usd + excluded.cost_usd,
      message_count = token_usage.message_count + 1
  `).run(opts.sessionId, opts.source, opts.projectPath, opts.projectName, family, day, opts.inputTokens, opts.outputTokens, opts.cacheReadTokens || 0, opts.cacheCreateTokens || 0, cost, opts.taskId || null);
}

/** Query usage data */
export function queryUsage(opts: {
  days?: number;
  projectName?: string;
  source?: string;
  model?: string;
}): {
  total: { input: number; output: number; cacheRead: number; cacheCreate: number; cost: number; sessions: number; messages: number };
  byProject: { name: string; input: number; output: number; cost: number; sessions: number }[];
  byModel: { model: string; input: number; output: number; cost: number; messages: number }[];
  byDay: { date: string; input: number; output: number; cacheRead: number; cacheCreate: number; cost: number; messages: number }[];
  bySource: { source: string; input: number; output: number; cost: number; messages: number }[];
} {
  let where = '1=1';
  const params: any[] = [];

  if (opts.days) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - opts.days);
    const cutoffDay = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, '0')}-${String(cutoff.getDate()).padStart(2, '0')}`;
    where += ' AND day >= ?';
    params.push(cutoffDay);
  }
  if (opts.projectName) { where += ' AND project_name = ?'; params.push(opts.projectName); }
  if (opts.source) { where += ' AND source = ?'; params.push(opts.source); }
  if (opts.model) { where += ' AND model = ?'; params.push(opts.model); }

  const totalRow = db().prepare(`
    SELECT COALESCE(SUM(input_tokens), 0) as input, COALESCE(SUM(output_tokens), 0) as output,
           COALESCE(SUM(cache_read_tokens), 0) as cacheRead, COALESCE(SUM(cache_create_tokens), 0) as cacheCreate,
           COALESCE(SUM(cost_usd), 0) as cost, COUNT(DISTINCT session_id) as sessions,
           COALESCE(SUM(message_count), 0) as messages
    FROM token_usage WHERE ${where}
  `).get(...params) as any;

  const byProject = (db().prepare(`
    SELECT project_name as name, SUM(input_tokens) as input, SUM(output_tokens) as output,
           SUM(cost_usd) as cost, COUNT(DISTINCT session_id) as sessions
    FROM token_usage WHERE ${where}
    GROUP BY project_name ORDER BY cost DESC LIMIT 20
  `).all(...params) as any[]).map(r => ({
    name: r.name, input: r.input, output: r.output, cost: +r.cost.toFixed(4), sessions: r.sessions,
  }));

  const byModel = (db().prepare(`
    SELECT model, SUM(input_tokens) as input, SUM(output_tokens) as output,
           SUM(cost_usd) as cost, SUM(message_count) as messages
    FROM token_usage WHERE ${where}
    GROUP BY model ORDER BY cost DESC
  `).all(...params) as any[]).map(r => ({
    model: r.model, input: r.input, output: r.output, cost: +r.cost.toFixed(4), messages: r.messages,
  }));

  const byDay = (db().prepare(`
    SELECT day as date, SUM(input_tokens) as input, SUM(output_tokens) as output,
           SUM(cache_read_tokens) as cacheRead, SUM(cache_create_tokens) as cacheCreate,
           SUM(cost_usd) as cost, SUM(message_count) as messages
    FROM token_usage WHERE ${where} AND day != 'unknown'
    GROUP BY day ORDER BY day DESC LIMIT 30
  `).all(...params) as any[]).map(r => ({
    date: r.date, input: r.input, output: r.output,
    cacheRead: r.cacheRead || 0, cacheCreate: r.cacheCreate || 0,
    cost: +r.cost.toFixed(4), messages: r.messages || 0,
  }));

  const bySource = (db().prepare(`
    SELECT source, SUM(input_tokens) as input, SUM(output_tokens) as output,
           SUM(cost_usd) as cost, SUM(message_count) as messages
    FROM token_usage WHERE ${where}
    GROUP BY source ORDER BY cost DESC
  `).all(...params) as any[]).map(r => ({
    source: r.source, input: r.input, output: r.output, cost: +r.cost.toFixed(4), messages: r.messages,
  }));

  return {
    total: {
      input: totalRow.input, output: totalRow.output,
      cacheRead: totalRow.cacheRead || 0, cacheCreate: totalRow.cacheCreate || 0,
      cost: +totalRow.cost.toFixed(4), sessions: totalRow.sessions, messages: totalRow.messages,
    },
    byProject, byModel, byDay, bySource,
  };
}
