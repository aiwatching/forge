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
import type { Task, TaskLogEntry, TaskStatus, TaskMode, WatchConfig } from '@/src/types';

/** Normalize SQLite datetime('now') → ISO 8601 UTC string. */
function toIsoUTC(s: string | null | undefined): string | null {
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) return s.replace(' ', 'T') + 'Z';
  return s;
}

const runnerKey = Symbol.for('mw-task-runner');
const gRunner = globalThis as any;
if (!gRunner[runnerKey]) gRunner[runnerKey] = { runner: null, currentTaskId: null };
const runnerState: { runner: ReturnType<typeof setInterval> | null; currentTaskId: string | null } = gRunner[runnerKey];

// Per-project concurrency: track which projects have a running prompt task
const runningProjects = new Set<string>();

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

// Per-task model overrides (used by pipeline to set pipelineModel)
export const taskModelOverrides = new Map<string, string>();

// ─── CRUD ────────────────────────────────────────────────────

export function createTask(opts: {
  projectName: string;
  projectPath: string;
  prompt: string;
  mode?: TaskMode;
  priority?: number;
  conversationId?: string;  // Explicit override; otherwise auto-inherits from project
  scheduledAt?: string;     // ISO timestamp — task won't run until this time
  watchConfig?: WatchConfig;
  agent?: string;           // Agent ID (default: from settings)
}): Task {
  const id = randomUUID().slice(0, 8);
  const mode = opts.mode || 'prompt';
  const agent = opts.agent || '';

  // For prompt mode: auto-inherit conversation_id
  // For monitor mode: conversationId is required (the session to watch)
  const convId = opts.conversationId === ''
    ? null
    : (opts.conversationId || (mode === 'prompt' ? getProjectConversationId(opts.projectName) : null));

  db().prepare(`
    INSERT INTO tasks (id, project_name, project_path, prompt, mode, status, priority, conversation_id, log, scheduled_at, watch_config, agent)
    VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, '[]', ?, ?, ?)
  `).run(
    id, opts.projectName, opts.projectPath, opts.prompt, mode,
    opts.priority || 0, convId || null, opts.scheduledAt || null,
    opts.watchConfig ? JSON.stringify(opts.watchConfig) : null,
    agent || null,
  );

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

  // Cancel monitor tasks
  if (task.mode === 'monitor' && activeMonitors.has(id)) {
    cancelMonitor(id);
    return true;
  }

  updateTaskStatus(id, 'cancelled');

  // Clean up project lock if this was a running prompt task
  if (task.status === 'running') {
    runningProjects.delete(task.projectName);
  }

  return true;
}

export function deleteTask(id: string): boolean {
  const task = getTask(id);
  if (!task) return false;
  if (task.status === 'running') cancelTask(id);
  db().prepare('DELETE FROM tasks WHERE id = ?').run(id);
  return true;
}

export function updateTask(id: string, updates: { prompt?: string; projectName?: string; projectPath?: string; priority?: number; scheduledAt?: string; restart?: boolean }): Task | null {
  const task = getTask(id);
  if (!task) return null;

  // If running, cancel first
  if (task.status === 'running') cancelTask(id);

  const fields: string[] = [];
  const values: any[] = [];
  if (updates.prompt !== undefined) { fields.push('prompt = ?'); values.push(updates.prompt); }
  if (updates.projectName !== undefined) { fields.push('project_name = ?'); values.push(updates.projectName); }
  if (updates.projectPath !== undefined) { fields.push('project_path = ?'); values.push(updates.projectPath); }
  if (updates.priority !== undefined) { fields.push('priority = ?'); values.push(updates.priority); }
  if (updates.scheduledAt !== undefined) { fields.push('scheduled_at = ?'); values.push(updates.scheduledAt || null); }

  // Reset to queued so it runs again
  if (updates.restart) {
    fields.push("status = 'queued'", 'started_at = NULL', 'completed_at = NULL', 'error = NULL', "log = '[]'", 'result_summary = NULL', 'git_diff = NULL', 'cost_usd = NULL');
  }

  if (fields.length === 0) return task;

  values.push(id);
  db().prepare(`UPDATE tasks SET ${fields.join(', ')} WHERE id = ?`).run(...values);

  if (updates.restart) ensureRunnerStarted();

  return getTask(id);
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
  if (runnerState.runner) return;
  runnerState.runner = setInterval(processNextTask, 3000);
  // Also try immediately
  processNextTask();
}

