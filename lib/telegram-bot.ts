/**
 * Telegram Bot — remote interface for My Workflow.
 *
 * Optimized for mobile:
 * - /tasks shows numbered list, reply with number to see details
 * - Reply to task messages to send follow-ups
 * - Plain text "project: instructions" to create tasks
 */

import { loadSettings } from './settings';
import { createTask, getTask, listTasks, cancelTask, retryTask, onTaskEvent } from './task-manager';
import { scanProjects } from './projects';
import { listClaudeSessions, getSessionFilePath, readSessionEntries } from './claude-sessions';
import { listWatchers, createWatcher, deleteWatcher, toggleWatcher } from './session-watcher';
import { startTunnel, stopTunnel, getTunnelStatus } from './cloudflared';
import { getPassword } from './password';
import type { Task, TaskLogEntry } from '@/src/types';

let polling = false;
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let lastUpdateId = 0;

// Prevent duplicate polling across hot-reloads
const globalKey = Symbol.for('mw-telegram-polling');
const g = globalThis as any;

// Track which Telegram message maps to which task (for reply-based interaction)
const taskMessageMap = new Map<number, string>(); // messageId → taskId
const taskChatMap = new Map<string, number>();     // taskId → chatId

// Numbered lists — maps number (1-10) → id for quick selection
const chatNumberedTasks = new Map<number, Map<number, string>>();
// Session selection: two-tier — first pick project, then pick session
const chatNumberedSessions = new Map<number, Map<number, { projectName: string; sessionId: string }>>();
const chatNumberedProjects = new Map<number, Map<number, string>>();
// Track what the last numbered list was for
const chatListMode = new Map<number, 'tasks' | 'projects' | 'sessions' | 'task-create' | 'peek'>();

// Pending task creation: waiting for prompt text
const pendingTaskProject = new Map<number, { name: string; path: string }>();  // chatId → project

// Pending note: waiting for content
const pendingNote = new Set<number>(); // chatIds waiting for note content

// Buffer for streaming logs
const logBuffers = new Map<string, { entries: string[]; timer: ReturnType<typeof setTimeout> | null }>();

// ─── Start/Stop ──────────────────────────────────────────────

export function startTelegramBot() {
  if (polling || g[globalKey]) return;
  const settings = loadSettings();
  if (!settings.telegramBotToken || !settings.telegramChatId) return;

  polling = true;
  g[globalKey] = true;
  console.log('[telegram] Bot started');

  // Set bot command menu
  setBotCommands(settings.telegramBotToken);

  // Listen for task events → stream to Telegram
  onTaskEvent((taskId, event, data) => {
    const settings = loadSettings();
    if (!settings.telegramBotToken || !settings.telegramChatId) return;
    const chatId = Number(settings.telegramChatId);

    if (event === 'log') {
      bufferLogEntry(taskId, chatId, data as TaskLogEntry);
    } else if (event === 'status') {
      handleStatusChange(taskId, chatId, data as string);
    }
  });

  poll();
}

export function stopTelegramBot() {
  polling = false;
  g[globalKey] = false;
  if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
}

// ─── Polling ─────────────────────────────────────────────────

async function poll() {
  if (!polling) return;

  try {
    const settings = loadSettings();
    const url = `https://api.telegram.org/bot${settings.telegramBotToken}/getUpdates?offset=${lastUpdateId + 1}&timeout=30`;
    const res = await fetch(url);
    const data = await res.json();

    if (data.ok && data.result) {
      for (const update of data.result) {
        lastUpdateId = update.update_id;
        if (update.message?.text) {
          await handleMessage(update.message);
        }
      }
    }
  } catch (err: any) {
    // Network errors (ECONNRESET, fetch failed) are normal during sleep/wake — silent retry
    const isNetworkError = err?.cause?.code === 'ECONNRESET' || err?.message?.includes('fetch failed');
    if (!isNetworkError) {
      console.error('[telegram] Poll error:', err);
    }
  }

  pollTimer = setTimeout(poll, 1000);
}

// ─── Message Handler ─────────────────────────────────────────

