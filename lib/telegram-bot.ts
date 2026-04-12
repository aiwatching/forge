/**
 * Telegram Bot — remote interface for Forge.
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
// Password verification is done via require() in handler functions
import type { Task, TaskLogEntry } from '@/src/types';

// Persist state across hot-reloads
const globalKey = Symbol.for('mw-telegram-state');
const g = globalThis as any;
if (!g[globalKey]) g[globalKey] = { taskListenerAttached: false, processedMsgIds: new Set<number>() };
const botState: { taskListenerAttached: boolean; processedMsgIds: Set<number> } = g[globalKey];

// Track which Telegram message maps to which task (for reply-based interaction)
const taskMessageMap = new Map<number, string>(); // messageId → taskId
const taskChatMap = new Map<string, number>();     // taskId → chatId

// Numbered lists — maps number (1-10) → id for quick selection
const chatNumberedTasks = new Map<number, Map<number, string>>();
// Session selection: two-tier — first pick project, then pick session
const chatNumberedSessions = new Map<number, Map<number, { projectName: string; sessionId: string }>>();
const chatNumberedProjects = new Map<number, Map<number, string>>();
// Track what the last numbered list was for
const chatListMode = new Map<number, 'tasks' | 'projects' | 'sessions' | 'task-create' | 'peek' | 'inject-pick' | 'inject-typing'>();
// Inject mode state — picked tmux session per chat
const chatNumberedTmux = new Map<number, Map<number, string>>(); // num → tmux session name
const chatInjectTarget = new Map<number, string>(); // chatId → tmux session name (currently selected)
const chatInjectAutoClear = new Map<number, ReturnType<typeof setTimeout>>(); // auto-clear timers
const INJECT_AUTO_CLEAR_MS = 3 * 60 * 1000; // 3 min idle → auto clear

// Pending task creation: waiting for prompt text
const pendingTaskProject = new Map<number, { name: string; path: string }>();  // chatId → project

// Pending note: waiting for content
const pendingNote = new Set<number>(); // chatIds waiting for note content

// Buffer for streaming logs
const logBuffers = new Map<string, { entries: string[]; timer: ReturnType<typeof setTimeout> | null }>();

// ─── Start/Stop ──────────────────────────────────────────────

// telegram-standalone process is managed by forge-server.mjs

export function startTelegramBot() {
  const settings = loadSettings();
  if (!settings.telegramBotToken || !settings.telegramChatId) return;

  // Set bot command menu
  setBotCommands(settings.telegramBotToken);

  // Listen for task events → stream to Telegram (only once per worker)
  if (!botState.taskListenerAttached) {
    botState.taskListenerAttached = true;
    onTaskEvent((taskId, event, data) => {
      const settings = loadSettings();
      if (!settings.telegramBotToken || !settings.telegramChatId) return;

      try {
        const { pipelineTaskIds } = require('./pipeline');
        if (pipelineTaskIds.has(taskId)) return;
      } catch {}

      const chatId = Number(settings.telegramChatId.split(',')[0].trim());

      if (event === 'log') {
        bufferLogEntry(taskId, chatId, data as TaskLogEntry);
      } else if (event === 'status') {
        handleStatusChange(taskId, chatId, data as string);
      }
    });
  }

  // Note: telegram-standalone process is started by forge-server.mjs, not here.
  // This function only sets up the task event listener and bot commands.
}

export function stopTelegramBot() {
  // telegram-standalone is managed by forge-server.mjs
  // This is a no-op now, kept for API compatibility
}

// ─── Message Handler ─────────────────────────────────────────

// Exported for API route — called by telegram-standalone via /api/telegram
export async function handleTelegramMessage(msg: any) { return handleMessage(msg); }

async function handleMessage(msg: any) {
  const chatId = msg.chat.id;

  // Whitelist check — only allow configured chat IDs, block all if not configured
  const settings = loadSettings();
  const allowedIds = settings.telegramChatId.split(',').map((s: string) => s.trim()).filter(Boolean);
  if (allowedIds.length === 0 || !allowedIds.includes(String(chatId))) {
    return;
  }

  // Message received (logged silently)
  // Dedup: skip if we already processed this message
  const msgId = msg.message_id;
  if (botState.processedMsgIds.has(msgId)) return;
  botState.processedMsgIds.add(msgId);
  // Keep set size bounded
  if (botState.processedMsgIds.size > 200) {
    const oldest = [...botState.processedMsgIds].slice(0, 100);
    oldest.forEach(id => botState.processedMsgIds.delete(id));
  }

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
    } else if (mode === 'inject-pick') {
      const tmuxMap = chatNumberedTmux.get(chatId);
      if (tmuxMap?.has(num)) {
        await pickInjectTarget(chatId, String(num));
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
      case '/agents':
        await sendAgentList(chatId);
        break;
      case '/watch':
      case '/w':
        if (args.length > 0) {
          await handleWatch(chatId, args[0], args[1]);
        } else {
          await sendWatcherList(chatId);
        }
        break;
      case '/unwatch':
        await handleUnwatch(chatId, args[0]);
        break;
      case '/docs':
      case '/doc':
        await handleDocs(chatId, args.join(' '));
        break;
      case '/peek':
      case '/sessions':
      case '/s':
        if (args.length > 0) {
          await handlePeek(chatId, args[0], args[1]);
        } else {
          await startPeekSelection(chatId);
        }
        break;
      case '/note':
        await handleDocsWrite(chatId, args.join(' '));
        break;
      case '/cancel':
        await handleCancel(chatId, args[0]);
        break;
      case '/retry':
        await handleRetry(chatId, args[0]);
        break;
      case '/inject':
      case '/i':
        if (args.length === 0) {
          await startInjectFlow(chatId);
        } else if (args.length === 1 && /^\d+$/.test(args[0])) {
          // /i 1 — pick session number, prompt for text next
          await pickInjectTarget(chatId, args[0]);
        } else {
          // /i 1 hello world — pick + send in one shot
          if (/^\d+$/.test(args[0])) {
            await pickInjectTarget(chatId, args[0]);
            await handleInjectSend(chatId, args.slice(1).join(' '));
          } else {
            // No number — use last picked target
            await handleInjectSend(chatId, args.join(' '));
          }
        }
        break;
      case '/iclear': {
        chatInjectTarget.delete(chatId);
        chatListMode.delete(chatId);
        const t = chatInjectAutoClear.get(chatId);
        if (t) { clearTimeout(t); chatInjectAutoClear.delete(chatId); }
        await send(chatId, 'Inject target cleared.');
        break;
      }
      case '/tunnel':
        await handleTunnelStatus(chatId);
        break;
      case '/tunnel_start':
        await handleTunnelStart(chatId, args[0], msg.message_id);
        break;
      case '/tunnel_stop':
        await handleTunnelStop(chatId);
        break;
      case '/tunnel_code':
        await handleTunnelCode(chatId, args[0], msg.message_id);
        break;
      default:
        await send(chatId, `Unknown command: ${cmd}\nUse /help to see available commands.`);
    }
    return;
  }

  // Inject mode: if user picked a target, plain text goes to that tmux session
  if (chatListMode.get(chatId) === 'inject-typing' && chatInjectTarget.has(chatId)) {
    await handleInjectSend(chatId, text);
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
    `🎯 /i (or /inject) — type into a terminal & submit\n` +
    `/iclear — clear inject target\n\n` +
    `👀 /sessions — session summary (select project)\n` +
    `📖 /docs — docs summary / view file\n` +
    `📝 /note — quick note to docs\n\n` +
    `👁 /watch <project> — monitor session\n` +
    `/watch — list watchers\n` +
    `/unwatch <id> — stop\n\n` +
    `📋 /task — create background task\n` +
    `/tasks — task list\n` +
    `🔧 /cancel <id>  /retry <id>\n` +
    `/projects — list projects\n` +
    `🤖 /agents — list available agents\n\n` +
    `🌐 /tunnel — status\n` +
    `/tunnel_start / /tunnel_stop\n` +
    `/tunnel_code <admin_pw> — get session code\n\n` +
    `Reply number to select`
  );
}

async function sendAgentList(chatId: number) {
  try {
    const { listAgents, getDefaultAgentId } = require('./agents');
    const agents = listAgents();
    const defaultId = getDefaultAgentId();
    if (agents.length === 0) {
      await send(chatId, 'No agents detected.');
      return;
    }
    const lines = agents.map((a: any) =>
      `${a.id === defaultId ? '⭐' : '  '} ${a.name} (${a.id})${a.detected === false ? ' ⚠️ not installed' : ''}`
    );
    await send(chatId, `🤖 Agents:\n\n${lines.join('\n')}\n\nUse @agent in /task command`);
  } catch {
    await send(chatId, 'Failed to list agents.');
  }
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

  const telegramModel = loadSettings().telegramModel || 'sonnet';
  const summary = contextEntries.length > 3
    ? await aiSummarize(contextEntries.join('\n'), 'Summarize this Claude Code session in 2-3 sentences. What was the user working on? What is the current status? Answer in the same language as the content.')
    : '';

  // Format output
  const header = `📋 ${project.name} / ${session.sessionId.slice(0, 8)}\n${entries.length} entries${session.gitBranch ? ` • ${session.gitBranch}` : ''}${summary ? ` • AI: ${telegramModel}` : ''}`;

  const summaryBlock = summary
    ? `\n\n📝 Summary (${telegramModel}):\n${summary}`
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
      '  @agent — use specific agent (e.g. @codex @aider)\n' +
      '  -s <sessionId> — resume specific session\n' +
      '  -in 30m — delay (e.g. 10m, 2h, 1d)\n' +
      '  -at 18:00 — schedule at time\n\n' +
      'Example:\nmy-app: Fix the login bug\nmy-app @codex: review code\nmy-app -s abc123 -in 1h: continue work'
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
  let agentId: string | undefined;
  let tokens = restPart.split(/\s+/);
  const promptTokens: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === '-s' && i + 1 < tokens.length) {
      sessionId = tokens[++i];
    } else if (tokens[i] === '-in' && i + 1 < tokens.length) {
      scheduledAt = parseDelay(tokens[++i]);
    } else if (tokens[i] === '-at' && i + 1 < tokens.length) {
      scheduledAt = parseTimeAt(tokens[++i]);
    } else if (tokens[i].startsWith('@')) {
      agentId = tokens[i].slice(1); // @codex → codex
    } else {
      promptTokens.push(tokens[i]);
    }
  }

  const prompt = promptTokens.join(' ');
  if (!prompt) {
    await send(chatId, 'Please provide instructions.');
    return;
  }

  // Use @agent if specified, else telegram default, else global default
  const settings = loadSettings();
  const resolvedAgent = agentId || settings.telegramAgent || undefined;

  const task = createTask({
    projectName: project.name,
    projectPath: project.path,
    prompt,
    conversationId: sessionId,
    scheduledAt,
    agent: resolvedAgent,
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

// ─── Inject Commands ─────────────────────────────────────────

/** Build a map of tmux session name → friendly label from terminal-state.json + workspace state */
function getSessionLabels(): Record<string, string> {
  const labels: Record<string, string> = {};
  try {
    const { join } = require('node:path');
    const { homedir } = require('node:os');
    const { readFileSync, existsSync, readdirSync } = require('node:fs');

    // 1. terminal-state.json — vibecoding terminal tabs
    const termState = join(homedir(), '.forge', 'data', 'terminal-state.json');
    if (existsSync(termState)) {
      try {
        const state = JSON.parse(readFileSync(termState, 'utf-8'));
        // sessionLabels (top-level map)
        if (state.sessionLabels) {
          for (const [name, label] of Object.entries(state.sessionLabels)) {
            labels[name] = String(label);
          }
        }
        // Walk tab trees and assign unique labels
        // First collect all terminals per tab in order, so we can suffix duplicates
        const collectTerminals = (node: any, acc: { name: string; proj: string | null }[]) => {
          if (!node) return;
          if (node.type === 'terminal' && node.sessionName) {
            acc.push({ name: node.sessionName, proj: node.projectPath ? node.projectPath.split('/').pop() : null });
          }
          if (node.first) collectTerminals(node.first, acc);
          if (node.second) collectTerminals(node.second, acc);
        };
        if (state.tabs) {
          for (const tab of state.tabs) {
            const terminals: { name: string; proj: string | null }[] = [];
            collectTerminals(tab.tree, terminals);
            const tabLabel = tab.label || 'Terminal';
            terminals.forEach((t, idx) => {
              if (labels[t.name]) return; // already labeled (e.g. workspace smith)
              const base = t.proj || tabLabel;
              // Disambiguate: append #N if multiple terminals share the same base in this tab
              const sameBase = terminals.filter(o => (o.proj || tabLabel) === base);
              if (sameBase.length > 1) {
                const idxInBase = sameBase.findIndex(o => o.name === t.name) + 1;
                labels[t.name] = `${base} #${idxInBase}`;
              } else {
                labels[t.name] = base;
              }
            });
          }
        }
      } catch {}
    }


    // 2. Workspace state files — smith tmuxSession + agent label
    const wsDir = join(homedir(), '.forge', 'workspaces');
    if (existsSync(wsDir)) {
      for (const wsId of readdirSync(wsDir)) {
        const stateFile = join(wsDir, wsId, 'state.json');
        if (!existsSync(stateFile)) continue;
        try {
          const ws = JSON.parse(readFileSync(stateFile, 'utf-8'));
          const projectName = ws.projectName || '';
          for (const [agentId, st] of Object.entries(ws.agentStates || {}) as any[]) {
            if (st?.tmuxSession) {
              const agent = (ws.agents || []).find((a: any) => a.id === agentId);
              const label = agent?.label || agentId;
              const icon = agent?.icon || '';
              labels[st.tmuxSession] = `${icon} ${projectName ? `[${projectName}] ` : ''}${label}`.trim();
            }
          }
        } catch {}
      }
    }
  } catch {}
  return labels;
}