export function stopRunner() {
  if (runnerState.runner) {
    clearInterval(runnerState.runner);
    runnerState.runner = null;
  }
}

async function processNextTask() {
  // Find all queued tasks ready to run
  const queued = db().prepare(`
    SELECT * FROM tasks WHERE status = 'queued'
    AND (scheduled_at IS NULL OR replace(replace(scheduled_at, 'T', ' '), 'Z', '') <= datetime('now'))
    ORDER BY priority DESC, created_at ASC
  `).all() as any[];

  for (const next of queued) {
    const task = rowToTask(next);

    if (task.mode === 'monitor') {
      // Monitor tasks run in background, don't block the runner
      startMonitorTask(task);
      continue;
    }

    // Skip if this project already has a running prompt task
    if (runningProjects.has(task.projectName)) continue;

    // Run this task
    runningProjects.add(task.projectName);
    runnerState.currentTaskId = task.id;

    // Execute async — don't await so we can process tasks for other projects in parallel
    executeTask(task)
      .catch((err: any) => {
        appendLog(task.id, { type: 'system', subtype: 'error', content: err.message, timestamp: new Date().toISOString() });
        updateTaskStatus(task.id, 'failed', err.message);
      })
      .finally(() => {
        runningProjects.delete(task.projectName);
        if (runnerState.currentTaskId === task.id) runnerState.currentTaskId = null;
      });
  }
}

function executeShellTask(task: Task): Promise<void> {
  return new Promise((resolve) => {
    updateTaskStatus(task.id, 'running');
    db().prepare('UPDATE tasks SET started_at = datetime(\'now\') WHERE id = ?').run(task.id);
    console.log(`[task:shell] ${task.projectName}: "${task.prompt.slice(0, 80)}"`);

    const child = spawn('bash', ['-c', task.prompt], {
      cwd: task.projectPath,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      appendLog(task.id, { type: 'system', subtype: 'text', content: text, timestamp: new Date().toISOString() });
    });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    child.on('exit', (code) => {
      if (code === 0) {
        db().prepare('UPDATE tasks SET status = ?, result_summary = ?, completed_at = datetime(\'now\') WHERE id = ?')
          .run('done', stdout.trim(), task.id);
        emit(task.id, 'status', 'done');
      } else {
        const errMsg = stderr.trim() || `Exit code ${code}`;
        db().prepare('UPDATE tasks SET status = ?, error = ?, completed_at = datetime(\'now\') WHERE id = ?')
          .run('failed', errMsg, task.id);
        emit(task.id, 'status', 'failed');
      }
      resolve();
    });
  });
}