async function handleMessage(msg: any) {
  const chatId = msg.chat.id;
  // Message received (logged silently)
  const text: string = msg.text.trim();
  const replyTo = msg.reply_to_message?.message_id;

  // Check if waiting for note content
  if (pendingNote.has(chatId) && !text.startsWith('/')) {
    pendingNote.delete(chatId);
    await sendNoteToDocsClaude(chatId, text);
    return;
  }

  // Check if waiting for task prompt
  const pending = pendingTaskProject.get(chatId);
  if (pending && !text.startsWith('/')) {
    pendingTaskProject.delete(chatId);
    const task = createTask({
      projectName: pending.name,
      projectPath: pending.path,
      prompt: text,
    });
    const msgId = await send(chatId, `✅ Task ${task.id} created\n📁 ${task.projectName}\n\n${text.slice(0, 200)}`);
    if (msgId) { taskMessageMap.set(msgId, task.id); taskChatMap.set(task.id, chatId); }
    return;
  }

  // Check if replying to a task message → follow-up
  if (replyTo && taskMessageMap.has(replyTo)) {
    const taskId = taskMessageMap.get(replyTo)!;
    await handleFollowUp(chatId, taskId, text);
    return;
  }

  // Quick number selection (1-10) → context-dependent
  if (/^\d{1,2}$/.test(text)) {
    const num = parseInt(text);
    const mode = chatListMode.get(chatId);

    if (mode === 'task-create') {
      const projMap = chatNumberedProjects.get(chatId);
      if (projMap?.has(num)) {
        const projectName = projMap.get(num)!;
        const projects = scanProjects();
        const project = projects.find(p => p.name === projectName);
        if (project) {
          pendingTaskProject.set(chatId, { name: project.name, path: project.path });
          await send(chatId, `📁 ${project.name}\n\nSend the task prompt:`);
        }
        return;
      }
    } else if (mode === 'peek') {
      const projMap = chatNumberedProjects.get(chatId);
      if (projMap?.has(num)) {
        await handlePeek(chatId, projMap.get(num)!);
        return;
      }
    } else if (mode === 'projects') {
      const projMap = chatNumberedProjects.get(chatId);
      if (projMap?.has(num)) {
        await sendSessionList(chatId, projMap.get(num)!);
        return;
      }
    } else if (mode === 'sessions') {
      const sessMap = chatNumberedSessions.get(chatId);
      if (sessMap?.has(num)) {
        const { projectName, sessionId } = sessMap.get(num)!;
        await sendSessionContent(chatId, projectName, sessionId);
        return;
      }
    } else {
      const taskMap = chatNumberedTasks.get(chatId);
      if (taskMap?.has(num)) {
        await sendTaskDetail(chatId, taskMap.get(num)!);
        return;
      }
    }
  }

  // Commands
  if (text.startsWith('/')) {
    // Any new command cancels pending states
    pendingTaskProject.delete(chatId);
    pendingNote.delete(chatId);

    const [cmd, ...args] = text.split(/\s+/);
    switch (cmd) {
      case '/start':
      case '/help':
        await sendHelp(chatId);
        break;
      case '/tasks':
      case '/t':
        await sendNumberedTaskList(chatId, args[0]);
        break;
      case '/new':
      case '/task':
        if (args.length > 0) {
          await handleNewTask(chatId, args.join(' '));
        } else {
          await startTaskCreation(chatId);
        }
        break;
      case '/sessions':
      case '/s':
        if (args[0]) {
          await sendSessionList(chatId, args[0]);
        } else {
          await sendProjectListForSessions(chatId);
        }
        break;
      case '/projects':
      case '/p':
        await sendProjectList(chatId);
        break;
      case '/watch':
        await handleWatch(chatId, args[0], args[1]);
        break;
      case '/watchers':
      case '/w':
        await sendWatcherList(chatId);
        break;
      case '/unwatch':
        await handleUnwatch(chatId, args[0]);
        break;
      case '/peek':
        if (args.length > 0) {
          await handlePeek(chatId, args[0], args[1]);
        } else {
          await startPeekSelection(chatId);
        }
        break;
      case '/docs':
      case '/doc':
        await handleDocs(chatId, args.join(' '));
        break;
      case '/note':
      case '/docs_write':
        await handleDocsWrite(chatId, args.join(' '));
        break;
      case '/cancel':
        await handleCancel(chatId, args[0]);
        break;
      case '/retry':
        await handleRetry(chatId, args[0]);
        break;
      case '/tunnel':
        await handleTunnelStatus(chatId);
        break;
      case '/tunnel_start':
        await handleTunnelStart(chatId);
        break;
      case '/tunnel_stop':
        await handleTunnelStop(chatId);
        break;
      case '/tunnel_password':
        await handleTunnelPassword(chatId, args[0], msg.message_id);
        break;
      default:
        await send(chatId, `Unknown command: ${cmd}\nUse /help to see available commands.`);
    }
    return;
  }

  // Plain text — try to parse as "project: task" format
  const colonIdx = text.indexOf(':');
  if (colonIdx > 0 && colonIdx < 30) {
    const projectName = text.slice(0, colonIdx).trim();
    const prompt = text.slice(colonIdx + 1).trim();
    if (prompt) {
      await handleNewTask(chatId, `${projectName} ${prompt}`);
      return;
    }
  }

  await send(chatId,
    `Send a task as:\nproject-name: your instructions\n\nOr use /help for all commands.`
  );
}

// ─── Command Handlers ────────────────────────────────────────

async function sendHelp(chatId: number) {
  await send(chatId,
    `🤖 Forge\n\n` +
    `📋 /tasks — numbered task list\n` +
    `/tasks running — filter by status\n` +
    `🔍 /sessions — browse session content\n` +
    `/sessions <project> — sessions for project\n\n` +
    `👁 /watch <project> [sessionId] — monitor session\n` +
    `/watchers — list active watchers\n` +
    `/unwatch <id> — stop watching\n\n` +
    `📝 Submit task:\nproject-name: your instructions\n\n` +
    `👀 /peek [project] [sessionId] — session summary\n` +
    `📖 /docs — docs session summary\n` +
    `/docs <filename> — view doc file\n` +
    `📝 /note — quick note to docs claude\n\n` +
    `🔧 /cancel <id>  /retry <id>\n` +
    `/projects — list projects\n\n` +
    `🌐 /tunnel — tunnel status\n` +
    `/tunnel_start — start tunnel\n` +
    `/tunnel_stop — stop tunnel\n` +
    `/tunnel_password <pw> — get login password\n\n` +
    `Reply number to select`
  );
}

async function sendNumberedTaskList(chatId: number, statusFilter?: string) {
  // Get running/queued first, then recent done/failed
  const allTasks = listTasks(statusFilter as any || undefined);

  // Sort: running first, then queued, then by recency
  const prioritized = [
    ...allTasks.filter(t => t.status === 'running'),
    ...allTasks.filter(t => t.status === 'queued'),
    ...allTasks.filter(t => t.status !== 'running' && t.status !== 'queued'),
  ].slice(0, 10);

  if (prioritized.length === 0) {
    await send(chatId, 'No tasks found.');
    return;
  }

  // Build numbered map
  const numMap = new Map<number, string>();
  const lines: string[] = [];

  prioritized.forEach((t, i) => {
    const num = i + 1;
    numMap.set(num, t.id);

    const icon = t.status === 'running' ? '🔄' : t.status === 'queued' ? '⏳' : t.status === 'done' ? '✅' : t.status === 'failed' ? '❌' : '⚪';
    const cost = t.costUSD != null ? ` $${t.costUSD.toFixed(3)}` : '';
    const prompt = t.prompt.length > 40 ? t.prompt.slice(0, 40) + '...' : t.prompt;

    lines.push(`${num}. ${icon} ${t.projectName}\n   ${prompt}${cost}`);
  });

  chatNumberedTasks.set(chatId, numMap);
  chatListMode.set(chatId, 'tasks');

  await send(chatId,
    `📋 Tasks — reply number to see details\n\n${lines.join('\n\n')}`
  );
}