/** Capture the last non-empty line(s) of a tmux session for preview.
 * @param maxLines max number of lines to return (1 for single-line list, more for detail view) */
function getSessionPreview(sessionName: string, maxLines: number = 1): string {
  try {
    const { execSync } = require('node:child_process');
    // Capture last screen, strip ANSI escapes, find last non-empty lines
    const out = execSync(`tmux capture-pane -t "${sessionName}" -p -S -50 2>/dev/null`, {
      encoding: 'utf-8',
      timeout: 2000,
    }) as string;
    if (!out) return '';
    // Strip ANSI escape codes
    // eslint-disable-next-line no-control-regex
    const clean = out.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
    const lines = clean.split('\n').map((l: string) => l.trim()).filter((l: string) => l.length > 0);
    if (lines.length === 0) return '';
    const tail = lines.slice(-maxLines);
    if (maxLines === 1) {
      const last = tail[0];
      return last.length > 30 ? last.slice(0, 30) + '…' : last;
    }
    // Multi-line: truncate each line to 80 chars
    return tail.map(l => l.length > 80 ? l.slice(0, 80) + '…' : l).join('\n');
  } catch {
    return '';
  }
}

/** Schedule auto-clear of inject target after idle timeout */
function scheduleInjectAutoClear(chatId: number) {
  const existing = chatInjectAutoClear.get(chatId);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(async () => {
    chatInjectTarget.delete(chatId);
    chatListMode.delete(chatId);
    chatInjectAutoClear.delete(chatId);
    try { await send(chatId, '⏰ Inject target auto-cleared (idle 3 min). Use /i to pick again.'); } catch {}
  }, INJECT_AUTO_CLEAR_MS);
  chatInjectAutoClear.set(chatId, timer);
}

