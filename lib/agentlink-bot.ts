/**
 * AgentLink Bot — alternative messaging channel like Telegram, but for AgentLink.
 *
 * AgentLink is a local agent-to-agent / user-to-agent platform with a
 * Telegram-compatible API (getUpdates polling, sendMessage, slash commands).
 *
 * Setup:
 * 1. Run AgentLink server (default http://localhost:8080)
 * 2. Register an agent: POST /api/v1/registerAgent → get agent token
 * 3. Set agentlinkEnabled=true, agentlinkAgentToken in settings
 * 4. Optionally set agentlinkAllowedAccounts (comma-separated chat IDs, or "*")
 *
 * Supports the same commands as Telegram bot:
 *   /i /inject  — inject text into a terminal
 *   /iclear     — clear inject target
 *   /tasks /t   — list tasks
 *   /task /new  — create task
 *   /sessions   — session summary
 *   /projects   — list projects
 *   /agents     — list available agents
 *   /watch      — monitor session
 *   /docs       — docs
 *   /note       — quick note
 *   /tunnel     — tunnel status
 *   /help       — show commands
 */

import { loadSettings } from './settings';
import { listTasks, createTask, getTask, cancelTask, retryTask } from './task-manager';
import { scanProjects } from './projects';

// ─── HTTP helpers ────────────────────────────────────────

function baseUrl(): string {
  const s = loadSettings();
  return s.agentlinkBaseUrl || 'http://localhost:8080/api/v1';
}

function token(): string {
  return loadSettings().agentlinkAgentToken || '';
}