async function sendTaskDetail(chatId: number, taskId: string) {
  const task = getTask(taskId);
  if (!task) {
    await send(chatId, `Task not found: ${taskId}`);
    return;
  }

  const icon = task.status === 'done' ? '✅' : task.status === 'running' ? '🔄' : task.status === 'failed' ? '❌' : '⏳';

  let text = `${icon} ${task.projectName} [${task.id}]\n`;
  text += `Status: ${task.status}\n`;
  text += `Task: ${task.prompt}\n`;

  if (task.startedAt) text += `Started: ${new Date(task.startedAt).toLocaleString()}\n`;
  if (task.completedAt) text += `Done: ${new Date(task.completedAt).toLocaleString()}\n`;
  if (task.costUSD != null) text += `Cost: $${task.costUSD.toFixed(4)}\n`;
  if (task.error) text += `\n❗ Error: ${task.error}\n`;

  if (task.resultSummary) {
    const result = task.resultSummary.length > 1500
      ? task.resultSummary.slice(0, 1500) + '...'
      : task.resultSummary;
    text += `\n--- Result ---\n${result}`;
  }

  // Show recent log summary for running tasks
  if (task.status === 'running' && task.log.length > 0) {
    const recent = task.log
      .filter(e => e.subtype === 'text' || e.subtype === 'tool_use')
      .slice(-5)
      .map(e => e.subtype === 'tool_use' ? `🔧 ${e.tool}` : e.content.slice(0, 80))
      .join('\n');
    if (recent) text += `\n--- Recent ---\n${recent}`;
  }

  const msgId = await send(chatId, text);
  if (msgId) {
    taskMessageMap.set(msgId, taskId);
  }

  // Show action hints
  if (task.status === 'done') {
    await send(chatId, `💬 Reply to the message above to send follow-up`);
  } else if (task.status === 'failed') {
    await send(chatId, `🔄 /retry ${task.id}`);
  } else if (task.status === 'running' || task.status === 'queued') {
    await send(chatId, `🛑 /cancel ${task.id}`);
  }
}

async function sendProjectListForSessions(chatId: number) {
  const projects = scanProjects();
  if (projects.length === 0) {
    await send(chatId, 'No projects found.');
    return;
  }

  const numMap = new Map<number, string>();
  const lines: string[] = [];

  projects.slice(0, 10).forEach((p, i) => {
    const num = i + 1;
    numMap.set(num, p.name);
    lines.push(`${num}. ${p.name}${p.language ? ` (${p.language})` : ''}`);
  });

  chatNumberedProjects.set(chatId, numMap);
  chatListMode.set(chatId, 'projects');

  await send(chatId,
    `📁 Select project — reply number\n\n${lines.join('\n')}`
  );
}

async function sendSessionList(chatId: number, projectName: string) {
  const sessions = listClaudeSessions(projectName);
  if (sessions.length === 0) {
    await send(chatId, `No sessions for ${projectName}`);
    return;
  }

  const numMap = new Map<number, { projectName: string; sessionId: string }>();
  const lines: string[] = [];

  sessions.slice(0, 10).forEach((s, i) => {
    const num = i + 1;
    numMap.set(num, { projectName, sessionId: s.sessionId });
    const label = s.summary || s.firstPrompt || s.sessionId.slice(0, 8);
    const msgs = s.messageCount != null ? ` (${s.messageCount} msgs)` : '';
    const date = s.modified ? new Date(s.modified).toLocaleDateString() : '';
    lines.push(`${num}. ${label}${msgs}\n   ${date} ${s.gitBranch || ''}`);
  });

  chatNumberedSessions.set(chatId, numMap);
  chatListMode.set(chatId, 'sessions');

  await send(chatId,
    `🔍 ${projectName} sessions — reply number\n\n${lines.join('\n\n')}`
  );
}

async function sendSessionContent(chatId: number, projectName: string, sessionId: string) {
  const filePath = getSessionFilePath(projectName, sessionId);
  if (!filePath) {
    await send(chatId, 'Session file not found');
    return;
  }

  const entries = readSessionEntries(filePath);
  if (entries.length === 0) {
    await send(chatId, 'Session is empty');
    return;
  }

  // Build a readable summary — show user messages and assistant text, skip tool details
  const parts: string[] = [];
  let charCount = 0;
  const MAX = 3500;

  // Walk from end to get most recent content
  for (let i = entries.length - 1; i >= 0 && charCount < MAX; i--) {
    const e = entries[i];
    let line = '';
    if (e.type === 'user') {
      line = `👤 ${e.content}`;
    } else if (e.type === 'assistant_text') {
      line = `🤖 ${e.content.slice(0, 500)}`;
    } else if (e.type === 'tool_use') {
      line = `🔧 ${e.toolName || 'tool'}`;
    }
    // Skip thinking, tool_result, system for brevity
    if (!line) continue;

    if (charCount + line.length > MAX) {
      line = line.slice(0, MAX - charCount) + '...';
    }
    parts.unshift(line);
    charCount += line.length;
  }

  const header = `🔍 Session: ${sessionId.slice(0, 8)}\nProject: ${projectName}\n${entries.length} entries\n\n`;

  // Split into chunks for Telegram's 4096 limit
  const fullText = header + parts.join('\n\n');
  const chunks = splitMessage(fullText, 4000);
  for (const chunk of chunks) {
    await send(chatId, chunk);
  }
}