function executeTask(task: Task): Promise<void> {
  if (task.mode === 'shell') return executeShellTask(task);

  return new Promise((resolve, reject) => {
    const settings = loadSettings();
    const { getAgent } = require('./agents');
    const agentId = (task as any).agent || settings.defaultAgent || 'claude';
    const adapter = getAgent(agentId);

    // Model: per-task override > agent scene model > global fallback
    const agentCfg = settings.agents?.[agentId];
    const isPipeline = (() => { try { const { pipelineTaskIds: p } = require('./pipeline'); return p.has(task.id); } catch { return false; } })();
    const model = taskModelOverrides.get(task.id) || (isPipeline ? agentCfg?.models?.task : agentCfg?.models?.task) || agentCfg?.models?.task || settings.taskModel;
    const supportsModel = adapter.config.capabilities?.supportsModel;
    const spawnOpts = adapter.buildTaskSpawn({
      projectPath: task.projectPath,
      prompt: task.prompt,
      model: supportsModel && model && model !== 'default' ? model : undefined,
      conversationId: task.conversationId || undefined,
      skipPermissions: true,
      outputFormat: adapter.config.capabilities?.supportsStreamJson ? 'stream-json' : undefined,
    });

    const env = { ...process.env, ...(spawnOpts.env || {}) };
    delete env.CLAUDECODE;

    updateTaskStatus(task.id, 'running');
    db().prepare('UPDATE tasks SET started_at = datetime(\'now\') WHERE id = ?').run(task.id);

    const agentName = adapter.config.name || agentId;
    console.log(`[task] ${task.projectName} [${agentName}${supportsModel && model ? '/' + model : ''}]: "${task.prompt.slice(0, 60)}..."`);

    // Log agent info as first entry
    appendLog(task.id, { type: 'system', subtype: 'init', content: `Agent: ${agentName}${supportsModel && model && model !== 'default' ? ` | Model: ${model}` : ''}`, timestamp: new Date().toISOString() });

    const child = spawn(spawnOpts.cmd, spawnOpts.args, {
      cwd: task.projectPath,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let buffer = '';
    let resultText = '';
    let totalCost = 0;
    let sessionId = '';
    let modelUsed = '';
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    child.on('error', (err) => {
      console.error(`[task-runner] Spawn error:`, err.message);
      updateTaskStatus(task.id, 'failed', err.message);
      reject(err);
    });

    child.stdout?.on('data', (data: Buffer) => {
      // stdout chunk processing (silent)

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
        let jsonParsed = false;
        try {
          const parsed = JSON.parse(line);
          jsonParsed = true;
          const entries = parseStreamJson(parsed);
          for (const entry of entries) {
            appendLog(task.id, entry);
          }

          if (parsed.session_id) sessionId = parsed.session_id;
          if (parsed.type === 'system' && parsed.subtype === 'init' && parsed.model) {
            modelUsed = parsed.model;
          }
          // Accumulate token usage from assistant messages
          if (parsed.type === 'assistant' && parsed.message?.usage) {
            totalInputTokens += parsed.message.usage.input_tokens || 0;
            totalOutputTokens += parsed.message.usage.output_tokens || 0;
          }
          if (parsed.type === 'result') {
            resultText = typeof parsed.result === 'string' ? parsed.result : JSON.stringify(parsed.result);
            totalCost = parsed.total_cost_usd || 0;
            if (parsed.total_input_tokens) totalInputTokens = parsed.total_input_tokens;
            if (parsed.total_output_tokens) totalOutputTokens = parsed.total_output_tokens;
          }
        } catch {
          // Non-JSON output (generic agents) — log as raw text
          if (!jsonParsed) {
            resultText += (resultText ? '\n' : '') + line;
            appendLog(task.id, { type: 'system', subtype: 'text', content: line, timestamp: new Date().toISOString() });
          }
        }
      }
    });

    child.stderr?.on('data', (data: Buffer) => {
      const text = data.toString().trim();
      // stderr logged to task log only
      if (text) {
        appendLog(task.id, { type: 'system', subtype: 'error', content: text, timestamp: new Date().toISOString() });
      }
    });

    child.on('exit', (code, signal) => {
      // Process exit handled below
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
        console.log(`[task] Done: ${task.id} ${task.projectName} (cost: $${totalCost?.toFixed(4) || '0'}, ${totalInputTokens}in/${totalOutputTokens}out)`);
        // Record usage
        try {
          const { recordUsage } = require('./usage-scanner');
          let isPipeline = false;
          try { const { pipelineTaskIds: ptids } = require('./pipeline'); isPipeline = ptids.has(task.id); } catch {}
          recordUsage({
            sessionId: sessionId || task.id,
            source: isPipeline ? 'pipeline' : 'task',
            projectPath: task.projectPath,
            projectName: task.projectName,
            model: modelUsed || 'unknown',
            inputTokens: totalInputTokens,
            outputTokens: totalOutputTokens,
            taskId: task.id,
          });
        } catch {}
        const doneTask = getTask(task.id);
        if (doneTask) notifyTaskComplete(doneTask).catch(() => {});
        notifyTerminalSession(task, 'done', sessionId);
        resolve();
      } else {
        const errMsg = `Process exited with code ${code}`;
        console.error(`[task] Failed: ${task.id} ${task.projectName} — ${errMsg}`);
        updateTaskStatus(task.id, 'failed', errMsg);
        const failedTask = getTask(task.id);
        if (failedTask) notifyTaskFailed(failedTask).catch(() => {});
        notifyTerminalSession(task, 'failed', sessionId);
        reject(new Error(errMsg));
      }
    });

    child.on('error', (err) => {
      updateTaskStatus(task.id, 'failed', err.message);
      reject(err);
    });
  });
}