/** List active tmux sessions and let user pick one to inject text into */
async function startInjectFlow(chatId: number) {
  const settings = loadSettings();
  if (String(chatId) !== settings.telegramChatId) { await send(chatId, '⛔ Unauthorized'); return; }

  try {
    const { execSync } = require('node:child_process');
    const out = execSync('tmux list-sessions -F "#{session_name}|#{session_attached}" 2>/dev/null', { encoding: 'utf-8', timeout: 3000 }).trim();
    if (!out) {
      await send(chatId, 'No active tmux sessions. Open a terminal in the browser first.');
      return;
    }
    const sessions = (out as string).split('\n').map((line: string) => {
      const [name, attached] = line.split('|');
      return { name, attached: attached !== '0' };
    }).filter((s: { name: string }) => s.name.startsWith('mw'));

    if (sessions.length === 0) {
      await send(chatId, 'No active Forge terminal sessions.');
      return;
    }

    // Resolve friendly labels
    const labelMap = getSessionLabels();

    const tmuxMap = new Map<number, string>();
    const lines = sessions.slice(0, 20).map((s: { name: string; attached: boolean }, i: number) => {
      const num = i + 1;
      tmuxMap.set(num, s.name);
      const friendly = labelMap[s.name];
      const display = friendly || s.name.replace(/^mw-?/, '');
      const marker = s.attached ? '👁' : '⚫';
      const preview = getSessionPreview(s.name);
      const previewLine = preview ? `\n   └ ${preview}` : '';
      return `${num}. ${marker} ${display}${previewLine}`;
    });
    chatNumberedTmux.set(chatId, tmuxMap);
    chatListMode.set(chatId, 'inject-pick');

    await send(chatId,
      `🎯 Pick a terminal to inject text:\n\n${lines.join('\n')}\n\n` +
      `👁 = attached, ⚫ = detached\n` +
      `Reply with a number, or use /i <num> <text> for one-shot.\n` +
      `Use /iclear to cancel.`
    );
  } catch (e: any) {
    await send(chatId, `Error listing sessions: ${e.message}`);
  }
}