async function startPeekSelection(chatId: number) {
  const projects = scanProjects();
  if (projects.length === 0) {
    await send(chatId, 'No projects configured.');
    return;
  }

  // Filter to projects that have sessions
  const withSessions = projects.filter(p => listClaudeSessions(p.name).length > 0);
  if (withSessions.length === 0) {
    await send(chatId, 'No projects with sessions found.');
    return;
  }

  const numbered = new Map<number, string>();
  const lines = withSessions.slice(0, 15).map((p, i) => {
    numbered.set(i + 1, p.name);
    const sessions = listClaudeSessions(p.name);
    const latest = sessions[0];
    const info = latest?.summary || latest?.firstPrompt?.slice(0, 40) || '';
    return `${i + 1}. ${p.name}${info ? `\n   ${info}` : ''}`;
  });

  chatNumberedProjects.set(chatId, numbered);
  chatListMode.set(chatId, 'peek');

  await send(chatId, `👀 Peek — select project:\n\n${lines.join('\n')}`);
}

async function handlePeek(chatId: number, projectArg?: string, sessionArg?: string) {
  const projects = scanProjects();

  // If no project specified, use the most recent task's project
  let projectName = projectArg;
  let sessionId = sessionArg;

  if (!projectName) {
    // Find most recent running or done task
    const tasks = listTasks();
    const recent = tasks.find(t => t.status === 'running') || tasks[0];
    if (recent) {
      projectName = recent.projectName;
    } else {
      await send(chatId, 'No project specified and no recent tasks.\nUsage: /peek [project] [sessionId]');
      return;
    }
  }

  const project = projects.find(p => p.name === projectName || p.name.toLowerCase() === projectName!.toLowerCase());
  if (!project) {
    await send(chatId, `Project not found: ${projectName}`);
    return;
  }

  // Find session
  const sessions = listClaudeSessions(project.name);
  if (sessions.length === 0) {
    await send(chatId, `No sessions for ${project.name}`);
    return;
  }

  const session = sessionId
    ? sessions.find(s => s.sessionId.startsWith(sessionId!))
    : sessions[0]; // most recent

  if (!session) {
    await send(chatId, `Session not found: ${sessionId}`);
    return;
  }

  const filePath = getSessionFilePath(project.name, session.sessionId);
  if (!filePath) {
    await send(chatId, 'Session file not found');
    return;
  }

  await send(chatId, `🔍 Loading ${project.name} / ${session.sessionId.slice(0, 8)}...`);

  const entries = readSessionEntries(filePath);
  if (entries.length === 0) {
    await send(chatId, 'Session is empty');
    return;
  }

  // Collect last N meaningful entries for raw display
  const recentRaw: string[] = [];
  let rawCount = 0;
  for (let i = entries.length - 1; i >= 0 && rawCount < 8; i--) {
    const e = entries[i];
    if (e.type === 'user') {
      recentRaw.unshift(`👤 ${e.content.slice(0, 300)}`);
      rawCount++;
    } else if (e.type === 'assistant_text') {
      recentRaw.unshift(`🤖 ${e.content.slice(0, 300)}`);
      rawCount++;
    } else if (e.type === 'tool_use') {
      recentRaw.unshift(`🔧 ${e.toolName || 'tool'}`);
      rawCount++;
    }
  }

  // Build context for AI summary (last ~50 entries)
  const contextEntries: string[] = [];
  let contextLen = 0;
  const MAX_CONTEXT = 8000;
  for (let i = entries.length - 1; i >= 0 && contextLen < MAX_CONTEXT; i--) {
    const e = entries[i];
    let line = '';
    if (e.type === 'user') line = `User: ${e.content}`;
    else if (e.type === 'assistant_text') line = `Assistant: ${e.content}`;
    else if (e.type === 'tool_use') line = `Tool: ${e.toolName || 'tool'}`;
    else continue;
    if (contextLen + line.length > MAX_CONTEXT) break;
    contextEntries.unshift(line);
    contextLen += line.length;
  }

  // AI summary
  let summary = '';
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (apiKey) {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 500,
          messages: [{
            role: 'user',
            content: `Summarize this Claude Code session in 2-3 sentences. What was the user trying to do? What's the current status? Answer in the same language as the session content.\n\n${contextEntries.join('\n')}`,
          }],
        }),
      });
      if (res.ok) {
        const data = await res.json();
        summary = data.content?.[0]?.text || '';
      }
    }
  } catch {}

  // Format output
  const header = `📋 ${project.name} / ${session.sessionId.slice(0, 8)}\n${entries.length} entries${session.gitBranch ? ` • ${session.gitBranch}` : ''}`;

  const summaryBlock = summary
    ? `\n\n📝 Summary:\n${summary}`
    : '';

  const rawBlock = `\n\n--- Recent ---\n${recentRaw.join('\n\n')}`;

  const fullText = header + summaryBlock + rawBlock;
  const chunks = splitMessage(fullText, 4000);
  for (const chunk of chunks) {
    await send(chatId, chunk);
  }
}

/**
 * Parse task creation input. Supports:
 *   project-name instructions
 *   project-name -s sessionId instructions
 *   project-name -in 30m instructions
 *   project-name -at 2024-01-01T10:00 instructions
 */
async function startTaskCreation(chatId: number) {
  const projects = scanProjects();
  if (projects.length === 0) {
    await send(chatId, 'No projects configured. Add project roots in Settings.');
    return;
  }

  const numbered = new Map<number, string>();
  const lines = projects.slice(0, 15).map((p, i) => {
    numbered.set(i + 1, p.name);
    return `${i + 1}. ${p.name}`;
  });

  chatNumberedProjects.set(chatId, numbered);
  chatListMode.set(chatId, 'task-create');

  await send(chatId, `📝 New Task\n\nSelect project:\n${lines.join('\n')}`);
}