// ─── Terminal notification ────────────────────────────────────

/**
 * Notify tmux terminal sessions in the same project directory that a task completed.
 * Sends a visible bell character so the user knows to resume.
 */
function notifyTerminalSession(task: Task, status: 'done' | 'failed', sessionId?: string) {
  // Skip pipeline tasks — they have their own notification system
  try {
    const { pipelineTaskIds } = require('./pipeline');
    if (pipelineTaskIds.has(task.id)) return;
  } catch {}

  try {
    const out = execSync(
      `tmux list-sessions -F "#{session_name}" 2>/dev/null`,
      { encoding: 'utf-8', timeout: 3000 }
    ).trim();
    if (!out) return;

    for (const name of out.split('\n')) {
      if (!name.startsWith('mw-')) continue;
      try {
        const cwd = execSync(
          `tmux display-message -p -t ${name} '#{pane_current_path}'`,
          { encoding: 'utf-8', timeout: 2000 }
        ).trim();

        // Match: same dir, parent dir, or child dir
        const match = cwd && (
          cwd === task.projectPath ||
          cwd.startsWith(task.projectPath + '/') ||
          task.projectPath.startsWith(cwd + '/')
        );
        if (!match) continue;

        const paneCmd = execSync(
          `tmux display-message -p -t ${name} '#{pane_current_command}'`,
          { encoding: 'utf-8', timeout: 2000 }
        ).trim();

        if (status === 'done') {
          const summary = task.prompt.slice(0, 80).replace(/"/g, "'");
          const msg = `A background task just completed. Task: "${summary}". Please check git diff and continue.`;

          // If a process is running (claude/node), send as input
          if (paneCmd !== 'zsh' && paneCmd !== 'bash' && paneCmd !== 'fish') {
            execSync(`tmux send-keys -t ${name} -- "${msg.replace(/"/g, '\\"')}" Enter`, { timeout: 2000 });
          } else {
            execSync(`tmux display-message -t ${name} "✅ Task ${task.id} done — changes ready"`, { timeout: 2000 });
          }
        } else {
          execSync(`tmux display-message -t ${name} "❌ Task ${task.id} failed"`, { timeout: 2000 });
        }
      } catch {}
    }
  } catch {}
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
    mode: row.mode || 'prompt',
    status: row.status,
    priority: row.priority,
    conversationId: row.conversation_id || undefined,
    watchConfig: row.watch_config ? JSON.parse(row.watch_config) : undefined,
    log: JSON.parse(row.log || '[]'),
    resultSummary: row.result_summary || undefined,
    gitDiff: row.git_diff || undefined,
    gitBranch: row.git_branch || undefined,
    costUSD: row.cost_usd || undefined,
    error: row.error || undefined,
    createdAt: toIsoUTC(row.created_at) ?? row.created_at,
    startedAt: toIsoUTC(row.started_at) ?? undefined,
    completedAt: toIsoUTC(row.completed_at) ?? undefined,
    scheduledAt: toIsoUTC(row.scheduled_at) ?? undefined,
    agent: row.agent || undefined,
  } as Task;
}

// ─── Monitor task execution ──────────────────────────────────

import { getSessionFilePath, readSessionEntries, tailSessionFile, type SessionEntry } from './claude-sessions';

const activeMonitors = new Map<string, () => void>(); // taskId → cleanup fn

