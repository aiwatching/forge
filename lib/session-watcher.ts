/**
 * Session Watcher — monitors Claude CLI sessions and sends Telegram notifications.
 *
 * Watchers track entry counts in sessions. When new entries appear,
 * a summary is sent to Telegram. Also detects idle/completed sessions.
 */

import { randomUUID } from 'node:crypto';
import { getDb } from '@/src/core/db/database';
import { join } from 'node:path';
import { getDataDir } from './dirs';
import {
  listClaudeSessions,
  getSessionFilePath,
  readSessionEntries,
  type ClaudeSessionInfo,
  type SessionEntry,
} from './claude-sessions';
import { scanProjects } from './projects';
import { loadSettings } from './settings';

const DB_PATH = join(getDataDir(), 'workflow.db');

// ─── Types ───────────────────────────────────────────────────

export interface SessionWatcher {
  id: string;
  projectName: string;
  sessionId: string | null;    // null = watch all sessions in project
  label: string | null;
  checkInterval: number;       // seconds
  lastEntryCount: number;
  lastChecked: string | null;
  notifyOnChange: boolean;
  notifyOnIdle: boolean;
  idleThreshold: number;       // seconds
  active: boolean;
  createdAt: string;
}

// ─── Session cache sync ──────────────────────────────────────

export function syncSessionsToDb(projectName?: string) {
  const db = getDb(DB_PATH);
  const projects = projectName
    ? [{ name: projectName }]
    : scanProjects().map((p: { name: string }) => ({ name: p.name }));

  const upsert = db.prepare(`
    INSERT INTO cached_sessions (project_name, session_id, summary, first_prompt, message_count, created, modified, git_branch, file_size, last_synced)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(project_name, session_id) DO UPDATE SET
      summary = excluded.summary,
      first_prompt = excluded.first_prompt,
      message_count = excluded.message_count,
      created = excluded.created,
      modified = excluded.modified,
      git_branch = excluded.git_branch,
      file_size = excluded.file_size,
      last_synced = datetime('now')
  `);

  const updateEntryCount = db.prepare(`
    UPDATE cached_sessions SET entry_count = ? WHERE project_name = ? AND session_id = ?
  `);

  let totalSynced = 0;

  for (const proj of projects) {
    const sessions = listClaudeSessions(proj.name);
    for (const s of sessions) {
      upsert.run(
        proj.name, s.sessionId, s.summary || null, s.firstPrompt || null,
        s.messageCount || 0, s.created || null, s.modified || null,
        s.gitBranch || null, s.fileSize,
      );

      // Count entries for watcher comparison
      const fp = getSessionFilePath(proj.name, s.sessionId);
      if (fp) {
        try {
          const entries = readSessionEntries(fp);
          updateEntryCount.run(entries.length, proj.name, s.sessionId);
        } catch {}
      }

      totalSynced++;
    }
  }

  return totalSynced;
}

export function getCachedSessions(projectName: string): ClaudeSessionInfo[] {
  const db = getDb(DB_PATH);
  const rows = db.prepare(`
    SELECT session_id, summary, first_prompt, message_count, created, modified, git_branch, file_size
    FROM cached_sessions WHERE project_name = ? ORDER BY modified DESC
  `).all(projectName) as any[];

  return rows.map(r => ({
    sessionId: r.session_id,
    summary: r.summary,
    firstPrompt: r.first_prompt,
    messageCount: r.message_count,
    created: r.created,
    modified: r.modified,
    gitBranch: r.git_branch,
    fileSize: r.file_size,
  }));
}

export function getAllCachedSessions(): Record<string, ClaudeSessionInfo[]> {
  const db = getDb(DB_PATH);
  const rows = db.prepare(`
    SELECT project_name, session_id, summary, first_prompt, message_count, created, modified, git_branch, file_size
    FROM cached_sessions ORDER BY project_name, modified DESC
  `).all() as any[];

  const result: Record<string, ClaudeSessionInfo[]> = {};
  for (const r of rows) {
    if (!result[r.project_name]) result[r.project_name] = [];
    result[r.project_name].push({
      sessionId: r.session_id,
      summary: r.summary,
      firstPrompt: r.first_prompt,
      messageCount: r.message_count,
      created: r.created,
      modified: r.modified,
      gitBranch: r.git_branch,
      fileSize: r.file_size,
    });
  }
  return result;
}

// ─── Watcher CRUD ────────────────────────────────────────────