async function handleNewTask(chatId: number, input: string) {
  if (!input) {
    await send(chatId,
      'Usage:\nproject: instructions\n\n' +
      'Options:\n' +
      '  -s <sessionId> — resume specific session\n' +
      '  -in 30m — delay (e.g. 10m, 2h, 1d)\n' +
      '  -at 18:00 — schedule at time\n\n' +
      'Example:\nmy-app: Fix the login bug\nmy-app -s abc123 -in 1h: continue work'
    );
    return;
  }

  // Parse project name (before first space or colon)
  const colonIdx = input.indexOf(':');
  let projectPart: string;
  let restPart: string;

  if (colonIdx > 0 && colonIdx < 40) {
    projectPart = input.slice(0, colonIdx).trim();
    restPart = input.slice(colonIdx + 1).trim();
  } else {
    const spaceIdx = input.indexOf(' ');
    if (spaceIdx < 0) {
      await send(chatId, 'Please provide instructions after the project name.');
      return;
    }
    projectPart = input.slice(0, spaceIdx).trim();
    restPart = input.slice(spaceIdx + 1).trim();
  }

  const projects = scanProjects();
  const project = projects.find(p => p.name === projectPart || p.name.toLowerCase() === projectPart.toLowerCase());

  if (!project) {
    const available = projects.slice(0, 10).map(p => `  ${p.name}`).join('\n');
    await send(chatId, `Project not found: ${projectPart}\n\nAvailable:\n${available}`);
    return;
  }

  // Parse flags
  let sessionId: string | undefined;
  let scheduledAt: string | undefined;
  let tokens = restPart.split(/\s+/);
  const promptTokens: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === '-s' && i + 1 < tokens.length) {
      sessionId = tokens[++i];
    } else if (tokens[i] === '-in' && i + 1 < tokens.length) {
      scheduledAt = parseDelay(tokens[++i]);
    } else if (tokens[i] === '-at' && i + 1 < tokens.length) {
      scheduledAt = parseTimeAt(tokens[++i]);
    } else {
      promptTokens.push(tokens[i]);
    }
  }

  const prompt = promptTokens.join(' ');
  if (!prompt) {
    await send(chatId, 'Please provide instructions.');
    return;
  }

  const task = createTask({
    projectName: project.name,
    projectPath: project.path,
    prompt,
    conversationId: sessionId,
    scheduledAt,
  });

  let statusLine = 'Status: queued';
  if (scheduledAt) {
    statusLine = `Scheduled: ${new Date(scheduledAt).toLocaleString()}`;
  }
  if (sessionId) {
    statusLine += `\nSession: ${sessionId.slice(0, 12)}`;
  }

  const msgId = await send(chatId,
    `📋 Task created: ${task.id}\n${task.projectName}: ${prompt}\n\n${statusLine}`
  );

  if (msgId) {
    taskMessageMap.set(msgId, task.id);
    taskChatMap.set(task.id, chatId);
  }
}

function parseDelay(s: string): string | undefined {
  const match = s.match(/^(\d+)(m|h|d)$/);
  if (!match) return undefined;
  const val = Number(match[1]);
  const unit = match[2];
  const ms = unit === 'm' ? val * 60_000 : unit === 'h' ? val * 3600_000 : val * 86400_000;
  return new Date(Date.now() + ms).toISOString();
}

function parseTimeAt(s: string): string | undefined {
  // Try HH:MM format (today)
  const timeMatch = s.match(/^(\d{1,2}):(\d{2})$/);
  if (timeMatch) {
    const now = new Date();
    now.setHours(Number(timeMatch[1]), Number(timeMatch[2]), 0, 0);
    if (now.getTime() < Date.now()) now.setDate(now.getDate() + 1); // next day
    return now.toISOString();
  }
  // Try ISO or date format
  try {
    const d = new Date(s);
    if (!isNaN(d.getTime())) return d.toISOString();
  } catch {}
  return undefined;
}

async function handleFollowUp(chatId: number, taskId: string, message: string) {
  const task = getTask(taskId);
  if (!task) {
    await send(chatId, 'Task not found.');
    return;
  }

  if (task.status === 'running') {
    await send(chatId, '⏳ Task still running, wait for it to finish.');
    return;
  }

  const newTask = createTask({
    projectName: task.projectName,
    projectPath: task.projectPath,
    prompt: message,
    conversationId: task.conversationId || undefined,
  });

  const msgId = await send(chatId,
    `🔄 Follow-up: ${newTask.id}\nContinuing ${task.projectName} session\n\n${message}`
  );

  if (msgId) {
    taskMessageMap.set(msgId, newTask.id);
    taskChatMap.set(newTask.id, chatId);
  }
}

async function sendProjectList(chatId: number) {
  const projects = scanProjects();
  const lines = projects.slice(0, 20).map(p =>
    `${p.name}${p.language ? ` (${p.language})` : ''}`
  );
  await send(chatId, `📁 Projects\n\n${lines.join('\n')}\n\n${projects.length} total`);
}

async function handleCancel(chatId: number, taskId?: string) {
  if (!taskId) { await send(chatId, 'Usage: /cancel <task-id>'); return; }
  const ok = cancelTask(taskId);
  await send(chatId, ok ? `🛑 Task ${taskId} cancelled` : `Cannot cancel task ${taskId}`);
}

async function handleRetry(chatId: number, taskId?: string) {
  if (!taskId) { await send(chatId, 'Usage: /retry <task-id>'); return; }
  const newTask = retryTask(taskId);
  if (!newTask) {
    await send(chatId, `Cannot retry task ${taskId}`);
    return;
  }
  const msgId = await send(chatId, `🔄 Retrying as ${newTask.id}`);
  if (msgId) {
    taskMessageMap.set(msgId, newTask.id);
    taskChatMap.set(newTask.id, chatId);
  }
}

// ─── Watcher Commands ────────────────────────────────────────

async function handleWatch(chatId: number, projectName?: string, sessionId?: string) {
  if (!projectName) {
    await send(chatId, 'Usage: /watch <project> [sessionId]\n\nMonitors a session and sends updates here.');
    return;
  }
  const label = sessionId ? `${projectName}/${sessionId.slice(0, 8)}` : projectName;
  const watcher = createWatcher({ projectName, sessionId, label });
  await send(chatId, `👁 Watching: ${label}\nID: ${watcher.id}\nChecking every ${watcher.checkInterval}s`);
}