function startMonitorTask(task: Task) {
  if (!task.conversationId || !task.watchConfig) {
    updateTaskStatus(task.id, 'failed', 'Monitor task requires a session and watch config');
    return;
  }

  const config = task.watchConfig;
  const fp = getSessionFilePath(task.projectName, task.conversationId);
  if (!fp) {
    updateTaskStatus(task.id, 'failed', `Session file not found: ${task.conversationId}`);
    return;
  }

  console.log(`[monitor] Starting monitor ${task.id} for ${task.projectName}/${task.conversationId.slice(0, 8)} — condition: ${config.condition}, action: ${config.action}, file: ${fp}`);

  updateTaskStatus(task.id, 'running');
  appendLog(task.id, {
    type: 'system', subtype: 'init',
    content: `Monitoring session ${task.conversationId.slice(0, 12)} — condition: ${config.condition}, action: ${config.action}`,
    timestamp: new Date().toISOString(),
  });

  // Read initial state
  const initialEntries = readSessionEntries(fp);
  let lastEntryCount = initialEntries.length;
  let lastActivityTime = Date.now();

  // Idle check timer
  let idleTimer: ReturnType<typeof setInterval> | null = null;
  if (config.condition === 'idle') {
    const idleMs = (config.idleMinutes || 10) * 60_000;
    idleTimer = setInterval(() => {
      if (Date.now() - lastActivityTime > idleMs) {
        triggerMonitorAction(task, `Session idle for ${config.idleMinutes || 10} minutes`);
        if (!config.repeat) stopMonitor(task.id);
      }
    }, 30_000);
  }

  // Notification throttling: batch updates and send at most once per interval
  const notifyInterval = (config.notifyIntervalSeconds || 60) * 1000;
  let lastNotifyTime = 0;
  let pendingContext: string[] = [];
  let notifyTimer: ReturnType<typeof setTimeout> | null = null;

  function scheduleNotify(context: string, immediate?: boolean) {
    pendingContext.push(context);
    if (immediate) {
      flushNotify();
      return;
    }
    if (notifyTimer) return; // already scheduled
    const elapsed = Date.now() - lastNotifyTime;
    const delay = Math.max(0, notifyInterval - elapsed);
    notifyTimer = setTimeout(flushNotify, delay);
  }

  function flushNotify() {
    if (notifyTimer) { clearTimeout(notifyTimer); notifyTimer = null; }
    if (pendingContext.length === 0) return;
    const summary = pendingContext.length === 1
      ? pendingContext[0]
      : `${pendingContext.length} updates:\n\n${pendingContext.slice(-5).join('\n\n')}`;
    pendingContext = [];
    lastNotifyTime = Date.now();
    triggerMonitorAction(task, summary);
  }

  // Tail the file for changes (uses fs.watch + 5s polling fallback)
  const stopTail = tailSessionFile(fp, (newEntries) => {
    lastActivityTime = Date.now();
    lastEntryCount += newEntries.length;

    // Check conditions
    if (config.condition === 'change') {
      scheduleNotify(summarizeNewEntries(newEntries));
      if (!config.repeat) stopMonitor(task.id);
    }

    if (config.condition === 'keyword' && config.keyword) {
      const kw = config.keyword.toLowerCase();
      const matched = newEntries.find(e => e.content.toLowerCase().includes(kw));
      if (matched) {
        scheduleNotify(`Keyword "${config.keyword}" found: ${matched.content.slice(0, 200)}`, true);
        if (!config.repeat) stopMonitor(task.id);
      }
    }

    if (config.condition === 'error') {
      const errors = newEntries.filter(e =>
        e.type === 'system' && e.content.toLowerCase().includes('error')
      );
      if (errors.length > 0) {
        scheduleNotify(`Error detected: ${errors[0].content.slice(0, 200)}`, true);
        if (!config.repeat) stopMonitor(task.id);
      }
    }

    if (config.condition === 'complete') {
      // Check if last assistant entry looks like completion
      const lastAssistant = [...newEntries].reverse().find(e => e.type === 'assistant_text');
      if (lastAssistant) {
        // Heuristic: check if there are no more tool calls after the last text
        const lastIdx = newEntries.lastIndexOf(lastAssistant);
        const afterToolUse = newEntries.slice(lastIdx + 1).some(e => e.type === 'tool_use');
        if (!afterToolUse && newEntries.length > 2) {
          // Wait a bit to see if more entries come
          setTimeout(() => {
            if (Date.now() - lastActivityTime > 30_000) {
              scheduleNotify(`Session appears complete.\n\nLast: ${lastAssistant.content.slice(0, 300)}`, true);
              if (!config.repeat) stopMonitor(task.id);
            }
          }, 35_000);
        }
      }
    }
  }, (err) => {
    console.error(`[monitor] ${task.id} tail error:`, err.message);
    appendLog(task.id, {
      type: 'system', subtype: 'error',
      content: `File watch error: ${err.message}`,
      timestamp: new Date().toISOString(),
    });
  });

  const cleanup = () => {
    stopTail();
    if (idleTimer) clearInterval(idleTimer);
    flushNotify(); // send any remaining batched notifications
  };

  activeMonitors.set(task.id, cleanup);
}