async function apiPost(path: string, body: any): Promise<any> {
  try {
    const res = await fetch(`${baseUrl()}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: token(), ...body }),
    });
    return await res.json();
  } catch (err: any) {
    console.error('[agentlink] POST failed:', path, err.message);
    return { ok: false, error: err.message };
  }
}

async function apiGet(path: string, params: Record<string, any> = {}): Promise<any> {
  try {
    const url = new URL(`${baseUrl()}${path}`);
    url.searchParams.set('token', token());
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
    const res = await fetch(url.toString());
    return await res.json();
  } catch (err: any) {
    console.error('[agentlink] GET failed:', path, err.message);
    return { ok: false, error: err.message };
  }
}

// ─── Send message ────────────────────────────────────────

export async function sendAgentlinkMessage(chatId: string, text: string, opts?: { sensitive?: boolean; ttl?: number }): Promise<boolean> {
  if (!loadSettings().agentlinkEnabled) return false;
  const res = await apiPost('/sendMessage', {
    chat_id: chatId,
    text,
    sensitive: opts?.sensitive,
    ttl: opts?.ttl,
  });
  return res?.ok === true;
}

/** Send to all configured allowed accounts (e.g. for notifications) */
export async function broadcastAgentlinkNotification(text: string): Promise<void> {
  const settings = loadSettings();
  if (!settings.agentlinkEnabled) return;
  const allowedRaw = settings.agentlinkAllowedAccounts || '';
  if (!allowedRaw || allowedRaw === '*') {
    // No specific recipients — skip notification
    return;
  }
  const accounts = allowedRaw.split(',').map(s => s.trim()).filter(Boolean);
  for (const acct of accounts) {
    await sendAgentlinkMessage(acct, text);
  }
}

// ─── Verify token + setup ────────────────────────────────

export async function verifyAgentlinkAgent(): Promise<{ ok: boolean; bot_id?: string; name?: string; error?: string }> {
  const res = await apiGet('/getAgentMe');
  if (res?.ok && res.result) {
    return { ok: true, bot_id: res.result.bot_id, name: res.result.name };
  }
  return { ok: false, error: res?.error || 'verify failed' };
}

/** Register slash commands on AgentLink — shown when user taps / */
export async function registerAgentlinkCommands(): Promise<void> {
  await apiPost('/setMyCommands', {
    commands: [
      { command: 'i', description: '🎯 Inject text into a terminal' },
      { command: 'iclear', description: 'Clear inject target' },
      { command: 'sessions', description: 'Session summary (AI)' },
      { command: 'docs', description: 'Docs summary / view file' },
      { command: 'note', description: 'Quick note to docs' },
      { command: 'watch', description: 'Monitor session / list watchers' },
      { command: 'task', description: 'Create background task' },
      { command: 'tasks', description: 'List tasks' },
      { command: 'projects', description: 'List projects' },
      { command: 'agents', description: 'List available agents' },
      { command: 'tunnel', description: 'Tunnel status' },
      { command: 'help', description: 'Show help' },
    ],
  });
}

// ─── Access control ──────────────────────────────────────

function isAccountAllowed(chatId: string): boolean {
  const allowed = loadSettings().agentlinkAllowedAccounts || '';
  if (!allowed || allowed === '*') return true;
  const accounts = allowed.split(',').map(s => s.trim()).filter(Boolean);
  return accounts.includes(chatId);
}

// ─── Inject state (per chat) ─────────────────────────────

const injectTarget = new Map<string, string>();
const injectAutoClear = new Map<string, ReturnType<typeof setTimeout>>();
const injectSessionMap = new Map<string, Map<string, string>>(); // chatId → (num → sessionName)

function scheduleInjectAutoClear(chatId: string) {
  const existing = injectAutoClear.get(chatId);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(async () => {
    injectTarget.delete(chatId);
    injectAutoClear.delete(chatId);
    await sendAgentlinkMessage(chatId, '⏰ Inject target auto-cleared (3 min idle).');
  }, 3 * 60 * 1000);
  injectAutoClear.set(chatId, timer);
}

function getSessionPreview(sessionName: string): string {
  try {
    const { execSync } = require('node:child_process');
    const out = execSync(`tmux capture-pane -t "${sessionName}" -p -S -50 2>/dev/null`, {
      encoding: 'utf-8', timeout: 2000,
    }) as string;
    if (!out) return '';
    // eslint-disable-next-line no-control-regex
    const clean = out.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
    const lines = clean.split('\n').map((l: string) => l.trim()).filter((l: string) => l.length > 0);
    if (lines.length === 0) return '';
    const last = lines[lines.length - 1];
    return last.length > 30 ? last.slice(0, 30) + '…' : last;
  } catch { return ''; }
}

async function handleInject(chatId: string, args: string[]) {
  if (args.length === 0) {
    // List sessions
    try {
      const { execSync } = require('node:child_process');
      const out = execSync('tmux list-sessions -F "#{session_name}|#{session_attached}" 2>/dev/null', {
        encoding: 'utf-8', timeout: 3000,
      }).trim();
      if (!out) {
        await sendAgentlinkMessage(chatId, 'No active tmux sessions.');
        return;
      }
      const sessions = out.split('\n')
        .map((line: string) => { const [name, attached] = line.split('|'); return { name, attached: attached !== '0' }; })
        .filter((s: { name: string }) => s.name.startsWith('mw'));
      if (sessions.length === 0) {
        await sendAgentlinkMessage(chatId, 'No active Forge terminals.');
        return;
      }
      const numMap = new Map<string, string>();
      const lines = sessions.slice(0, 15).map((s: { name: string; attached: boolean }, i: number) => {
        const num = String(i + 1);
        numMap.set(num, s.name);
        const display = s.name.replace(/^mw-?/, '');
        const marker = s.attached ? '👁' : '⚫';
        const preview = getSessionPreview(s.name);
        return `${num}. ${marker} ${display}${preview ? `\n   └ ${preview}` : ''}`;
      });
      injectSessionMap.set(chatId, numMap);
      await sendAgentlinkMessage(chatId,
        `🎯 Pick a terminal:\n\n${lines.join('\n')}\n\nReply /i <num> to select.`);
    } catch (e: any) {
      await sendAgentlinkMessage(chatId, `Error: ${e.message}`);
    }
    return;
  }

  // /i <num> [text]
  const num = args[0];
  if (/^\d+$/.test(num)) {
    const numMap = injectSessionMap.get(chatId);
    const sessionName = numMap?.get(num);
    if (!sessionName) {
      await sendAgentlinkMessage(chatId, 'Invalid number. Use /i to refresh list.');
      return;
    }
    injectTarget.set(chatId, sessionName);
    scheduleInjectAutoClear(chatId);
    if (args.length > 1) {
      await handleInjectSend(chatId, args.slice(1).join(' '));
    } else {
      await sendAgentlinkMessage(chatId,
        `🎯 Target: ${sessionName.replace(/^mw-?/, '')}\nSend text → typed + submitted in terminal.\n/iclear to cancel.`);
    }
    return;
  }
  // /i text — use last picked
  if (injectTarget.has(chatId)) {
    await handleInjectSend(chatId, args.join(' '));
  } else {
    await sendAgentlinkMessage(chatId, 'No target. Use /i to pick one first.');
  }
}

async function handleInjectSend(chatId: string, text: string) {
  const sessionName = injectTarget.get(chatId);
  if (!sessionName || !text.trim()) {
    await sendAgentlinkMessage(chatId, 'No target or empty text.');
    return;
  }
  try {
    const { execSync } = require('node:child_process');
    const fs = require('node:fs');
    const os = require('node:os');
    const buf = os.tmpdir() + `/forge-inject-${Date.now()}.txt`;
    fs.writeFileSync(buf, text);
    execSync(`tmux load-buffer -t "${sessionName}" "${buf}" && tmux paste-buffer -t "${sessionName}" && sleep 0.2 && tmux send-keys -t "${sessionName}" Enter`, { timeout: 5000 });
    fs.unlinkSync(buf);
    scheduleInjectAutoClear(chatId);
    const preview = text.length > 60 ? text.slice(0, 60) + '...' : text;
    await sendAgentlinkMessage(chatId, `✅ Sent to ${sessionName.replace(/^mw-?/, '')}\n> ${preview}`);
  } catch (e: any) {
    await sendAgentlinkMessage(chatId, `❌ Failed: ${e.message}`);
    injectTarget.delete(chatId);
  }
}

// ─── Command handlers ────────────────────────────────────

async function sendHelp(chatId: string) {
  await sendAgentlinkMessage(chatId,
    '🤖 Forge\n\n' +
    '🎯 /i — inject text into a terminal\n' +
    '/iclear — clear inject target\n\n' +
    '👀 /sessions — session summary\n' +
    '📖 /docs — docs summary / view file\n' +
    '📝 /note — quick note to docs\n\n' +
    '👁 /watch <project> — monitor session\n' +
    '/unwatch <id> — stop\n\n' +
    '📋 /task — create background task\n' +
    '/tasks — task list\n' +
    '🔧 /cancel <id>  /retry <id>\n' +
    '/projects — list projects\n' +
    '🤖 /agents — list available agents\n\n' +
    '🌐 /tunnel — tunnel status'
  );
}

async function sendTaskList(chatId: string, status?: string) {
  const tasks = listTasks();
  const filtered = status ? tasks.filter(t => t.status === status) : tasks;
  if (filtered.length === 0) {
    await sendAgentlinkMessage(chatId, status ? `No ${status} tasks.` : 'No tasks.');
    return;
  }
  const lines = filtered.slice(0, 15).map((t: any, i: number) => {
    const icon = t.status === 'done' ? '✅' : t.status === 'failed' ? '❌' : t.status === 'running' ? '🏃' : '⏳';
    return `${i + 1}. ${icon} [${t.id.slice(0, 6)}] ${t.projectName}: ${(t.prompt || '').slice(0, 50)}`;
  });
  await sendAgentlinkMessage(chatId, `📋 Tasks:\n${lines.join('\n')}`);
}

async function sendProjectList(chatId: string) {
  const projects = scanProjects();
  if (projects.length === 0) {
    await sendAgentlinkMessage(chatId, 'No projects.');
    return;
  }
  const lines = projects.slice(0, 20).map((p: any, i: number) =>
    `${i + 1}. ${p.name}${p.hasGit ? ' (git)' : ''}`
  );
  await sendAgentlinkMessage(chatId, `📁 Projects:\n${lines.join('\n')}`);
}

async function handleNewTask(chatId: string, text: string) {
  // Format: "project-name task description" or "project-name: task description"
  const colonMatch = text.match(/^([^:\s]+)[:\s]+(.+)$/);
  if (!colonMatch) {
    await sendAgentlinkMessage(chatId, 'Format: /task <project> <prompt>');
    return;
  }
  const projectName = colonMatch[1];
  const prompt = colonMatch[2].trim();
  const projects = scanProjects();
  const project = projects.find((p: any) => p.name === projectName);
  if (!project) {
    await sendAgentlinkMessage(chatId, `Project not found: ${projectName}\nUse /projects to list available projects.`);
    return;
  }
  try {
    const task = createTask({
      projectName: project.name,
      projectPath: project.path,
      prompt,
    } as any);
    await sendAgentlinkMessage(chatId, `✅ Task created: ${task.id.slice(0, 8)}\nUse /tasks to monitor.`);
  } catch (err: any) {
    await sendAgentlinkMessage(chatId, `❌ Failed: ${err.message}`);
  }
}

async function handleCancel(chatId: string, taskIdShort?: string) {
  if (!taskIdShort) {
    await sendAgentlinkMessage(chatId, 'Usage: /cancel <task_id>');
    return;
  }
  const tasks = listTasks();
  const task = tasks.find((t: any) => t.id.startsWith(taskIdShort));
  if (!task) {
    await sendAgentlinkMessage(chatId, 'Task not found.');
    return;
  }
  cancelTask(task.id);
  await sendAgentlinkMessage(chatId, `🛑 Cancelled ${task.id.slice(0, 8)}`);
}

async function handleRetry(chatId: string, taskIdShort?: string) {
  if (!taskIdShort) {
    await sendAgentlinkMessage(chatId, 'Usage: /retry <task_id>');
    return;
  }
  const tasks = listTasks();
  const task = tasks.find((t: any) => t.id.startsWith(taskIdShort));
  if (!task) {
    await sendAgentlinkMessage(chatId, 'Task not found.');
    return;
  }
  try {
    retryTask(task.id);
    await sendAgentlinkMessage(chatId, `🔁 Retrying ${task.id.slice(0, 8)}`);
  } catch (err: any) {
    await sendAgentlinkMessage(chatId, `❌ ${err.message}`);
  }
}

async function handleTunnel(chatId: string) {
  try {
    const { getTunnelStatus } = require('./cloudflared');
    const status = getTunnelStatus();
    await sendAgentlinkMessage(chatId,
      status.status === 'running' && status.url
        ? `🌐 Tunnel: ${status.url}`
        : `🌐 Tunnel: ${status.status}`
    );
  } catch {
    await sendAgentlinkMessage(chatId, 'Tunnel not available.');
  }
}

// ─── Message dispatcher ──────────────────────────────────

export async function handleAgentlinkMessage(chatId: string, text: string): Promise<void> {
  if (!isAccountAllowed(chatId)) {
    await sendAgentlinkMessage(chatId, 'Access denied.');
    return;
  }

  // Inject mode: plain text → terminal
  if (injectTarget.has(chatId) && !text.startsWith('/')) {
    await handleInjectSend(chatId, text);
    return;
  }

  if (!text.startsWith('/')) {
    // Plain text — try "project: prompt" format like Telegram
    const colonIdx = text.indexOf(':');
    if (colonIdx > 0 && colonIdx < 30) {
      const projectName = text.slice(0, colonIdx).trim();
      const prompt = text.slice(colonIdx + 1).trim();
      if (prompt) {
        await handleNewTask(chatId, `${projectName} ${prompt}`);
        return;
      }
    }
    await sendAgentlinkMessage(chatId,
      'Send a task as:\nproject-name: your instructions\n\nOr use /help for all commands.');
    return;
  }

  const [cmd, ...args] = text.split(/\s+/);
  switch (cmd) {
    case '/start':
    case '/help':
      await sendHelp(chatId);
      break;
    case '/i':
    case '/inject':
      await handleInject(chatId, args);
      break;
    case '/iclear': {
      injectTarget.delete(chatId);
      const t = injectAutoClear.get(chatId);
      if (t) { clearTimeout(t); injectAutoClear.delete(chatId); }
      await sendAgentlinkMessage(chatId, 'Inject target cleared.');
      break;
    }
    case '/tasks':
    case '/t':
      await sendTaskList(chatId, args[0]);
      break;
    case '/task':
    case '/new':
      if (args.length > 0) {
        await handleNewTask(chatId, args.join(' '));
      } else {
        await sendAgentlinkMessage(chatId, 'Usage: /task <project> <prompt>');
      }
      break;
    case '/projects':
    case '/p':
      await sendProjectList(chatId);
      break;
    case '/cancel':
      await handleCancel(chatId, args[0]);
      break;
    case '/retry':
      await handleRetry(chatId, args[0]);
      break;
    case '/tunnel':
      await handleTunnel(chatId);
      break;
    default:
      await sendAgentlinkMessage(chatId, `Unknown command: ${cmd}\nUse /help to see commands.`);
  }
}

// ─── Polling loop ────────────────────────────────────────

let pollOffset = 0;
let pollingActive = false;

export async function pollAgentlinkUpdates(): Promise<void> {
  if (pollingActive) return;
  if (!loadSettings().agentlinkEnabled) return;
  if (!token()) return;

  pollingActive = true;
  console.log('[agentlink] Polling started');

  while (pollingActive) {
    if (!loadSettings().agentlinkEnabled) {
      console.log('[agentlink] Disabled — stopping poll');
      break;
    }
    try {
      const res = await apiGet('/getUpdates', { offset: pollOffset });
      if (res?.ok && Array.isArray(res.result)) {
        for (const upd of res.result) {
          pollOffset = upd.update_id;
          if (upd.message) {
            const chatId = String(upd.message.chat_id || '');
            const text = upd.message.text || '';
            try {
              await handleAgentlinkMessage(chatId, text);
            } catch (err: any) {
              console.error('[agentlink] Handler error:', err.message);
            }
          } else if (upd.callback_query) {
            const cb = upd.callback_query;
            const chatId = String(cb.chat_id || '');
            await sendAgentlinkMessage(chatId, `Button: ${cb.data}`);
          }
        }
      }
    } catch (err: any) {
      console.error('[agentlink] Poll error:', err.message);
    }
    // Sleep 3s between polls
    await new Promise(r => setTimeout(r, 3000));
  }
  pollingActive = false;
  console.log('[agentlink] Polling stopped');
}

export function stopAgentlinkPolling() {
  pollingActive = false;
}