async function sendWatcherList(chatId: number) {
  const all = listWatchers();
  if (all.length === 0) {
    await send(chatId, '👁 No watchers.\n\nUse /watch <project> [sessionId] to add one.');
    return;
  }

  const lines = all.map((w, i) => {
    const status = w.active ? '●' : '○';
    const target = w.sessionId ? `${w.projectName}/${w.sessionId.slice(0, 8)}` : w.projectName;
    return `${status} ${w.id} — ${target} (${w.checkInterval}s)`;
  });

  await send(chatId, `👁 Watchers\n\n${lines.join('\n')}\n\nUse /unwatch <id> to remove`);
}

async function handleUnwatch(chatId: number, watcherId?: string) {
  if (!watcherId) {
    await send(chatId, 'Usage: /unwatch <watcher-id>');
    return;
  }
  deleteWatcher(watcherId);
  await send(chatId, `🗑 Watcher ${watcherId} removed`);
}

// ─── Tunnel Commands ─────────────────────────────────────────

async function handleTunnelStatus(chatId: number) {
  const settings = loadSettings();
  if (String(chatId) !== settings.telegramChatId) { await send(chatId, '⛔ Unauthorized'); return; }

  const status = getTunnelStatus();
  if (status.status === 'running' && status.url) {
    await sendHtml(chatId, `🌐 Tunnel running:\n<a href="${status.url}">${status.url}</a>\n\n/tunnel_stop — stop tunnel`);
  } else if (status.status === 'starting') {
    await send(chatId, '⏳ Tunnel is starting...');
  } else {
    await send(chatId, `🌐 Tunnel is ${status.status}\n\n/tunnel_start — start tunnel`);
  }
}

async function handleTunnelStart(chatId: number) {
  const settings = loadSettings();
  if (String(chatId) !== settings.telegramChatId) { await send(chatId, '⛔ Unauthorized'); return; }

  // Check if tunnel is already running and still reachable
  const status = getTunnelStatus();
  if (status.status === 'running' && status.url) {
    // Verify it's actually alive
    let alive = false;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      const res = await fetch(status.url, { method: 'HEAD', signal: controller.signal, redirect: 'manual' });
      clearTimeout(timeout);
      alive = res.status > 0;
    } catch {}

    if (alive) {
      await sendHtml(chatId, `🌐 Tunnel already running:\n<a href="${status.url}">${status.url}</a>`);
      return;
    }
    // Tunnel process alive but URL unreachable — kill and restart
    await send(chatId, '🌐 Tunnel URL unreachable, restarting...');
    stopTunnel();
  }

  await send(chatId, '🌐 Starting tunnel...');
  const result = await startTunnel();
  if (result.url) {
    await send(chatId, '✅ Tunnel started:');
    await sendHtml(chatId, `<a href="${result.url}">${result.url}</a>`);
  } else {
    await send(chatId, `❌ Failed: ${result.error}`);
  }
}

async function handleTunnelStop(chatId: number) {
  const settings = loadSettings();
  if (String(chatId) !== settings.telegramChatId) { await send(chatId, '⛔ Unauthorized'); return; }

  stopTunnel();
  await send(chatId, '🛑 Tunnel stopped');
}

async function handleTunnelPassword(chatId: number, password?: string, userMsgId?: number) {
  const settings = loadSettings();
  if (String(chatId) !== settings.telegramChatId) {
    await send(chatId, '⛔ Unauthorized');
    return;
  }

  if (!settings.telegramTunnelPassword) {
    await send(chatId, '⚠️ Telegram tunnel password not configured.\nSet it in Settings → Remote Access → Telegram tunnel password');
    return;
  }

  if (!password) {
    await send(chatId, 'Usage: /tunnel_password <your-password>');
    return;
  }

  // Immediately delete user's message containing password
  if (userMsgId) deleteMessageLater(chatId, userMsgId, 0);

  if (password !== settings.telegramTunnelPassword) {
    await send(chatId, '⛔ Wrong password');
    return;
  }

  const loginPassword = getPassword();
  const status = getTunnelStatus();
  // Send password as code block, auto-delete after 30s
  const labelId = await send(chatId, '🔑 Login password (auto-deletes in 30s):');
  const pwId = await sendHtml(chatId, `<code>${loginPassword}</code>`);
  if (labelId) deleteMessageLater(chatId, labelId);
  if (pwId) deleteMessageLater(chatId, pwId);
  if (status.status === 'running' && status.url) {
    const urlLabelId = await send(chatId, '🌐 URL:');
    const urlId = await sendHtml(chatId, `<a href="${status.url}">${status.url}</a>`);
    if (urlLabelId) deleteMessageLater(chatId, urlLabelId);
    if (urlId) deleteMessageLater(chatId, urlId);
  }
}

// ─── Docs ────────────────────────────────────────────────────

