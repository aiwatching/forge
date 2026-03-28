/**
 * Workspace Persistence — save/load workspace state to disk.
 *
 * Storage layout:
 *   ~/.forge/workspaces/{workspace-id}/
 *     state.json            — workspace config, agent states, node positions, bus log
 *     agents/{agent-id}/
 *       logs.jsonl           — append-only execution log
 *       history.json         — conversation history snapshot
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync, renameSync } from 'node:fs';
import { writeFile, appendFile, mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { WorkspaceState, AgentState, BusMessage, WorkspaceAgentConfig } from './types';
import type { TaskLogEntry } from '@/src/types';

// ─── Paths ───────────────────────────────────────────────

const WORKSPACES_ROOT = join(homedir(), '.forge', 'workspaces');

function workspaceDir(workspaceId: string): string {
  return join(WORKSPACES_ROOT, workspaceId);
}

function agentDir(workspaceId: string, agentId: string): string {
  return join(workspaceDir(workspaceId), 'agents', agentId);
}

function stateFile(workspaceId: string): string {
  return join(workspaceDir(workspaceId), 'state.json');
}

function agentLogFile(workspaceId: string, agentId: string): string {
  return join(agentDir(workspaceId, agentId), 'logs.jsonl');
}

function agentHistoryFile(workspaceId: string, agentId: string): string {
  return join(agentDir(workspaceId, agentId), 'history.json');
}

// ─── Save ────────────────────────────────────────────────

export async function saveWorkspace(state: WorkspaceState): Promise<void> {
  const dir = workspaceDir(state.id);
  mkdirSync(dir, { recursive: true }); // sync mkdir is fine (fast, cached by OS)

  const stateToSave: WorkspaceState = {
    ...state,
    agentStates: Object.fromEntries(
      Object.entries(state.agentStates).map(([id, s]) => [id, {
        ...s,
        history: [],
        logFile: agentLogFile(state.id, id),
      }])
    ),
    updatedAt: Date.now(),
  };

  // Atomic write — write to temp file, then rename (prevents 0-byte on crash)
  const target = stateFile(state.id);
  const tmp = target + '.tmp';
  await writeFile(tmp, JSON.stringify(stateToSave, null, 2), 'utf-8');
  await rename(tmp, target);

  // Save per-agent history in parallel
  await Promise.all(
    Object.entries(state.agentStates).map(([agentId, agentState]) =>
      saveAgentHistory(state.id, agentId, agentState)
    )
  );
}

async function saveAgentHistory(workspaceId: string, agentId: string, state: AgentState): Promise<void> {
  const dir = agentDir(workspaceId, agentId);
  await mkdir(dir, { recursive: true });
  await writeFile(agentHistoryFile(workspaceId, agentId), JSON.stringify(state.history, null, 2), 'utf-8');
}

/** Synchronous save — used during shutdown to ensure data is written before process exits */
export function saveWorkspaceSync(state: WorkspaceState): void {
  const dir = workspaceDir(state.id);
  mkdirSync(dir, { recursive: true });

  const stateToSave: WorkspaceState = {
    ...state,
    agentStates: Object.fromEntries(
      Object.entries(state.agentStates).map(([id, s]) => [id, {
        ...s,
        history: [],
        logFile: agentLogFile(state.id, id),
      }])
    ),
    updatedAt: Date.now(),
  };

  // Atomic: write temp → rename
  const target = stateFile(state.id);
  const tmp = target + '.tmp';
  writeFileSync(tmp, JSON.stringify(stateToSave, null, 2), 'utf-8');
  renameSync(tmp, target);

  // Save per-agent history
  for (const [agentId, agentState] of Object.entries(state.agentStates)) {
    const adir = agentDir(state.id, agentId);
    mkdirSync(adir, { recursive: true });
    writeFileSync(agentHistoryFile(state.id, agentId), JSON.stringify(agentState.history, null, 2), 'utf-8');
  }
}

// ─── Append Log ──────────────────────────────────────────

/** Append a single log entry to an agent's JSONL log file (async) */
export async function appendAgentLog(workspaceId: string, agentId: string, entry: TaskLogEntry): Promise<void> {
  const dir = agentDir(workspaceId, agentId);
  await mkdir(dir, { recursive: true });
  await appendFile(agentLogFile(workspaceId, agentId), JSON.stringify(entry) + '\n', 'utf-8');
}

// ─── Load ────────────────────────────────────────────────