export function createWatcher(opts: {
  projectName: string;
  sessionId?: string;
  label?: string;
  checkInterval?: number;
}): SessionWatcher {
  const db = getDb(DB_PATH);
  const id = randomUUID().slice(0, 8);

  db.prepare(`
    INSERT INTO session_watchers (id, project_name, session_id, label, check_interval)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, opts.projectName, opts.sessionId || null, opts.label || null, opts.checkInterval || 60);

  return getWatcher(id)!;
}

export function getWatcher(id: string): SessionWatcher | null {
  const db = getDb(DB_PATH);
  const row = db.prepare('SELECT * FROM session_watchers WHERE id = ?').get(id) as any;
  return row ? mapWatcherRow(row) : null;
}

export function listWatchers(activeOnly = false): SessionWatcher[] {
  const db = getDb(DB_PATH);
  const sql = activeOnly
    ? 'SELECT * FROM session_watchers WHERE active = 1 ORDER BY created_at DESC'
    : 'SELECT * FROM session_watchers ORDER BY created_at DESC';
  return (db.prepare(sql).all() as any[]).map(mapWatcherRow);
}

export function toggleWatcher(id: string, active: boolean) {
  const db = getDb(DB_PATH);
  db.prepare('UPDATE session_watchers SET active = ? WHERE id = ?').run(active ? 1 : 0, id);
}

export function deleteWatcher(id: string) {
  const db = getDb(DB_PATH);
  db.prepare('DELETE FROM session_watchers WHERE id = ?').run(id);
}

function mapWatcherRow(row: any): SessionWatcher {
  return {
    id: row.id,
    projectName: row.project_name,
    sessionId: row.session_id,
    label: row.label,
    checkInterval: row.check_interval,
    lastEntryCount: row.last_entry_count,
    lastChecked: row.last_checked,
    notifyOnChange: !!row.notify_on_change,
    notifyOnIdle: !!row.notify_on_idle,
    idleThreshold: row.idle_threshold,
    active: !!row.active,
    createdAt: row.created_at,
  };
}

// ─── Watcher check loop ─────────────────────────────────────

let watcherInterval: ReturnType<typeof setInterval> | null = null;

export function startWatcherLoop() {
  if (watcherInterval) return;

  // Initial sync
  try { syncSessionsToDb(); } catch (e) { console.error('[watcher] Initial sync error:', e); }

  // Check every 30 seconds
  watcherInterval = setInterval(runWatcherCheck, 30_000);
  console.log('[watcher] Started session watcher loop');
}

export function stopWatcherLoop() {
  if (watcherInterval) {
    clearInterval(watcherInterval);
    watcherInterval = null;
  }
}

async function runWatcherCheck() {
  const db = getDb(DB_PATH);
  const watchers = listWatchers(true);
  if (watchers.length === 0) return;

  const now = Date.now();

  for (const w of watchers) {
    // Check if it's time
    if (w.lastChecked) {
      const elapsed = (now - new Date(w.lastChecked).getTime()) / 1000;
      if (elapsed < w.checkInterval) continue;
    }

    try {
      if (w.sessionId) {
        // Watch specific session
        await checkSession(db, w, w.projectName, w.sessionId);
      } else {
        // Watch all sessions in project
        const sessions = listClaudeSessions(w.projectName);
        for (const s of sessions) {
          await checkSession(db, w, w.projectName, s.sessionId);
        }
      }

      // Update last checked
      db.prepare('UPDATE session_watchers SET last_checked = datetime(\'now\') WHERE id = ?').run(w.id);
    } catch (e) {
      console.error(`[watcher] Error checking ${w.id}:`, e);
    }
  }

  // Periodic session sync (every check cycle)
  try { syncSessionsToDb(); } catch {}
}

async function checkSession(
  db: ReturnType<typeof getDb>,
  watcher: SessionWatcher,
  projectName: string,
  sessionId: string,
) {
  const fp = getSessionFilePath(projectName, sessionId);
  if (!fp) return;

  const entries = readSessionEntries(fp);
  const currentCount = entries.length;

  // Get last known count from cached_sessions
  const cached = db.prepare(
    'SELECT entry_count FROM cached_sessions WHERE project_name = ? AND session_id = ?'
  ).get(projectName, sessionId) as any;

  const lastCount = cached?.entry_count || 0;

  if (currentCount > lastCount && watcher.notifyOnChange) {
    // New entries! Summarize the changes
    const newEntries = entries.slice(lastCount);
    const summary = summarizeEntries(newEntries);
    const label = watcher.label || `${projectName}/${sessionId.slice(0, 8)}`;

    await sendWatcherNotification(
      `📋 *${esc(label)}*\n\n` +
      `${summary}\n\n` +
      `_${currentCount} total entries (+${currentCount - lastCount} new)_`
    );

    // Update cached entry count
    db.prepare(
      'UPDATE cached_sessions SET entry_count = ? WHERE project_name = ? AND session_id = ?'
    ).run(currentCount, projectName, sessionId);
  }
}

function summarizeEntries(entries: SessionEntry[]): string {
  const parts: string[] = [];
  let assistantText = '';
  let toolNames: string[] = [];

  for (const e of entries) {
    if (e.type === 'user') {
      parts.push(`👤 ${e.content.slice(0, 150)}`);
    } else if (e.type === 'assistant_text') {
      assistantText = e.content.slice(0, 300);
    } else if (e.type === 'tool_use' && e.toolName) {
      toolNames.push(e.toolName);
    }
  }

  if (toolNames.length > 0) {
    const unique = [...new Set(toolNames)];
    parts.push(`🔧 Tools: ${unique.join(', ')}`);
  }

  if (assistantText) {
    parts.push(`🤖 ${assistantText}`);
  }

  return parts.join('\n') || 'Activity detected';
}

async function sendWatcherNotification(text: string) {
  const settings = loadSettings();
  const { telegramBotToken, telegramChatId } = settings;
  if (!telegramBotToken || !telegramChatId) return;

  try {
    const url = `https://api.telegram.org/bot${telegramBotToken}/sendMessage`;
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: telegramChatId,
        text,
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
      }),
    });
  } catch (err) {
    console.error('[watcher] Telegram send failed:', err);
  }
}

function esc(s: string): string {
  return s.replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');
}
