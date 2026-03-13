/**
 * Task Manager — persistent task queue backed by SQLite.
 * Tasks survive server restarts. Background runner picks up queued tasks.
 */

import { randomUUID } from 'node:crypto';
import { spawn, execSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { getDb } from '@/src/core/db/database';
import { getDbPath } from '@/src/config';
import { loadSettings } from './settings';
import { notifyTaskComplete, notifyTaskFailed } from './notify';
import type { Task, TaskLogEntry, TaskStatus } from '@/src/types';

let runner: ReturnType<typeof setInterval> | null = null;
let currentTaskId: string | null = null;

// Event listeners for real-time updates
type TaskListener = (taskId: string, event: 'log' | 'status', data?: any) => void;
const listeners = new Set<TaskListener>();

export function onTaskEvent(fn: TaskListener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(taskId: string, event: 'log' | 'status', data?: any) {
  for (const fn of listeners) {
    try { fn(taskId, event, data); } catch {}
  }
}

function db() {
  return getDb(getDbPath());
}

// ─── CRUD ────────────────────────────────────────────────────

export function createTask(opts: {
  projectName: string;
  projectPath: string;
  prompt: string;
  priority?: number;
  conversationId?: string;  // Explicit override; otherwise auto-inherits from project
  scheduledAt?: string;     // ISO timestamp — task won't run until this time
}): Task {
  const id = randomUUID().slice(0, 8);

  // Auto-inherit conversation_id from the project's last completed task
  // Pass explicit empty string to force a new session
  const convId = opts.conversationId === ''
    ? null
    : (opts.conversationId || getProjectConversationId(opts.projectName));

  db().prepare(`
    INSERT INTO tasks (id, project_name, project_path, prompt, status, priority, conversation_id, log, scheduled_at)
    VALUES (?, ?, ?, ?, 'queued', ?, ?, '[]', ?)
  `).run(id, opts.projectName, opts.projectPath, opts.prompt, opts.priority || 0, convId || null, opts.scheduledAt || null);

  // Kick the runner
  ensureRunnerStarted();

  return getTask(id)!;
}

/**
 * Get the most recent conversation_id for a project.
 * This allows all tasks for the same project to share one Claude session.
 */
export function getProjectConversationId(projectName: string): string | null {
  const row = db().prepare(`
    SELECT conversation_id FROM tasks
    WHERE project_name = ? AND conversation_id IS NOT NULL AND status = 'done'
    ORDER BY completed_at DESC LIMIT 1
  `).get(projectName) as any;
  return row?.conversation_id || null;
}

export function getTask(id: string): Task | null {
  const row = db().prepare('SELECT * FROM tasks WHERE id = ?').get(id) as any;
  if (!row) return null;
  return rowToTask(row);
}

export function listTasks(status?: TaskStatus): Task[] {
  let query = 'SELECT * FROM tasks';
  const params: string[] = [];
  if (status) {
    query += ' WHERE status = ?';
    params.push(status);
  }
  query += ' ORDER BY created_at DESC';
  const rows = db().prepare(query).all(...params) as any[];
  return rows.map(rowToTask);
}

export function cancelTask(id: string): boolean {
  const task = getTask(id);
  if (!task) return false;
  if (task.status === 'done' || task.status === 'failed') return false;

  if (task.status === 'running' && currentTaskId === id) {
    // Will be handled by the runner
    updateTaskStatus(id, 'cancelled');
    return true;
  }

  updateTaskStatus(id, 'cancelled');
  return true;
}

export function deleteTask(id: string): boolean {
  const task = getTask(id);
  if (!task) return false;
  if (task.status === 'running') cancelTask(id);
  db().prepare('DELETE FROM tasks WHERE id = ?').run(id);
  return true;
}

export function retryTask(id: string): Task | null {
  const task = getTask(id);
  if (!task) return null;
  if (task.status !== 'failed' && task.status !== 'cancelled') return null;

  // Create a new task with same params
  return createTask({
    projectName: task.projectName,
    projectPath: task.projectPath,
    prompt: task.prompt,
    priority: task.priority,
  });
}

// ─── Background Runner ───────────────────────────────────────

export function ensureRunnerStarted() {
  if (runner) return;
  runner = setInterval(processNextTask, 3000);
  // Also try immediately
  processNextTask();
}

export function stopRunner() {
  if (runner) {
    clearInterval(runner);
    runner = null;
  }
}

async function processNextTask() {
  if (currentTaskId) return; // Already running one

  const next = db().prepare(`
    SELECT * FROM tasks WHERE status = 'queued'
    AND (scheduled_at IS NULL OR scheduled_at <= datetime('now'))
    ORDER BY priority DESC, created_at ASC LIMIT 1
  `).get() as any;

  if (!next) return;

  const task = rowToTask(next);
  currentTaskId = task.id;

  try {
    await executeTask(task);
  } catch (err: any) {
    appendLog(task.id, { type: 'system', subtype: 'error', content: err.message, timestamp: new Date().toISOString() });
    updateTaskStatus(task.id, 'failed', err.message);
  } finally {
    currentTaskId = null;
  }
}

function executeTask(task: Task): Promise<void> {
  return new Promise((resolve, reject) => {
    const settings = loadSettings();
    const claudePath = settings.claudePath || process.env.CLAUDE_PATH || 'claude';

    const args = ['-p', '--verbose', '--output-format', 'stream-json'];

    // Resume specific session to continue the conversation
    if (task.conversationId) {
      args.push('--resume', task.conversationId);
    }

    args.push(task.prompt);

    const env = { ...process.env };
    delete env.CLAUDECODE;

    updateTaskStatus(task.id, 'running');
    db().prepare('UPDATE tasks SET started_at = datetime(\'now\') WHERE id = ?').run(task.id);

    // Resolve the actual claude CLI script path (claude is a symlink to a .js file)
    const resolvedClaude = resolveClaudePath(claudePath);
    console.log(`[task-runner] Spawning: ${resolvedClaude.cmd} ${resolvedClaude.prefix.concat(args).join(' ')}`);
    console.log(`[task-runner] CWD: ${task.projectPath}`);

    const child = spawn(resolvedClaude.cmd, [...resolvedClaude.prefix, ...args], {
      cwd: task.projectPath,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let buffer = '';
    let resultText = '';
    let totalCost = 0;
    let sessionId = '';

    child.on('error', (err) => {
      console.error(`[task-runner] Spawn error:`, err.message);
      updateTaskStatus(task.id, 'failed', err.message);
      reject(err);
    });

    child.stdout?.on('data', (data: Buffer) => {
      console.log(`[task-runner] stdout chunk: ${data.toString().slice(0, 200)}`);

      // Check if cancelled
      if (getTask(task.id)?.status === 'cancelled') {
        child.kill('SIGTERM');
        return;
      }

      buffer += data.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          const entries = parseStreamJson(parsed);
          for (const entry of entries) {
            appendLog(task.id, entry);
          }

          if (parsed.session_id) sessionId = parsed.session_id;
          if (parsed.type === 'result') {
            resultText = typeof parsed.result === 'string' ? parsed.result : JSON.stringify(parsed.result);
            totalCost = parsed.total_cost_usd || 0;
          }
        } catch {}
      }
    });

    child.stderr?.on('data', (data: Buffer) => {
      const text = data.toString().trim();
      console.error(`[task-runner] stderr: ${text.slice(0, 300)}`);
      if (text) {
        appendLog(task.id, { type: 'system', subtype: 'error', content: text, timestamp: new Date().toISOString() });
      }
    });

    child.on('exit', (code, signal) => {
      console.log(`[task-runner] Process exited: code=${code}, signal=${signal}`);
      // Process remaining buffer
      if (buffer.trim()) {
        try {
          const parsed = JSON.parse(buffer);
          const entries = parseStreamJson(parsed);
          for (const entry of entries) appendLog(task.id, entry);
          if (parsed.type === 'result') {
            resultText = typeof parsed.result === 'string' ? parsed.result : JSON.stringify(parsed.result);
            totalCost = parsed.total_cost_usd || 0;
          }
        } catch {}
      }

      // Save conversation ID for follow-up
      if (sessionId) {
        db().prepare('UPDATE tasks SET conversation_id = ? WHERE id = ?').run(sessionId, task.id);
      }

      // Capture git diff
      try {
        const { execSync } = require('node:child_process');
        const diff = execSync('git diff HEAD', { cwd: task.projectPath, timeout: 5000 }).toString();
        if (diff.trim()) {
          db().prepare('UPDATE tasks SET git_diff = ? WHERE id = ?').run(diff, task.id);
        }
      } catch {}

      const currentStatus = getTask(task.id)?.status;
      if (currentStatus === 'cancelled') {
        resolve();
        return;
      }

      if (code === 0) {
        db().prepare(`
          UPDATE tasks SET status = 'done', result_summary = ?, cost_usd = ?, completed_at = datetime('now')
          WHERE id = ?
        `).run(resultText, totalCost, task.id);
        emit(task.id, 'status', 'done');
        const doneTask = getTask(task.id);
        if (doneTask) notifyTaskComplete(doneTask).catch(() => {});
        resolve();
      } else {
        const errMsg = `Process exited with code ${code}`;
        updateTaskStatus(task.id, 'failed', errMsg);
        const failedTask = getTask(task.id);
        if (failedTask) notifyTaskFailed(failedTask).catch(() => {});
        reject(new Error(errMsg));
      }
    });

    child.on('error', (err) => {
      updateTaskStatus(task.id, 'failed', err.message);
      reject(err);
    });
  });
}

// ─── Helpers ─────────────────────────────────────────────────

/**
 * Resolve the claude binary path. `claude` is typically a symlink to a .js file,
 * which can't be spawned directly without a shell. We resolve to the real .js path
 * and run it with `node`.
 */
function resolveClaudePath(claudePath: string): { cmd: string; prefix: string[] } {
  try {
    // Try to find the real path
    let resolved = claudePath;
    try {
      const which = execSync(`which ${claudePath}`, { encoding: 'utf-8' }).trim();
      resolved = realpathSync(which);
    } catch {
      resolved = realpathSync(claudePath);
    }

    // If it's a .js file, run with node
    if (resolved.endsWith('.js') || resolved.endsWith('.mjs')) {
      return { cmd: process.execPath, prefix: [resolved] };
    }

    return { cmd: resolved, prefix: [] };
  } catch {
    // Fallback: use node to run it
    return { cmd: process.execPath, prefix: [claudePath] };
  }
}

function parseStreamJson(parsed: any): TaskLogEntry[] {
  const entries: TaskLogEntry[] = [];
  const ts = new Date().toISOString();

  if (parsed.type === 'system' && parsed.subtype === 'init') {
    entries.push({ type: 'system', subtype: 'init', content: `Model: ${parsed.model || 'unknown'}`, timestamp: ts });
    return entries;
  }

  if (parsed.type === 'assistant' && parsed.message?.content) {
    for (const block of parsed.message.content) {
      if (block.type === 'text' && block.text) {
        entries.push({ type: 'assistant', subtype: 'text', content: block.text, timestamp: ts });
      } else if (block.type === 'tool_use') {
        entries.push({
          type: 'assistant',
          subtype: 'tool_use',
          content: typeof block.input === 'string' ? block.input : JSON.stringify(block.input || {}),
          tool: block.name,
          timestamp: ts,
        });
      } else if (block.type === 'tool_result') {
        entries.push({
          type: 'assistant',
          subtype: 'tool_result',
          content: typeof block.content === 'string' ? block.content : JSON.stringify(block.content || ''),
          timestamp: ts,
        });
      }
    }
    return entries;
  }

  if (parsed.type === 'result') {
    entries.push({
      type: 'result',
      subtype: parsed.subtype || 'success',
      content: typeof parsed.result === 'string' ? parsed.result : JSON.stringify(parsed.result || ''),
      timestamp: ts,
    });
    return entries;
  }

  if (parsed.type === 'rate_limit_event') return entries;

  entries.push({ type: 'assistant', subtype: parsed.type || 'unknown', content: JSON.stringify(parsed), timestamp: ts });
  return entries;
}

function appendLog(taskId: string, entry: TaskLogEntry) {
  const row = db().prepare('SELECT log FROM tasks WHERE id = ?').get(taskId) as any;
  if (!row) return;
  const log: TaskLogEntry[] = JSON.parse(row.log);
  log.push(entry);
  db().prepare('UPDATE tasks SET log = ? WHERE id = ?').run(JSON.stringify(log), taskId);
  emit(taskId, 'log', entry);
}

function updateTaskStatus(id: string, status: TaskStatus, error?: string) {
  if (status === 'failed' || status === 'cancelled') {
    db().prepare('UPDATE tasks SET status = ?, error = ?, completed_at = datetime(\'now\') WHERE id = ?').run(status, error || null, id);
  } else {
    db().prepare('UPDATE tasks SET status = ? WHERE id = ?').run(status, id);
  }
  emit(id, 'status', status);
}

function rowToTask(row: any): Task {
  return {
    id: row.id,
    projectName: row.project_name,
    projectPath: row.project_path,
    prompt: row.prompt,
    status: row.status,
    priority: row.priority,
    conversationId: row.conversation_id || undefined,
    log: JSON.parse(row.log || '[]'),
    resultSummary: row.result_summary || undefined,
    gitDiff: row.git_diff || undefined,
    gitBranch: row.git_branch || undefined,
    costUSD: row.cost_usd || undefined,
    error: row.error || undefined,
    createdAt: row.created_at,
    startedAt: row.started_at || undefined,
    completedAt: row.completed_at || undefined,
    scheduledAt: row.scheduled_at || undefined,
  };
}