export function loadWorkspace(workspaceId: string): WorkspaceState | null {
  const file = stateFile(workspaceId);
  if (!existsSync(file)) return null;

  try {
    const raw = readFileSync(file, 'utf-8');
    if (!raw || raw.trim().length === 0) {
      console.error(`[persistence] Empty state file for workspace ${workspaceId}`);
      return null;
    }
    const state: WorkspaceState = JSON.parse(raw);

    // Restore per-agent history
    for (const [agentId, agentState] of Object.entries(state.agentStates)) {
      const histFile = agentHistoryFile(workspaceId, agentId);
      if (existsSync(histFile)) {
        try {
          agentState.history = JSON.parse(readFileSync(histFile, 'utf-8'));
        } catch {
          agentState.history = [];
        }
      }

      // Migrate old status field to new two-layer model
      if ('status' in agentState && !('smithStatus' in agentState)) {
        const oldStatus = (agentState as any).status;
        (agentState as any).smithStatus = 'down';
        (agentState as any).mode = (agentState as any).runMode || 'auto';
        (agentState as any).taskStatus = (oldStatus === 'running' || oldStatus === 'listening') ? 'idle' :
                       (oldStatus === 'interrupted') ? 'idle' :
                       (oldStatus === 'waiting_approval') ? 'idle' :
                       (oldStatus === 'paused') ? 'idle' :
                       oldStatus;
        delete (agentState as any).status;
        delete (agentState as any).runMode;
        delete (agentState as any).daemonMode;
      }
      // Mark running agents as idle (they were killed on shutdown)
      if (agentState.taskStatus === 'running') {
        agentState.taskStatus = 'idle';
      }
    }

    // Migrate Input nodes: content → entries
    for (const agent of state.agents) {
      if (agent.type === 'input') {
        if (!agent.entries) agent.entries = [];
        if (agent.entries.length === 0 && agent.content) {
          agent.entries.push({ content: agent.content, timestamp: state.updatedAt || Date.now() });
        }
      }
    }

    return state;
  } catch {
    return null;
  }
}

// ─── List ────────────────────────────────────────────────

export interface WorkspaceSummary {
  id: string;
  projectPath: string;
  projectName: string;
  agentCount: number;
  createdAt: number;
  updatedAt: number;
}

export function listWorkspaces(): WorkspaceSummary[] {
  if (!existsSync(WORKSPACES_ROOT)) return [];

  const results: WorkspaceSummary[] = [];

  for (const entry of readdirSync(WORKSPACES_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = stateFile(entry.name);
    if (!existsSync(file)) continue;

    try {
      const raw = readFileSync(file, 'utf-8');
      const state: WorkspaceState = JSON.parse(raw);
      results.push({
        id: state.id,
        projectPath: state.projectPath,
        projectName: state.projectName,
        agentCount: state.agents.length,
        createdAt: state.createdAt,
        updatedAt: state.updatedAt,
      });
    } catch {
      // Skip corrupted state files
    }
  }

  return results.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Find workspace by project path */
export function findWorkspaceByProject(projectPath: string): WorkspaceState | null {
  if (!existsSync(WORKSPACES_ROOT)) return null;

  for (const entry of readdirSync(WORKSPACES_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = stateFile(entry.name);
    if (!existsSync(file)) continue;

    try {
      const raw = readFileSync(file, 'utf-8');
      const state: WorkspaceState = JSON.parse(raw);
      if (state.projectPath === projectPath) {
        return loadWorkspace(state.id);
      }
    } catch {
      continue;
    }
  }

  return null;
}

// ─── Delete ──────────────────────────────────────────────

export function deleteWorkspace(workspaceId: string): boolean {
  const dir = workspaceDir(workspaceId);
  if (!existsSync(dir)) return false;
  rmSync(dir, { recursive: true, force: true });
  return true;
}

// ─── Read Agent Logs ─────────────────────────────────────

/** Read the full JSONL log for an agent */
export function readAgentLog(workspaceId: string, agentId: string): TaskLogEntry[] {
  const file = agentLogFile(workspaceId, agentId);
  if (!existsSync(file)) return [];

  try {
    const raw = readFileSync(file, 'utf-8');
    return raw.split('\n').filter(Boolean).map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean) as TaskLogEntry[];
  } catch {
    return [];
  }
}

/** Read the last N log entries for an agent */
export function readAgentLogTail(workspaceId: string, agentId: string, n = 20): TaskLogEntry[] {
  const log = readAgentLog(workspaceId, agentId);
  return log.slice(-n);
}

/** Clear agent log file */
export function clearAgentLog(workspaceId: string, agentId: string): void {
  const file = agentLogFile(workspaceId, agentId);
  if (existsSync(file)) writeFileSync(file, '');
}

// ─── Auto-save timer ─────────────────────────────────────

const saveTimers = new Map<string, NodeJS.Timeout>();

/**
 * Start periodic auto-save for a workspace.
 * Calls `getState()` to get current state and saves it.
 */
export function startAutoSave(workspaceId: string, getState: () => WorkspaceState, intervalMs = 10_000): void {
  stopAutoSave(workspaceId);
  const timer = setInterval(() => {
    try {
      const state = getState();
      saveWorkspace(state).catch(() => {});
    } catch {
      // Silently ignore save errors
    }
  }, intervalMs);
  saveTimers.set(workspaceId, timer);
}

export function stopAutoSave(workspaceId: string): void {
  const timer = saveTimers.get(workspaceId);
  if (timer) {
    clearInterval(timer);
    saveTimers.delete(workspaceId);
  }
}