function stopMonitor(taskId: string) {
  const cleanup = activeMonitors.get(taskId);
  if (cleanup) {
    cleanup();
    activeMonitors.delete(taskId);
  }
  updateTaskStatus(taskId, 'done');
}

// Also export for cancel
export function cancelMonitor(taskId: string) {
  stopMonitor(taskId);
  updateTaskStatus(taskId, 'cancelled');
}

async function triggerMonitorAction(task: Task, context: string) {
  const config = task.watchConfig!;

  appendLog(task.id, {
    type: 'system', subtype: 'text',
    content: `⚡ Triggered: ${context}`,
    timestamp: new Date().toISOString(),
  });

  if (config.action === 'notify') {
    // Send Telegram notification
    const settings = loadSettings();
    if (settings.telegramBotToken && settings.telegramChatId) {
      const msg = config.actionPrompt
        ? config.actionPrompt.replace('{{context}}', context)
        : `📋 Monitor: ${task.projectName}/${task.conversationId?.slice(0, 8)}\n\n${context}`;
      await sendTelegramDirect(settings.telegramBotToken, settings.telegramChatId, msg);
    }
  } else if (config.action === 'message' && config.actionPrompt && task.conversationId) {
    // Send a message to the session by creating a prompt task (will queue if project is busy)
    const newTask = createTask({
      projectName: task.projectName,
      projectPath: task.projectPath,
      prompt: config.actionPrompt,
      conversationId: task.conversationId,
    });
    const queued = runningProjects.has(task.projectName) ? ' (queued — project busy)' : '';
    appendLog(task.id, {
      type: 'system', subtype: 'text',
      content: `Created follow-up task ${newTask.id}${queued}: ${config.actionPrompt.slice(0, 100)}`,
      timestamp: new Date().toISOString(),
    });
  } else if (config.action === 'task' && config.actionPrompt) {
    const project = config.actionProject || task.projectName;
    createTask({
      projectName: project,
      projectPath: task.projectPath,
      prompt: config.actionPrompt,
    });
    appendLog(task.id, {
      type: 'system', subtype: 'text',
      content: `Created new task for ${project}: ${config.actionPrompt.slice(0, 100)}`,
      timestamp: new Date().toISOString(),
    });
  }
}

async function sendTelegramDirect(token: string, chatId: string, text: string) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    });
    if (!res.ok) {
      const body = await res.text();
      console.error(`[monitor] Telegram send failed: ${res.status} ${body}`);
    }
  } catch (err) {
    console.error('[monitor] Telegram send error:', err);
  }
}

function summarizeNewEntries(entries: SessionEntry[]): string {
  const parts: string[] = [];
  for (const e of entries) {
    if (e.type === 'user') parts.push(`👤 ${e.content.slice(0, 100)}`);
    else if (e.type === 'assistant_text') parts.push(`🤖 ${e.content.slice(0, 150)}`);
    else if (e.type === 'tool_use') parts.push(`🔧 ${e.toolName || 'tool'}`);
  }
  return parts.slice(0, 5).join('\n') || 'Activity detected';
}
