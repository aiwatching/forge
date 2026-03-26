/**
 * Workspace Manager — singleton that manages live orchestrator instances.
 *
 * API routes use this to get/create orchestrators.
 * Orchestrators are cached per workspace ID.
 */

import { WorkspaceOrchestrator, type OrchestratorEvent } from './orchestrator';
import { loadWorkspace, saveWorkspace } from './persistence';
import type { WorkspaceState, WorkspaceAgentConfig } from './types';

// Persist across HMR in dev mode
const g = globalThis as any;
if (!g.__forgeOrchestrators) g.__forgeOrchestrators = new Map<string, WorkspaceOrchestrator>();
if (!g.__forgeSseListeners) g.__forgeSseListeners = new Map<string, Set<(event: OrchestratorEvent) => void>>();

const orchestrators: Map<string, WorkspaceOrchestrator> = g.__forgeOrchestrators;
const sseListeners: Map<string, Set<(event: OrchestratorEvent) => void>> = g.__forgeSseListeners;

/** Force reload an orchestrator from disk (clears cache) */
export function reloadOrchestrator(workspaceId: string): WorkspaceOrchestrator | null {
  const existing = orchestrators.get(workspaceId);
  if (existing) {
    existing.shutdown();
    orchestrators.delete(workspaceId);
  }
  return getOrchestrator(workspaceId);
}

/**
 * Get or create an orchestrator for a workspace.
 * Loads from disk if not in memory.
 */
export function getOrchestrator(workspaceId: string): WorkspaceOrchestrator | null {
  const existing = orchestrators.get(workspaceId);
  if (existing) return existing;

  // Try to load from disk
  const state = loadWorkspace(workspaceId);
  if (!state) return null;

  return createOrchestratorFromState(state);
}

/**
 * Create a new orchestrator for a workspace state.
 */
export function createOrchestratorFromState(state: WorkspaceState): WorkspaceOrchestrator {
  // If already cached (e.g. called twice), return existing
  const cached = orchestrators.get(state.id);
  if (cached) return cached;

  const orch = new WorkspaceOrchestrator(state.id, state.projectPath, state.projectName);

  // Load existing agents and states
  if (state.agents.length > 0) {
    orch.loadSnapshot({
      agents: state.agents,
      agentStates: state.agentStates,
      busLog: state.busLog,
      busOutbox: state.busOutbox,
    });
  }

  // Forward events to SSE listeners
  orch.on('event', (event: OrchestratorEvent) => {
    const listeners = sseListeners.get(state.id);
    if (listeners) {
      for (const fn of listeners) {
        try { fn(event); } catch {}
      }
    }
  });

  orchestrators.set(state.id, orch);
  return orch;
}

/**
 * Get orchestrator by project path (finds workspace first).
 */
export function getOrchestratorByProject(projectPath: string): WorkspaceOrchestrator | null {
  // Check cached
  for (const [, orch] of orchestrators) {
    if (orch.projectPath === projectPath) return orch;
  }

  // Try loading from disk
  const { findWorkspaceByProject } = require('./persistence');
  const state = findWorkspaceByProject(projectPath);
  if (!state) return null;

  return getOrchestrator(state.id);
}

/**
 * Subscribe to SSE events for a workspace.
 */
export function subscribeSSE(workspaceId: string, listener: (event: OrchestratorEvent) => void): () => void {
  let listeners = sseListeners.get(workspaceId);
  if (!listeners) {
    listeners = new Set();
    sseListeners.set(workspaceId, listeners);
  }
  listeners.add(listener);

  // Return unsubscribe function
  return () => {
    listeners!.delete(listener);
    if (listeners!.size === 0) {
      sseListeners.delete(workspaceId);
    }
  };
}

/**
 * Shutdown a specific orchestrator.
 */
export function shutdownOrchestrator(workspaceId: string): void {
  const orch = orchestrators.get(workspaceId);
  if (orch) {
    orch.shutdown();
    orchestrators.delete(workspaceId);
  }
}

/**
 * Shutdown all orchestrators (on server stop).
 */
export function shutdownAll(): void {
  for (const [id, orch] of orchestrators) {
    orch.shutdown();
  }
  orchestrators.clear();
  sseListeners.clear();
}