async function handleDocs(chatId: number, input: string) {
  const settings = loadSettings();
  if (String(chatId) !== settings.telegramChatId) { await send(chatId, '⛔ Unauthorized'); return; }

  const docRoots = (settings.docRoots || []).map((r: string) => r.replace(/^~/, require('os').homedir()));
  if (docRoots.length === 0) {
    await send(chatId, '⚠️ No document directories configured.\nAdd them in Settings → Document Roots');
    return;
  }

  const docRoot = docRoots[0];
  const { homedir: getHome } = require('os');
  const { join, extname } = require('path');
  const { existsSync, readFileSync, readdirSync } = require('fs');

  // /docs <filename> — search and show file content
  if (input.trim()) {
    const query = input.trim().toLowerCase();

    // Recursive search for matching .md files
    const matches: string[] = [];
    function searchDir(dir: string, depth: number) {
      if (depth > 5 || matches.length >= 5) return;
      try {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
          const full = join(dir, entry.name);
          if (entry.isDirectory()) {
            searchDir(full, depth + 1);
          } else if (entry.name.toLowerCase().includes(query) && extname(entry.name) === '.md') {
            matches.push(full);
          }
        }
      } catch {}
    }
    searchDir(docRoot, 0);

    if (matches.length === 0) {
      await send(chatId, `No docs matching "${input.trim()}"`);
      return;
    }

    // Show first match
    const filePath = matches[0];
    const relPath = filePath.replace(docRoot + '/', '');
    try {
      const content = readFileSync(filePath, 'utf-8');
      const preview = content.slice(0, 3500);
      const truncated = content.length > 3500 ? '\n\n... (truncated)' : '';
      await send(chatId, `📄 ${relPath}\n\n${preview}${truncated}`);
      if (matches.length > 1) {
        const others = matches.slice(1).map(m => `  ${m.replace(docRoot + '/', '')}`).join('\n');
        await send(chatId, `Other matches:\n${others}`);
      }
    } catch {
      await send(chatId, `Failed to read: ${relPath}`);
    }
    return;
  }

  // /docs — show summary of latest Claude session for docs
  const hash = docRoot.replace(/\//g, '-');
  const claudeDir = join(getHome(), '.claude', 'projects', hash);

  if (!existsSync(claudeDir)) {
    await send(chatId, `📖 Docs: ${docRoot.split('/').pop()}\n\nNo Claude sessions yet. Open Docs tab to start.`);
    return;
  }

  // Find latest session
  let latestFile = '';
  let latestTime = 0;
  try {
    for (const f of readdirSync(claudeDir)) {
      if (!f.endsWith('.jsonl')) continue;
      const { statSync } = require('fs');
      const stat = statSync(join(claudeDir, f));
      if (stat.mtimeMs > latestTime) {
        latestTime = stat.mtimeMs;
        latestFile = f;
      }
    }
  } catch {}

  if (!latestFile) {
    await send(chatId, `📖 Docs: ${docRoot.split('/').pop()}\n\nNo sessions found.`);
    return;
  }

  const sessionId = latestFile.replace('.jsonl', '');
  const filePath = join(claudeDir, latestFile);

  // Read recent entries
  let entries: string[] = [];
  try {
    const content = readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter(Boolean);
    const recentLines = lines.slice(-30);

    for (const line of recentLines) {
      try {
        const entry = JSON.parse(line);
        if (entry.type === 'human' || entry.role === 'user') {
          const text = typeof entry.message === 'string' ? entry.message : entry.message?.content?.[0]?.text || '';
          if (text) entries.push(`👤 ${text.slice(0, 200)}`);
        } else if (entry.type === 'assistant' && entry.message?.content) {
          for (const block of entry.message.content) {
            if (block.type === 'text' && block.text) {
              entries.push(`🤖 ${block.text.slice(0, 200)}`);
            } else if (block.type === 'tool_use') {
              entries.push(`🔧 ${block.name || 'tool'}`);
            }
          }
        }
      } catch {}
    }
  } catch {}

  const recent = entries.slice(-8).join('\n\n');
  const header = `📖 Docs: ${docRoot.split('/').pop()}\n📋 Session: ${sessionId.slice(0, 12)}\n`;

  // Try AI summary if available
  let summary = '';
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (apiKey && entries.length > 2) {
      const contextText = entries.slice(-15).join('\n');
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 300,
          messages: [{
            role: 'user',
            content: `Summarize this Claude Code session in 2-3 sentences. What was the user working on? What's the current status? Answer in the same language as the content.\n\n${contextText}`,
          }],
        }),
      });
      if (res.ok) {
        const data = await res.json();
        summary = data.content?.[0]?.text || '';
      }
    }
  } catch {}

  const summaryBlock = summary ? `\n📝 ${summary}\n` : '';
  const fullText = header + summaryBlock + '\n--- Recent ---\n' + recent;

  const chunks = splitMessage(fullText, 4000);
  for (const chunk of chunks) {
    await send(chatId, chunk);
  }
}

// ─── Docs Write (Quick Notes) ────────────────────────────────

async function handleDocsWrite(chatId: number, content: string) {
  const settings = loadSettings();
  if (String(chatId) !== settings.telegramChatId) { await send(chatId, '⛔ Unauthorized'); return; }

  if (!content) {
    pendingNote.add(chatId);
    await send(chatId, '📝 Send your note content:');
    return;
  }

  await sendNoteToDocsClaude(chatId, content);
}

async function sendNoteToDocsClaude(chatId: number, content: string) {
  const settings = loadSettings();
  const docRoots = (settings.docRoots || []).map((r: string) => r.replace(/^~/, require('os').homedir()));

  if (docRoots.length === 0) {
    await send(chatId, '⚠️ No document directories configured.');
    return;
  }

  const { execSync, spawnSync } = require('child_process');
  const { writeFileSync, unlinkSync } = require('fs');
  const { join } = require('path');
  const { homedir } = require('os');
  const SESSION_NAME = 'mw-docs-claude';

  // Check if the docs tmux session exists
  let sessionExists = false;
  try {
    execSync(`tmux has-session -t ${SESSION_NAME} 2>/dev/null`);
    sessionExists = true;
  } catch {}

  if (!sessionExists) {
    await send(chatId, '⚠️ Docs Claude session not running. Open the Docs tab first to start it.');
    return;
  }

  // Check if Claude is the active process (not shell)
  let paneCmd = '';
  try {
    paneCmd = execSync(`tmux display-message -p -t ${SESSION_NAME} '#{pane_current_command}'`, { encoding: 'utf-8', timeout: 2000 }).trim();
  } catch {}

  if (paneCmd === 'zsh' || paneCmd === 'bash' || paneCmd === 'fish' || !paneCmd) {
    await send(chatId, '⚠️ Claude is not running in the Docs session. Open the Docs tab and start Claude first.');
    return;
  }

  // Write content to a temp file, then use tmux to send a prompt referencing it
  const tmpFile = join(homedir(), '.forge', '.note-tmp.txt');
  try {
    writeFileSync(tmpFile, content, 'utf-8');

    // Send a single-line prompt to Claude via tmux send-keys using the temp file
    const prompt = `Please read the file ${tmpFile} and save its content as a note in the appropriate location in my docs. Analyze the content to determine the best file and location. After saving, delete the temp file.`;

    // Use tmux send-keys with literal flag to avoid interpretation issues
    spawnSync('tmux', ['send-keys', '-t', SESSION_NAME, '-l', prompt], { timeout: 5000 });
    // Send Enter separately
    spawnSync('tmux', ['send-keys', '-t', SESSION_NAME, 'Enter'], { timeout: 2000 });

    await send(chatId, `📝 Note sent to Docs Claude:\n\n${content.slice(0, 200)}${content.length > 200 ? '...' : ''}`);
  } catch (err) {
    try { unlinkSync(tmpFile); } catch {}
    await send(chatId, '❌ Failed to send note to Claude session');
  }
}