/** After picking a session number, set it as the target and prompt for text */
async function pickInjectTarget(chatId: number, numStr: string) {
  const num = parseInt(numStr);
  const tmuxMap = chatNumberedTmux.get(chatId);
  if (!tmuxMap?.has(num)) {
    await send(chatId, 'Invalid number. Use /i to refresh the list.');
    return;
  }
  const sessionName = tmuxMap.get(num)!;
  chatInjectTarget.set(chatId, sessionName);
  chatListMode.set(chatId, 'inject-typing');
  scheduleInjectAutoClear(chatId);
  const labelMap = getSessionLabels();
  const display = labelMap[sessionName] || sessionName.replace(/^mw-?/, '');
  // Show last 8 lines of context so user knows what's in the terminal
  const context = getSessionPreview(sessionName, 8);
  const contextBlock = context ? `\n\n📺 Last output:\n\`\`\`\n${context}\n\`\`\`` : '';
  await send(chatId,
    `🎯 Target: ${display}${contextBlock}\n\n` +
    `Send any text → typed + submitted in the terminal.\n` +
    `Auto-clears after 3 min idle. Use /iclear to cancel.`
  );
}

/** Send text to the currently selected tmux session */
async function handleInjectSend(chatId: number, text: string) {
  const settings = loadSettings();
  if (String(chatId) !== settings.telegramChatId) { await send(chatId, '⛔ Unauthorized'); return; }

  const sessionName = chatInjectTarget.get(chatId);
  if (!sessionName) {
    await send(chatId, 'No target selected. Use /i to pick a terminal first.');
    return;
  }
  if (!text || !text.trim()) {
    await send(chatId, 'Empty text. Send something to inject.');
    return;
  }

  try {
    const { execSync } = require('node:child_process');
    // Paste text into the input then submit with Enter (like the user typed it and hit return)
    const buf = require('node:os').tmpdir() + `/forge-inject-${Date.now()}.txt`;
    require('node:fs').writeFileSync(buf, text);
    execSync(`tmux load-buffer -t "${sessionName}" "${buf}" && tmux paste-buffer -t "${sessionName}" && sleep 0.2 && tmux send-keys -t "${sessionName}" Enter`, { timeout: 5000 });
    require('node:fs').unlinkSync(buf);
    const preview = text.length > 60 ? text.slice(0, 60) + '...' : text;
    const labelMap = getSessionLabels();
    const display = labelMap[sessionName] || sessionName.replace(/^mw-?/, '');
    // Reset auto-clear timer on activity
    scheduleInjectAutoClear(chatId);
    await send(chatId, `✅ Sent to ${display}\n> ${preview}`);
  } catch (e: any) {
    await send(chatId, `❌ Inject failed: ${e.message}\nThe session may have closed. Use /i to pick another.`);
    chatInjectTarget.delete(chatId);
    chatListMode.delete(chatId);
  }
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

async function handleTunnelStart(chatId: number, password?: string, userMsgId?: number) {
  const settings = loadSettings();
  if (String(chatId) !== settings.telegramChatId) { await send(chatId, '⛔ Unauthorized'); return; }

  // Delete user's message containing password
  if (userMsgId && password) deleteMessageLater(chatId, userMsgId, 0);

  // Require admin password
  if (!password) {
    await send(chatId, '🔑 Usage: /tunnel_start <password>');
    return;
  }
  const { verifyAdmin } = require('./password');
  if (!verifyAdmin(password)) {
    await send(chatId, '⛔ Wrong password');
    return;
  }

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
    const { getSessionCode } = require('./password');
    const code = getSessionCode();
    // Send URL + code, auto-delete after 60 seconds
    const msgUrl = await sendHtml(chatId, `✅ Tunnel started:\n<a href="${result.url}">${result.url}</a>\n\n🔑 Session code: <code>${code || 'N/A'}</code>\n\n<i>This message will be deleted in 60 seconds</i>`);
    if (msgUrl) deleteMessageLater(chatId, msgUrl, 60);
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

async function handleTunnelCode(chatId: number, password?: string, userMsgId?: number) {
  const settings = loadSettings();
  if (String(chatId) !== settings.telegramChatId) {
    await send(chatId, '⛔ Unauthorized');
    return;
  }

  if (!password) {
    await send(chatId, 'Usage: /tunnel_code <admin-password>');
    return;
  }

  // Immediately delete user's message containing password
  if (userMsgId) deleteMessageLater(chatId, userMsgId, 0);

  const { verifyAdmin, getSessionCode } = require('./password');
  if (!verifyAdmin(password)) {
    await send(chatId, '⛔ Wrong password');
    return;
  }

  // Show the session code (for remote login 2FA)
  const code = getSessionCode();
  const status = getTunnelStatus();
  if (!code) {
    await send(chatId, '⚠️ No session code. Start tunnel first to generate one.');
    return;
  }
  const labelId = await send(chatId, '🔑 Session code for remote login (auto-deletes in 30s):');
  const pwId = await sendHtml(chatId, `<code>${code}</code>`);
  if (labelId) deleteMessageLater(chatId, labelId);
  if (pwId) deleteMessageLater(chatId, pwId);
  if (status.status === 'running' && status.url) {
    const urlLabelId = await send(chatId, '🌐 URL:');
    const urlId = await sendHtml(chatId, `<a href="${status.url}">${status.url}</a>`);
    if (urlLabelId) deleteMessageLater(chatId, urlLabelId);
    if (urlId) deleteMessageLater(chatId, urlId);
  }
}

// ─── AI Summarize (using Claude Code subscription) ───────────

async function aiSummarize(content: string, instruction: string): Promise<string> {
  try {
    const settings = loadSettings();
    const claudePath = settings.claudePath || process.env.CLAUDE_PATH || 'claude';
    const model = settings.telegramModel || 'sonnet';
    const { execSync } = require('child_process');
    const { realpathSync } = require('fs');

    // Resolve claude path
    let cmd = claudePath;
    try {
      const which = execSync(`which ${claudePath}`, { encoding: 'utf-8' }).trim();
      cmd = realpathSync(which);
    } catch {}

    const args = ['-p', '--model', model, '--max-turns', '1'];
    const prompt = `${instruction}\n\nContent:\n${content.slice(0, 8000)}`;

    let execCmd: string;
    if (cmd.endsWith('.js') || cmd.endsWith('.mjs')) {
      execCmd = `${process.execPath} ${cmd} ${args.join(' ')}`;
    } else {
      execCmd = `${cmd} ${args.join(' ')}`;
    }

    const result = execSync(execCmd, {
      input: prompt,
      encoding: 'utf-8',
      timeout: 30000,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CLAUDECODE: undefined },
    }).trim();

    return result.slice(0, 1000);
  } catch {
    return '';
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
  const hash = docRoot.replace(/[^a-zA-Z0-9]/g, '-');
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
  const tModel = loadSettings().telegramModel || 'sonnet';
  const summary = entries.length > 3
    ? await aiSummarize(entries.slice(-15).join('\n'), 'Summarize this Claude Code session in 2-3 sentences. What was the user working on? What is the current status? Answer in the same language as the content.')
    : '';
  const header = `📖 Docs: ${docRoot.split('/').pop()}\n📋 Session: ${sessionId.slice(0, 12)}${summary ? ` • AI: ${tModel}` : ''}\n`;
  const summaryBlock = summary ? `\n📝 (${tModel}) ${summary}\n` : '';

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
  const docRoot = docRoots[0];

  // Check if the docs tmux session exists
  let sessionExists = false;
  try {
    execSync(`tmux has-session -t ${SESSION_NAME} 2>/dev/null`);
    sessionExists = true;
  } catch {}

  // Auto-create session if it doesn't exist
  if (!sessionExists) {
    try {
      execSync(`tmux new-session -d -s ${SESSION_NAME} -x 120 -y 30`, { timeout: 5000 });
      // Wait for shell to initialize
      await new Promise(r => setTimeout(r, 500));
      // cd to doc root and start claude
      const sf = settings.skipPermissions ? ' --dangerously-skip-permissions' : '';
      spawnSync('tmux', ['send-keys', '-t', SESSION_NAME, `cd "${docRoot}" && claude -c${sf}`, 'Enter'], { timeout: 5000 });
      // Wait for Claude to start up
      await new Promise(r => setTimeout(r, 3000));
      await send(chatId, '🚀 Auto-started Docs Claude session.');
    } catch (err) {
      await send(chatId, '❌ Failed to create Docs Claude session.');
      return;
    }
  }

  // Check if Claude is the active process (not shell)
  let paneCmd = '';
  try {
    paneCmd = execSync(`tmux display-message -p -t ${SESSION_NAME} '#{pane_current_command}'`, { encoding: 'utf-8', timeout: 2000 }).trim();
  } catch {}

  // If Claude is not running, start it
  if (paneCmd === 'zsh' || paneCmd === 'bash' || paneCmd === 'fish' || !paneCmd) {
    try {
      const sf = settings.skipPermissions ? ' --dangerously-skip-permissions' : '';
      spawnSync('tmux', ['send-keys', '-t', SESSION_NAME, `cd "${docRoot}" && claude -c${sf}`, 'Enter'], { timeout: 5000 });
      await new Promise(r => setTimeout(r, 3000));
      await send(chatId, '🚀 Auto-started Claude in Docs session.');
    } catch {
      await send(chatId, '❌ Failed to start Claude in Docs session.');
      return;
    }
  }

  // Write content to a temp file, then use tmux to send a prompt referencing it
  const { getDataDir: _getDataDir } = require('./dirs');
  const tmpFile = join(_getDataDir(), '.note-tmp.txt');
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
          { command: 'i', description: '🎯 Inject text into a terminal' },
          { command: 'iclear', description: 'Clear inject target' },
          { command: 'sessions', description: 'Session summary (AI)' },
          { command: 'docs', description: 'Docs summary / view file' },
          { command: 'note', description: 'Quick note to docs' },
          { command: 'watch', description: 'Monitor session / list watchers' },
          { command: 'task', description: 'Create task (background)' },
          { command: 'tasks', description: 'List tasks' },
          { command: 'tunnel', description: 'Tunnel status' },
          { command: 'tunnel_start', description: 'Start tunnel' },
          { command: 'tunnel_stop', description: 'Stop tunnel' },
          { command: 'tunnel_code', description: 'Get session code for remote login' },
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
