#!/usr/bin/env npx tsx
/**
 * Workspace Daemon — standalone process for managing workspace agent orchestrators.
 *
 * Runs as an independent HTTP server (like terminal-standalone.ts).
 * Next.js API routes proxy requests here.
 *
 * Usage: npx tsx lib/workspace-standalone.ts [--forge-port=8403]
 *
 * Env:
 *   WORKSPACE_PORT  — HTTP port (default: webPort + 2 = 8405)
 *   FORGE_DATA_DIR  — data directory
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { WorkspaceOrchestrator, type OrchestratorEvent } from './workspace/orchestrator';
import { loadWorkspace, saveWorkspace } from './workspace/persistence';
import { installForgeSkills, applyProfileToProject } from './workspace/skill-installer';
import {
  loadMemory, formatMemoryForDisplay, getMemoryStats,
  addObservation, addSessionSummary,
} from './workspace/smith-memory';
import type { WorkspaceAgentConfig, WorkspaceState, BusMessage } from './workspace/types';
import { execSync } from 'node:child_process';

// ─── Config ──────────────────────────────────────────────

const PORT = Number(process.env.WORKSPACE_PORT) || 8405;
const FORGE_PORT = Number(process.env.PORT) || 8403;
const MAX_ACTIVE = 2;

// ─── State ───────────────────────────────────────────────

const orchestrators = new Map<string, WorkspaceOrchestrator>();
const sseClients = new Map<string, Set<ServerResponse>>();
const startTime = Date.now();

// ─── Orchestrator Lifecycle ──────────────────────────────

function getOrchestrator(id: string): WorkspaceOrchestrator | null {
  return orchestrators.get(id) || null;
}

function loadOrchestrator(id: string): WorkspaceOrchestrator {
  const existing = orchestrators.get(id);
  if (existing) return existing;

  // Enforce max active limit
  if (orchestrators.size >= MAX_ACTIVE) {
    const evicted = evictIdleWorkspace();
    if (!evicted) {
      throw new Error(`Maximum ${MAX_ACTIVE} active workspaces. Stop agents in another workspace first.`);
    }
  }

  const state = loadWorkspace(id);
  if (!state) throw new Error('Workspace not found');

  const orch = new WorkspaceOrchestrator(state.id, state.projectPath, state.projectName);
  if (state.agents.length > 0) {
    orch.loadSnapshot({
      agents: state.agents,
      agentStates: state.agentStates,
      busLog: state.busLog,
      busOutbox: state.busOutbox,
    });
  }

  // Wire up SSE broadcasting
  orch.on('event', (event: OrchestratorEvent) => {
    broadcastSSE(id, event);
  });

  orchestrators.set(id, orch);
  // Loaded silently — debug only if needed
  return orch;
}

function unloadOrchestrator(id: string): void {
  const orch = orchestrators.get(id);
  if (!orch) return;
  orch.shutdown();
  orchestrators.delete(id);
  // Close SSE connections for this workspace
  const clients = sseClients.get(id);
  if (clients) {
    for (const res of clients) {
      try { res.end(); } catch {}
    }
    sseClients.delete(id);
  }
  // Unloaded silently
}

function evictIdleWorkspace(): boolean {
  for (const [id, orch] of orchestrators) {
    const states = orch.getAllAgentStates();
    const hasRunning = Object.values(states).some(s =>
      s.taskStatus === 'running' || s.smithStatus === 'active'
    );
    if (!hasRunning) {
      unloadOrchestrator(id);
      return true;
    }
  }
  return false;
}

// ─── SSE Management ──────────────────────────────────────

function addSSEClient(workspaceId: string, res: ServerResponse): void {
  if (!sseClients.has(workspaceId)) sseClients.set(workspaceId, new Set());
  sseClients.get(workspaceId)!.add(res);
}

function removeSSEClient(workspaceId: string, res: ServerResponse): void {
  sseClients.get(workspaceId)?.delete(res);
  if (sseClients.get(workspaceId)?.size === 0) sseClients.delete(workspaceId);
}

function broadcastSSE(workspaceId: string, event: OrchestratorEvent): void {
  const clients = sseClients.get(workspaceId);
  if (!clients) return;
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of clients) {
    try { res.write(data); } catch { removeSSEClient(workspaceId, res); }
  }
}

// ─── HTTP Helpers ────────────────────────────────────────

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

function json(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function jsonError(res: ServerResponse, msg: string, status = 400): void {
  json(res, { error: msg }, status);
}

function parseUrl(url: string): { path: string; query: URLSearchParams } {
  const u = new URL(url, 'http://localhost');
  return { path: u.pathname, query: u.searchParams };
}

// ─── Route: Agent Operations ─────────────────────────────

async function handleAgentsPost(id: string, body: any, res: ServerResponse): Promise<void> {
  let orch: WorkspaceOrchestrator;
  try {
    orch = loadOrchestrator(id);
  } catch (err: any) {
    return jsonError(res, err.message, err.message.includes('not found') ? 404 : 429);
  }

  const { action, agentId, config, content, input } = body;

  try {
    switch (action) {
      case 'add': {
        if (!config) return jsonError(res, 'config required');
        try {
          orch.addAgent(config as WorkspaceAgentConfig);
          return json(res, { ok: true });
        } catch (err: any) {
          return jsonError(res, err.message);
        }
      }
      case 'create_pipeline': {
        const { createDevPipeline } = require('./workspace/presets');
        const pipeline = createDevPipeline();
        for (const cfg of pipeline) orch.addAgent(cfg);
        return json(res, { ok: true, agents: pipeline.length });
      }
      case 'remove': {
        if (!agentId) return jsonError(res, 'agentId required');
        orch.removeAgent(agentId);
        return json(res, { ok: true });
      }
      case 'update': {
        if (!agentId || !config) return jsonError(res, 'agentId and config required');
        try {
          orch.updateAgentConfig(agentId, config as WorkspaceAgentConfig);
          return json(res, { ok: true });
        } catch (err: any) {
          return jsonError(res, err.message);
        }
      }
      case 'run': {
        if (!agentId) return jsonError(res, 'agentId required');
        if (!orch.isDaemonActive()) return jsonError(res, 'Start daemon first before running agents');
        try {
          await orch.runAgent(agentId, input, true); // force=true: manual trigger skips dep check
          return json(res, { ok: true, status: 'started' });
        } catch (err: any) {
          return jsonError(res, err.message);
        }
      }
      case 'run_all': {
        orch.runAll().catch(err => {
          console.error('[workspace] runAll error:', err.message);
        });
        return json(res, { ok: true, status: 'started' });
      }
      case 'complete_input': {
        if (!agentId || !content) return jsonError(res, 'agentId and content required');
        orch.completeInput(agentId, content);
        return json(res, { ok: true });
      }
      case 'pause': {
        if (!agentId) return jsonError(res, 'agentId required');
        orch.pauseAgent(agentId);
        return json(res, { ok: true });
      }
      case 'resume': {
        if (!agentId) return jsonError(res, 'agentId required');
        orch.resumeAgent(agentId);
        return json(res, { ok: true });
      }
      case 'stop': {
        if (!agentId) return jsonError(res, 'agentId required');
        orch.stopAgent(agentId);
        return json(res, { ok: true });
      }
      case 'retry': {
        if (!agentId) return jsonError(res, 'agentId required');
        if (!orch.isDaemonActive()) return jsonError(res, 'Start daemon first before retrying agents');
        const retryState = orch.getAgentState(agentId);
        if (!retryState) return jsonError(res, 'Agent not found');
        if (retryState.taskStatus === 'running') return jsonError(res, 'Agent is already running');
        if (retryState.taskStatus !== 'failed') return jsonError(res, `Agent is ${retryState.taskStatus}, not failed`);
        try {
          console.log(`[workspace] Retry ${agentId}: smith=${retryState.smithStatus}, task=${retryState.taskStatus}`);
          await orch.runAgent(agentId, undefined, true);
          return json(res, { ok: true, status: 'retrying' });
        } catch (err: any) {
          console.error(`[workspace] Retry failed for ${agentId}:`, err.message);
          return jsonError(res, err.message);
        }
      }
      case 'set_tmux_session': {
        if (!agentId) return jsonError(res, 'agentId required');
        const { sessionName } = body;
        orch.setTmuxSession(agentId, sessionName);
        return json(res, { ok: true });
      }
      case 'reset': {
        if (!agentId) return jsonError(res, 'agentId required');
        orch.resetAgent(agentId);
        // If daemon is active, re-enter daemon mode for this agent
        if (orch.isDaemonActive()) {
          orch.restartAgentDaemon(agentId);
        }
        return json(res, { ok: true });
      }
      case 'open_terminal': {
        if (!agentId) return jsonError(res, 'agentId required');
        if (!orch.isDaemonActive()) return jsonError(res, 'Start daemon first before opening terminal');
        const agentState = orch.getAgentState(agentId);
        const agentConfig = orch.getSnapshot().agents.find(a => a.id === agentId);
        if (!agentState || !agentConfig) return jsonError(res, 'Agent not found', 404);

        // Resolve launch info using shared logic (same as VibeCoding terminal)
        let launchInfo: any = { cliCmd: 'claude', cliType: 'claude-code', supportsSession: true };
        try {
          const { resolveTerminalLaunch, clearAgentCache } = await import('./agents/index.js');
          clearAgentCache(); // ensure fresh settings are read
          launchInfo = resolveTerminalLaunch(agentConfig.agentId);
        } catch {}

        // resolveOnly: just return launch info without side effects
        if (body.resolveOnly) {
          return json(res, { ok: true, ...launchInfo });
        }

        if (agentState.taskStatus === 'running') return jsonError(res, 'Cannot open terminal while agent is running. Wait for it to finish.');
        const hasPending = orch.getBus().getPendingMessagesFor(agentId).length > 0;
        if (hasPending) return jsonError(res, 'Agent has pending messages being processed. Wait for execution to complete.');

        if (agentState.mode === 'manual') {
          return json(res, { ok: true, mode: 'manual', alreadyManual: true, ...launchInfo });
        }

        orch.setManualMode(agentId);
        // Skills call Next.js API (/api/workspace/.../smith), so use FORGE_PORT not daemon PORT
        const result = installForgeSkills(orch.projectPath, id, agentId, FORGE_PORT);

        return json(res, {
          ok: true,
          mode: 'manual',
          skillsInstalled: result.installed,
          agentId,
          label: agentConfig.label,
          ...launchInfo,
        });
      }
      case 'close_terminal': {
        if (!agentId) return jsonError(res, 'agentId required');
        orch.restartAgentDaemon(agentId);
        return json(res, { ok: true });
      }
      case 'create_ticket': {
        if (!agentId || !content) return jsonError(res, 'agentId (from) and content required');
        const targetId = body.targetId;
        if (!targetId) return jsonError(res, 'targetId required');
        const causedByMsg = body.causedByMessageId ? orch.getBus().getLog().find(m => m.id === body.causedByMessageId) : undefined;
        const causedBy = causedByMsg ? { messageId: causedByMsg.id, from: causedByMsg.from, to: causedByMsg.to } : undefined;
        const ticket = orch.getBus().createTicket(agentId, targetId, body.ticketAction || 'bug_report', content, body.files, causedBy);
        return json(res, { ok: true, ticketId: ticket.id });
      }
      case 'update_ticket': {
        const { messageId, ticketStatus } = body;
        if (!messageId || !ticketStatus) return jsonError(res, 'messageId and ticketStatus required');
        orch.getBus().updateTicketStatus(messageId, ticketStatus);
        return json(res, { ok: true });
      }
      case 'message': {
        if (!agentId || !content) return jsonError(res, 'agentId and content required');
        orch.sendMessageToAgent(agentId, content);
        return json(res, { ok: true });
      }
      case 'approve': {
        if (!agentId) return jsonError(res, 'agentId required');
        orch.approveAgent(agentId);
        return json(res, { ok: true });
      }
      case 'reject': {
        if (!agentId) return jsonError(res, 'agentId required');
        orch.rejectApproval(agentId);
        return json(res, { ok: true });
      }
      case 'retry_message': {
        const { messageId } = body;
        if (!messageId) return jsonError(res, 'messageId required');
        if (!orch.isDaemonActive()) return jsonError(res, 'Start daemon first before retrying messages');
        const msg = orch.getBus().retryMessage(messageId);
        if (!msg) return jsonError(res, 'Message not found or already pending');
        orch.emit('event', { type: 'bus_message_status', messageId: msg.id, status: 'pending' });
        return json(res, { ok: true, messageId: msg.id, action: msg.payload.action });
      }
      case 'abort_message': {
        const { messageId } = body;
        if (!messageId) return jsonError(res, 'messageId required');
        const abortMsg = orch.getBus().abortMessage(messageId);
        if (abortMsg) {
          orch.emit('event', { type: 'bus_message_status', messageId, status: 'failed' });
        }
        return json(res, { ok: true, messageId, aborted: !!abortMsg });
      }
      case 'approve_message': {
        const { messageId } = body;
        if (!messageId) return jsonError(res, 'messageId required');
        const approveMsg = orch.getBus().getLog().find(m => m.id === messageId);
        if (!approveMsg) return jsonError(res, 'Message not found');
        if (approveMsg.status !== 'pending_approval') return jsonError(res, 'Message is not pending approval');
        if (body.content) approveMsg.payload.content = body.content;
        approveMsg.status = 'pending';
        orch.emit('event', { type: 'bus_message_status', messageId, status: 'pending' });
        return json(res, { ok: true });
      }
      case 'reject_message': {
        const { messageId } = body;
        if (!messageId) return jsonError(res, 'messageId required');
        const rejectMsg = orch.getBus().getLog().find(m => m.id === messageId);
        if (!rejectMsg) return jsonError(res, 'Message not found');
        rejectMsg.status = 'failed';
        orch.emit('event', { type: 'bus_message_status', messageId, status: 'failed' });
        return json(res, { ok: true });
      }
      case 'delete_message': {
        const { messageId } = body;
        if (!messageId) return jsonError(res, 'messageId required');
        orch.getBus().deleteMessage(messageId);
        return json(res, { ok: true });
      }
      case 'start_daemon': {
        orch.startDaemon().catch(err => {
          console.error('[workspace] startDaemon error:', err.message);
        });
        return json(res, { ok: true, status: 'daemon_started' });
      }
      case 'stop_daemon': {
        orch.stopDaemon();
        return json(res, { ok: true, status: 'daemon_stopped' });
      }
      default:
        return jsonError(res, `Unknown action: ${action}`);
    }
  } catch (err: any) {
    return jsonError(res, err.message, 500);
  }
}

function handleAgentsGet(id: string, res: ServerResponse): void {
  let orch: WorkspaceOrchestrator;
  try {
    orch = loadOrchestrator(id);
  } catch (err: any) {
    return jsonError(res, err.message, err.message.includes('not found') ? 404 : 429);
  }

  json(res, {
    agents: orch.getSnapshot().agents,
    states: orch.getAllAgentStates(),
    busLog: orch.getBusLog(),
    daemonActive: orch.isDaemonActive(),
  });
}

// ─── Route: SSE Stream ───────────────────────────────────

function handleStream(id: string, req: IncomingMessage, res: ServerResponse): void {
  let orch: WorkspaceOrchestrator;
  try {
    orch = loadOrchestrator(id);
  } catch (err: any) {
    res.writeHead(err.message.includes('not found') ? 404 : 429);
    res.end(err.message);
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
  });

  // Send initial snapshot
  const snapshot = orch.getSnapshot();
  res.write(`data: ${JSON.stringify({ type: 'init', ...snapshot })}\n\n`);

  addSSEClient(id, res);

  // Keep-alive ping every 15s
  const ping = setInterval(() => {
    try { res.write(`: ping\n\n`); } catch {
      clearInterval(ping);
      removeSSEClient(id, res);
    }
  }, 15000);

  // Cleanup on disconnect
  req.on('close', () => {
    clearInterval(ping);
    removeSSEClient(id, res);
  });
}

// ─── Route: Smith API ────────────────────────────────────

async function handleSmith(id: string, body: any, res: ServerResponse): Promise<void> {
  const orch = getOrchestrator(id);
  if (!orch) return jsonError(res, 'Workspace not found', 404);

  const { action, agentId } = body;

  switch (action) {
    case 'done': {
      if (!agentId) return jsonError(res, 'agentId required');

      try {
        let gitDiff = '';
        try {
          gitDiff = execSync('git diff --stat HEAD', {
            cwd: orch.projectPath, encoding: 'utf-8', timeout: 5000,
          }).trim();
        } catch {}

        let gitDiffDetail = '';
        try {
          gitDiffDetail = execSync('git diff HEAD --name-only', {
            cwd: orch.projectPath, encoding: 'utf-8', timeout: 5000,
          }).trim();
        } catch {}

        const changedFiles = gitDiffDetail.split('\n').filter(Boolean);
        const entry = (orch as any).agents?.get(agentId);
        const config = entry?.config;

        if (config && changedFiles.length > 0) {
          await addObservation(id, agentId, config.label, config.role, {
            type: 'change',
            title: `Manual work completed: ${changedFiles.length} files changed`,
            filesModified: changedFiles.slice(0, 10),
            detail: gitDiff.slice(0, 500),
            stepLabel: 'manual',
          });

          await addSessionSummary(id, agentId, {
            request: 'Manual development session',
            investigated: `Worked on ${changedFiles.length} files`,
            learned: '', completed: gitDiff.slice(0, 300), nextSteps: '',
            filesRead: [], filesModified: changedFiles,
          });
        }

        // Parse bus markers
        const { output } = body;
        let markersSent = 0;
        if (output && typeof output === 'string') {
          const markerRegex = /\[SEND:([^:]+):([^\]]+)\]\s*(.+)/g;
          const snapshot = orch.getSnapshot();
          const labelToId = new Map(snapshot.agents.map(a => [a.label.toLowerCase(), a.id]));
          const seen = new Set<string>();
          let match;
          while ((match = markerRegex.exec(output)) !== null) {
            const targetLabel = match[1].trim();
            const msgAction = match[2].trim();
            const content = match[3].trim();
            const targetId = labelToId.get(targetLabel.toLowerCase());
            if (targetId && targetId !== agentId) {
              const key = `${targetId}:${msgAction}:${content}`;
              if (!seen.has(key)) {
                seen.add(key);
                orch.getBus().send(agentId, targetId, 'notify', { action: msgAction, content });
                markersSent++;
              }
            }
          }
        }

        orch.completeManualAgent(agentId, changedFiles);

        return json(res, {
          ok: true, filesChanged: changedFiles.length,
          files: changedFiles.slice(0, 20),
          gitDiff: gitDiff.slice(0, 500), markersSent,
        });
      } catch (err: any) {
        return jsonError(res, err.message, 500);
      }
    }

    case 'send': {
      const { to, msgAction, content } = body;
      if (!to || !content) {
        return jsonError(res, 'to and content required');
      }

      const snapshot = orch.getSnapshot();
      const target = snapshot.agents.find(a => a.label.toLowerCase() === to.toLowerCase() || a.id === to);
      if (!target) return jsonError(res, `Agent "${to}" not found. Available: ${snapshot.agents.map(a => a.label).join(', ')}`, 404);

      // Resolve sender: use agentId if valid, otherwise 'user'
      const senderId = (agentId && agentId !== 'unknown')
        ? agentId
        : 'user';

      // Block: if sender is currently processing a message FROM the target,
      // don't send — the result is already delivered via markMessageDone
      if (senderId !== 'user') {
        const senderEntry = orch.getSnapshot().agentStates[senderId];
        if (senderEntry?.currentMessageId) {
          const currentMsg = orch.getBus().getLog().find(m => m.id === senderEntry.currentMessageId);
          if (currentMsg && currentMsg.from === target.id && currentMsg.status === 'running') {
            return json(res, {
              ok: true, skipped: true,
              reason: `You are processing a message from ${target.label}. Your result will be delivered automatically — no need to send a reply.`,
            });
          }
        }
      }

      const sentMsg = orch.getBus().send(senderId, target.id, 'notify', {
        action: msgAction || 'agent_message',
        content,
      });

      return json(res, { ok: true, sentTo: target.label, messageId: sentMsg.id });
    }

    case 'logs': {
      if (!agentId) return jsonError(res, 'agentId required');
      const { readAgentLog } = await import('./workspace/persistence.js');
      const logs = readAgentLog(id, agentId);
      return json(res, { logs });
    }

    case 'clear_logs': {
      if (!agentId) return jsonError(res, 'agentId required');
      const { clearAgentLog } = await import('./workspace/persistence.js');
      clearAgentLog(id, agentId);
      // Also clear in-memory history
      const agentState = orch.getAgentState(agentId);
      if (agentState) (agentState as any).history = [];
      return json(res, { ok: true });
    }

    case 'inbox': {
      if (!agentId) return jsonError(res, 'agentId required');

      const messages = orch.getBus().getMessagesFor(agentId)
        .filter(m => m.type !== 'ack')
        .slice(-20)
        .map(m => ({
          id: m.id,
          from: (orch.getSnapshot().agents.find(a => a.id === m.from)?.label || m.from),
          action: m.payload.action,
          content: m.payload.content,
          status: m.status || 'pending',
          time: new Date(m.timestamp).toLocaleTimeString(),
        }));

      return json(res, { messages });
    }

    case 'message_done': {
      // Manual mode: user marks a specific inbox message as done
      const { messageId } = body;
      if (!agentId || !messageId) return jsonError(res, 'agentId and messageId required');
      const busMsg = orch.getBus().getLog().find(m => m.id === messageId && m.to === agentId);
      if (!busMsg) return jsonError(res, 'Message not found');
      busMsg.status = 'done';
      return json(res, { ok: true });
    }

    case 'message_failed': {
      const { messageId } = body;
      if (!agentId || !messageId) return jsonError(res, 'agentId and messageId required');
      const busMsg = orch.getBus().getLog().find(m => m.id === messageId && m.to === agentId);
      if (!busMsg) return jsonError(res, 'Message not found');
      busMsg.status = 'failed';
      return json(res, { ok: true });
    }

    case 'sessions': {
      // List recent claude sessions for resume picker
      // Uses the workspace's projectPath to find sessions in ~/.claude/projects/
      try {
        const encoded = orch.projectPath.replace(/\//g, '-');
        const sessDir = join(homedir(), '.claude', 'projects', encoded);
        const entries = readdirSync(sessDir);
        const files = entries
          .filter((f: string) => f.endsWith('.jsonl'))
          .map((f: string) => {
            const fp = join(sessDir, f);
            const st = statSync(fp);
            return { id: f.replace('.jsonl', ''), modified: st.mtime.toISOString(), size: st.size };
          })
          .sort((a: any, b: any) => new Date(b.modified).getTime() - new Date(a.modified).getTime())
          .slice(0, 5);
        return json(res, { sessions: files });
      } catch {
        return json(res, { sessions: [] });
      }
    }

    case 'status': {
      const snapshot = orch.getSnapshot();
      const states = orch.getAllAgentStates();
      const agents = snapshot.agents.map(a => ({
        id: a.id, label: a.label, icon: a.icon, type: a.type,
        smithStatus: states[a.id]?.smithStatus || 'down',
        mode: states[a.id]?.mode || 'auto',
        taskStatus: states[a.id]?.taskStatus || 'idle',
        currentStep: states[a.id]?.currentStep,
      }));
      return json(res, { agents });
    }

    default:
      return jsonError(res, `Unknown action: ${action}`);
  }
}

// ─── Route: Memory ───────────────────────────────────────

function handleMemory(workspaceId: string, query: URLSearchParams, res: ServerResponse): void {
  const agentId = query.get('agentId');
  if (!agentId) return jsonError(res, 'agentId required');

  const memory = loadMemory(workspaceId, agentId);
  const stats = getMemoryStats(memory);
  const display = formatMemoryForDisplay(memory);

  json(res, { memory, stats, display });
}

// ─── HTTP Router ─────────────────────────────────────────

const server = createServer(async (req, res) => {
  const { path, query } = parseUrl(req.url || '/');
  const method = req.method || 'GET';

  // CORS for local dev
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    // Health check
    if (path === '/health' && method === 'GET') {
      return json(res, {
        ok: true,
        active: orchestrators.size,
        maxActive: MAX_ACTIVE,
        uptime: Math.floor((Date.now() - startTime) / 1000),
      });
    }

    // Active workspaces
    if (path === '/workspaces/active' && method === 'GET') {
      return json(res, {
        workspaces: Array.from(orchestrators.keys()),
      });
    }

    // Route: /workspace/:id/...
    const wsMatch = path.match(/^\/workspace\/([^/]+)(\/.*)?$/);
    if (!wsMatch) {
      return jsonError(res, 'Not found', 404);
    }

    const id = wsMatch[1];
    const subPath = wsMatch[2] || '';

    // Load/Unload
    if (subPath === '/load' && method === 'POST') {
      try {
        loadOrchestrator(id);
        return json(res, { ok: true });
      } catch (err: any) {
        return jsonError(res, err.message, err.message.includes('not found') ? 404 : 429);
      }
    }

    if (subPath === '/unload' && method === 'POST') {
      unloadOrchestrator(id);
      return json(res, { ok: true });
    }

    // Agent operations
    if (subPath === '/agents' && method === 'POST') {
      const bodyStr = await readBody(req);
      const body = JSON.parse(bodyStr);
      return handleAgentsPost(id, body, res);
    }

    if (subPath === '/agents' && method === 'GET') {
      return handleAgentsGet(id, res);
    }

    // SSE stream
    if (subPath === '/stream' && method === 'GET') {
      return handleStream(id, req, res);
    }

    // Smith API
    if (subPath === '/smith' && method === 'POST') {
      const bodyStr = await readBody(req);
      const body = JSON.parse(bodyStr);
      return handleSmith(id, body, res);
    }

    // Memory
    if (subPath === '/memory' && method === 'GET') {
      return handleMemory(id, query, res);
    }

    return jsonError(res, 'Not found', 404);

  } catch (err: any) {
    console.error('[workspace] Request error:', err);
    return jsonError(res, err.message || 'Internal error', 500);
  }
});

// ─── Graceful Shutdown ───────────────────────────────────

function shutdown() {
  console.log('[workspace] Shutting down...');
  for (const [id] of orchestrators) {
    unloadOrchestrator(id);
  }
  server.close(() => {
    console.log('[workspace] Server closed.');
    process.exit(0);
  });
  // Force exit after 5s
  setTimeout(() => process.exit(0), 5000);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('uncaughtException', (err) => {
  console.error('[workspace] Uncaught exception:', err);
});
process.on('unhandledRejection', (err) => {
  console.error('[workspace] Unhandled rejection:', err);
});

// ─── Start ───────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`[workspace] Daemon started on http://0.0.0.0:${PORT} (max ${MAX_ACTIVE} workspaces)`);
});