// ─── Real-time Streaming ─────────────────────────────────────

function bufferLogEntry(taskId: string, chatId: number, entry: TaskLogEntry) {
  taskChatMap.set(taskId, chatId);

  let buf = logBuffers.get(taskId);
  if (!buf) {
    buf = { entries: [], timer: null };
    logBuffers.set(taskId, buf);
  }

  let line = '';
  if (entry.subtype === 'tool_use') {
    line = `🔧 ${entry.tool || 'tool'}: ${entry.content.slice(0, 80)}`;
  } else if (entry.subtype === 'text') {
    line = entry.content.slice(0, 200);
  } else if (entry.type === 'result') {
    line = `✅ ${entry.content.slice(0, 200)}`;
  } else if (entry.subtype === 'error') {
    line = `❗ ${entry.content.slice(0, 200)}`;
  }
  if (!line) return;

  buf.entries.push(line);

  if (!buf.timer) {
    buf.timer = setTimeout(() => flushLogBuffer(taskId, chatId), 3000);
  }
}

async function flushLogBuffer(taskId: string, chatId: number) {
  const buf = logBuffers.get(taskId);
  if (!buf || buf.entries.length === 0) return;

  const text = buf.entries.join('\n');
  buf.entries = [];
  buf.timer = null;

  await send(chatId, text);
}

async function handleStatusChange(taskId: string, chatId: number, status: string) {
  await flushLogBuffer(taskId, chatId);

  const task = getTask(taskId);
  if (!task) return;

  const targetChat = taskChatMap.get(taskId) || chatId;

  if (status === 'running') {
    const msgId = await send(targetChat,
      `🚀 Started: ${taskId}\n${task.projectName}: ${task.prompt.slice(0, 100)}`
    );
    if (msgId) taskMessageMap.set(msgId, taskId);
  } else if (status === 'done') {
    const cost = task.costUSD != null ? `Cost: $${task.costUSD.toFixed(4)}\n` : '';
    const result = task.resultSummary ? task.resultSummary.slice(0, 800) : '';
    const msgId = await send(targetChat,
      `✅ Done: ${taskId}\n${task.projectName}\n${cost}${result ? `\n${result}` : ''}\n\n💬 Reply to continue`
    );
    if (msgId) taskMessageMap.set(msgId, taskId);
  } else if (status === 'failed') {
    const msgId = await send(targetChat,
      `❌ Failed: ${taskId}\n${task.error || 'Unknown error'}\n\n/retry ${taskId}`
    );
    if (msgId) taskMessageMap.set(msgId, taskId);
  }
}

// ─── Telegram API ────────────────────────────────────────────

async function send(chatId: number, text: string): Promise<number | null> {
  const settings = loadSettings();
  if (!settings.telegramBotToken) return null;

  try {
    const url = `https://api.telegram.org/bot${settings.telegramBotToken}/sendMessage`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        disable_web_page_preview: true,
      }),
    });

    const data = await res.json();
    if (!data.ok) {
      console.error('[telegram] Send error:', data.description);
      return null;
    }
    return data.result?.message_id || null;
  } catch (err) {
    console.error('[telegram] Send failed:', err);
    return null;
  }
}

/** Delete a message after a delay (seconds) */
function deleteMessageLater(chatId: number, messageId: number, delaySec: number = 30) {
  setTimeout(async () => {
    const settings = loadSettings();
    if (!settings.telegramBotToken) return;
    try {
      await fetch(`https://api.telegram.org/bot${settings.telegramBotToken}/deleteMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, message_id: messageId }),
      });
    } catch {}
  }, delaySec * 1000);
}

/** Set bot command menu for quick access */
async function setBotCommands(token: string) {
  try {
    await fetch(`https://api.telegram.org/bot${token}/setMyCommands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        commands: [
          { command: 'tasks', description: 'List tasks' },
          { command: 'task', description: 'Create task (interactive or /task project prompt)' },
          { command: 'sessions', description: 'Browse sessions' },
          { command: 'projects', description: 'List projects' },
          { command: 'tunnel', description: 'Tunnel status' },
          { command: 'tunnel_start', description: 'Start tunnel' },
          { command: 'tunnel_stop', description: 'Stop tunnel' },
          { command: 'tunnel_password', description: 'Get login password' },
          { command: 'peek', description: 'Session summary (AI + recent)' },
          { command: 'docs', description: 'Docs session summary / view file' },
          { command: 'note', description: 'Quick note to docs Claude' },
          { command: 'watch', description: 'Monitor session' },
          { command: 'watchers', description: 'List watchers' },
          { command: 'help', description: 'Show help' },
        ],
      }),
    });
  } catch {}
}

async function sendHtml(chatId: number, html: string): Promise<number | null> {
  const settings = loadSettings();
  if (!settings.telegramBotToken) return null;

  try {
    const url = `https://api.telegram.org/bot${settings.telegramBotToken}/sendMessage`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: html,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });

    const data = await res.json();
    if (!data.ok) {
      return send(chatId, html.replace(/<[^>]+>/g, ''));
    }
    return data.result?.message_id || null;
  } catch {
    return send(chatId, html.replace(/<[^>]+>/g, ''));
  }
}

function splitMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  while (text.length > 0) {
    const cut = text.lastIndexOf('\n', maxLen);
    const splitAt = cut > 0 ? cut : maxLen;
    chunks.push(text.slice(0, splitAt));
    text = text.slice(splitAt).trimStart();
  }
  return chunks;
}
