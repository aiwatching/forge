/**
 * WorkspaceOrchestrator — manages a group of agents within a workspace.
 *
 * Responsibilities:
 * - Create/remove agents
 * - Run agents (auto-select backend, inject upstream context)
 * - Listen to agent events → trigger downstream agents
 * - Approval gating
 * - Parallel execution (independent agents run concurrently)
 * - Error recovery (restart from lastCheckpoint)
 */

import { EventEmitter } from 'node:events';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type {
  WorkspaceAgentConfig,
  AgentState,
  AgentStatus,
  WorkerEvent,
  BusMessage,
  Artifact,
  WorkspaceState,
} from './types';
import { AgentWorker } from './agent-worker';
import { AgentBus } from './agent-bus';
import { ApiBackend } from './backends/api-backend';
import { CliBackend } from './backends/cli-backend';
import { appendAgentLog, saveWorkspace, startAutoSave, stopAutoSave } from './persistence';
import {
  loadMemory, saveMemory, createMemory, formatMemoryForPrompt,
  addObservation, addSessionSummary, parseStepToObservations, buildSessionSummary,
} from './smith-memory';

// ─── Orchestrator Events ─────────────────────────────────

export type OrchestratorEvent =
  | WorkerEvent
  | { type: 'bus_message'; message: BusMessage }
  | { type: 'approval_required'; agentId: string; upstreamId: string }
  | { type: 'user_input_request'; agentId: string; fromAgent: string; question: string }
  | { type: 'workspace_status'; running: number; done: number; total: number }
  | { type: 'workspace_complete' };

// ─── Orchestrator class ──────────────────────────────────

export class WorkspaceOrchestrator extends EventEmitter {
  readonly workspaceId: string;
  readonly projectPath: string;
  readonly projectName: string;

  private agents = new Map<string, { config: WorkspaceAgentConfig; worker: AgentWorker | null; state: AgentState }>();
  private bus: AgentBus;
  private approvalQueue = new Set<string>();
  private createdAt = Date.now();

  constructor(workspaceId: string, projectPath: string, projectName: string) {
    super();
    this.workspaceId = workspaceId;
    this.projectPath = projectPath;
    this.projectName = projectName;
    this.bus = new AgentBus();

    // Forward bus messages as orchestrator events (after dedup, skip ACKs)
    this.bus.on('message', (msg: BusMessage) => {
      if (msg.type === 'ack') return; // ACKs are internal, don't emit to UI
      if (msg.to === '_system') {
        this.emit('event', { type: 'bus_message', message: msg } satisfies OrchestratorEvent);
        return;
      }
      this.handleBusMessage(msg);
    });

    // Start auto-save (every 10 seconds)
    startAutoSave(workspaceId, () => this.getFullState());
  }

  // ─── Agent Management ──────────────────────────────────

  /** Check if agent outputs or workDir conflict with existing agents */
  private validateOutputs(config: WorkspaceAgentConfig, excludeId?: string): string | null {
    if (config.type === 'input') return null;

    const normalize = (p: string) => p.replace(/\/$/, '') || '.';
    const isRoot = (dir?: string) => !dir || dir === './' || dir === '.' || dir === 'src/' || dir === 'src';

    for (const [id, entry] of this.agents) {
      if (id === excludeId || entry.config.type === 'input') continue;

      // Check workDir conflict: same working directory
      const newDir = normalize(config.workDir || './');
      const existingDir = normalize(entry.config.workDir || './');
      if (newDir === existingDir) {
        // Both root → only one allowed
        if (isRoot(config.workDir) && isRoot(entry.config.workDir)) {
          return `Work directory conflict: "${config.label}" and "${entry.config.label}" both use project root. Only one agent should use root directory.`;
        }
        // Same subdir
        if (newDir === existingDir && newDir !== '.') {
          return `Work directory conflict: "${config.label}" and "${entry.config.label}" both use "${newDir}/"`;
        }
      }

      // Check output path overlap
      for (const out of config.outputs) {
        for (const existing of entry.config.outputs) {
          if (normalize(out) === normalize(existing)) {
            return `Output conflict: "${config.label}" and "${entry.config.label}" both output to "${out}"`;
          }
        }
      }
    }
    return null;
  }

  addAgent(config: WorkspaceAgentConfig): void {
    const conflict = this.validateOutputs(config);
    if (conflict) {
      throw new Error(conflict);
      // Still add but warn — don't block
    }

    const state: AgentState = {
      status: 'idle',
      history: [],
      artifacts: [],
    };
    this.agents.set(config.id, { config, worker: null, state });
    this.saveNow();
    this.emitAgentsChanged();
  }

  removeAgent(id: string): void {
    const entry = this.agents.get(id);
    if (entry?.worker) {
      entry.worker.stop();
    }
    this.agents.delete(id);
    this.approvalQueue.delete(id);

    // Clean up dangling dependsOn references in other agents
    for (const [, other] of this.agents) {
      const idx = other.config.dependsOn.indexOf(id);
      if (idx !== -1) {
        other.config.dependsOn.splice(idx, 1);
      }
    }

    this.saveNow();
    this.emitAgentsChanged();
  }

  updateAgentConfig(id: string, config: WorkspaceAgentConfig): void {
    const entry = this.agents.get(id);
    if (!entry) return;
    const conflict = this.validateOutputs(config, id);
    if (conflict) throw new Error(conflict);
    if (entry.worker && entry.state.status === 'running') {
      entry.worker.stop();
    }
    entry.config = config;
    // Reset status but keep history/artifacts (don't wipe logs)
    entry.state.status = 'idle';
    entry.state.error = undefined;
    entry.worker = null;
    this.saveNow();
    this.emitAgentsChanged();
    // Push status update so frontend reflects the reset
    this.emit('event', { type: 'status', agentId: id, status: 'idle' } satisfies WorkerEvent);
  }

  getAgentState(id: string): Readonly<AgentState> | undefined {
    return this.agents.get(id)?.state;
  }

  getAllAgentStates(): Record<string, AgentState> {
    const result: Record<string, AgentState> = {};
    for (const [id, entry] of this.agents) {
      result[id] = entry.worker?.getState() ?? entry.state;
    }
    return result;
  }

  // ─── Execution ─────────────────────────────────────────

  /**
   * Complete an Input node — set its content and mark as done.
   * If re-submitted, resets downstream agents so they can re-run.
   */
  completeInput(agentId: string, content: string): void {
    const entry = this.agents.get(agentId);
    if (!entry || entry.config.type !== 'input') return;

    const isUpdate = entry.state.status === 'done';

    // Append to entries (incremental, not overwrite)
    if (!entry.config.entries) entry.config.entries = [];
    entry.config.entries.push({ content, timestamp: Date.now() });
    // Keep bounded — max 100 entries, oldest removed
    if (entry.config.entries.length > 100) {
      entry.config.entries = entry.config.entries.slice(-100);
    }
    // Also set content to latest for backward compat
    entry.config.content = content;

    entry.state.status = 'done';
    entry.state.completedAt = Date.now();
    entry.state.artifacts = [{ type: 'text', summary: content.slice(0, 200) }];

    this.emit('event', { type: 'status', agentId, status: 'done' } satisfies WorkerEvent);
    this.emit('event', { type: 'done', agentId, summary: 'Input provided' } satisfies WorkerEvent);
    this.emitAgentsChanged(); // push updated entries to frontend
    this.bus.notifyTaskComplete(agentId, [], content.slice(0, 200));

    // If re-submitting, reset downstream agents to idle so they can be re-triggered
    if (isUpdate) {
      this.resetDownstream(agentId);
    }

    this.triggerDownstream(agentId);
    this.saveNow();
  }

  /** Reset an agent and all its downstream to idle (for re-run) */
  resetAgent(agentId: string): void {
    const entry = this.agents.get(agentId);
    if (!entry) return;
    if (entry.worker) entry.worker.stop();
    entry.worker = null;
    // Kill orphaned tmux session if manual agent
    if (entry.state.tmuxSession) {
      try {
        const { execSync } = require('node:child_process');
        execSync(`tmux kill-session -t "${entry.state.tmuxSession}" 2>/dev/null`, { timeout: 3000 });
        console.log(`[workspace] Killed tmux session ${entry.state.tmuxSession}`);
      } catch {} // session might already be dead
    }
    entry.state = { status: 'idle', history: [], artifacts: [] };
    this.emit('event', { type: 'status', agentId, status: 'idle' } satisfies WorkerEvent);
    this.emitAgentsChanged();
    this.saveNow();
  }

  /** Reset all agents that depend on the given agent (recursively) */
  private resetDownstream(agentId: string, visited = new Set<string>()): void {
    if (visited.has(agentId)) return; // cycle protection
    visited.add(agentId);

    for (const [id, entry] of this.agents) {
      if (id === agentId) continue;
      if (!entry.config.dependsOn.includes(agentId)) continue;
      if (entry.state.status === 'idle') continue;
      console.log(`[workspace] Resetting ${entry.config.label} (${id}) to idle (upstream ${agentId} changed)`);
      if (entry.worker) entry.worker.stop();
      entry.worker = null;
      entry.state = { status: 'idle', history: [], artifacts: [] };
      this.emit('event', { type: 'status', agentId: id, status: 'idle' } satisfies WorkerEvent);
      this.resetDownstream(id, visited);
    }
  }

  /** Validate that an agent can run (sync check). Throws on error. */
  validateCanRun(agentId: string): void {
    const entry = this.agents.get(agentId);
    if (!entry) throw new Error(`Agent "${agentId}" not found`);
    if (entry.config.type === 'input') return;
    if (entry.state.status === 'running') throw new Error(`Agent "${entry.config.label}" is already running`);
    for (const depId of entry.config.dependsOn) {
      const dep = this.agents.get(depId);
      if (!dep) throw new Error(`Dependency "${depId}" not found (deleted?). Edit the agent to fix.`);
      if (dep.state.status !== 'done') throw new Error(`Dependency "${dep.config.label}" not completed yet`);
    }
  }

  /** Run a specific agent. Checks dependencies first. userInput is for root agents (no dependencies). */
  async runAgent(agentId: string, userInput?: string): Promise<void> {
    const entry = this.agents.get(agentId);
    if (!entry) throw new Error(`Agent "${agentId}" not found`);

    // Input nodes are completed via completeInput(), not run
    if (entry.config.type === 'input') {
      if (userInput) this.completeInput(agentId, userInput);
      return;
    }

    if (entry.state.status === 'running') return;

    // Allow re-running done/failed/interrupted/waiting_approval agents — reset them first
    let resumeFromCheckpoint = false;
    if (entry.state.status === 'done' || entry.state.status === 'failed' || entry.state.status === 'interrupted' || entry.state.status === 'waiting_approval') {
      this.approvalQueue.delete(agentId);
      console.log(`[workspace] Re-running ${entry.config.label} (was ${entry.state.status})`);
      // For failed/interrupted: keep lastCheckpoint for resume
      resumeFromCheckpoint = (entry.state.status === 'failed' || entry.state.status === 'interrupted')
        && entry.state.lastCheckpoint !== undefined;
      if (entry.worker) entry.worker.stop();
      entry.worker = null;
      if (!resumeFromCheckpoint) {
        entry.state = { status: 'idle', history: [], artifacts: [] };
      } else {
        entry.state.status = 'idle';
        entry.state.error = undefined;
        entry.state.runMode = undefined;
      }
    }

    const { config } = entry;

    // Check if all dependencies are done
    for (const depId of config.dependsOn) {
      const dep = this.agents.get(depId);
      if (!dep || dep.state.status !== 'done') {
        throw new Error(`Dependency "${dep?.config.label || depId}" not completed yet`);
      }
    }

    // Build upstream context from dependencies (includes Input node content)
    let upstreamContext = this.buildUpstreamContext(config);
    if (userInput) {
      const prefix = '## Additional Instructions:\n' + userInput;
      upstreamContext = upstreamContext ? prefix + '\n\n---\n\n' + upstreamContext : prefix;
    }

    // Create backend
    const backend = this.createBackend(config, agentId);

    // Create worker with bus callbacks for inter-agent communication
    // Load agent memory
    const memory = loadMemory(this.workspaceId, agentId);
    const memoryContext = formatMemoryForPrompt(memory);

    const peerAgentIds = Array.from(this.agents.keys()).filter(id => id !== agentId);
    const worker = new AgentWorker({
      config,
      backend,
      projectPath: this.projectPath,
      peerAgentIds,
      memoryContext: memoryContext || undefined,
      onBusSend: (to, content) => {
        this.bus.send(agentId, to, 'notify', { action: 'agent_message', content });
      },
      onBusRequest: async (to, question) => {
        const response = await this.bus.request(agentId, to, { action: 'question', content: question });
        return response.payload.content || '(no response)';
      },
      onMemoryUpdate: (stepResults) => {
        this.updateAgentMemory(agentId, config, stepResults);
      },
    });
    entry.worker = worker;

    // Forward worker events
    worker.on('event', (event: WorkerEvent) => {
      // Sync state
      entry.state = worker.getState() as AgentState;

      // Persist log entries to disk
      if (event.type === 'log') {
        appendAgentLog(this.workspaceId, agentId, event.entry).catch(() => {});
      }

      this.emit('event', event);

      // Update liveness
      if (event.type === 'status') {
        this.updateAgentLiveness(agentId);
      }

      // On step complete → capture observation + notify bus
      if (event.type === 'step') {
        const step = config.steps[event.stepIndex];
        if (step) {
          this.bus.notifyStepComplete(agentId, step.label);

          // Capture memory observation from the previous step's result
          const prevStepIdx = event.stepIndex - 1;
          if (prevStepIdx >= 0) {
            const prevStep = config.steps[prevStepIdx];
            const prevResult = entry.state.history
              .filter(h => h.type === 'result' && h.subtype === 'step_complete')
              .slice(-1)[0];
            if (prevResult && prevStep) {
              const obs = parseStepToObservations(prevStep.label, prevResult.content, entry.state.artifacts);
              for (const o of obs) {
                addObservation(this.workspaceId, agentId, config.label, config.role, o).catch(() => {});
              }
            }
          }
        }
      }

      // On done → parse bus markers + notify + trigger downstream
      if (event.type === 'done') {
        const files = entry.state.artifacts.filter(a => a.path).map(a => a.path!);
        console.log(`[workspace] Agent "${config.label}" (${agentId}) completed. Artifacts: ${files.length}.`);

        // Parse CLI output for bus markers: [SEND:TargetLabel:action] content
        this.parseBusMarkers(agentId, entry.state.history);

        this.bus.notifyTaskComplete(agentId, files, event.summary);

        // Trigger idle downstream agents (first run)
        this.triggerDownstream(agentId);

        // Notify done downstream agents to re-validate (they already ran but upstream changed)
        this.notifyDownstreamForRevalidation(agentId, files);

        this.emitWorkspaceStatus();
        this.checkWorkspaceComplete();

        // Note: no auto-rerun. Bus messages that need re-run go through user approval.
      }

      // On error → notify bus
      if (event.type === 'error') {
        this.bus.notifyError(agentId, event.error);
        this.emitWorkspaceStatus();
      }
    });

    // Inject only undelivered (pending) bus messages addressed to this agent
    const pendingMsgs = this.bus.getPendingMessagesFor(agentId)
      .filter(m => m.from !== agentId); // don't inject own messages
    for (const msg of pendingMsgs) {
      const fromLabel = this.agents.get(msg.from)?.config.label || msg.from;
      worker.injectMessage({
        type: 'system',
        subtype: 'bus_message',
        content: `[From ${fromLabel}]: ${msg.payload.content || msg.payload.action}`,
        timestamp: new Date(msg.timestamp).toISOString(),
      });
      // Mark as delivered + ACK so sender knows it was received
      this.bus.markDelivered(msg.id);
      this.bus.ack(agentId, msg.from, msg.id);
    }

    // Start from checkpoint if recovering from failure
    const startStep = resumeFromCheckpoint && entry.state.lastCheckpoint !== undefined
      ? entry.state.lastCheckpoint + 1
      : 0;

    this.emitWorkspaceStatus();

    // Execute (non-blocking — fire and forget, events handle the rest)
    worker.execute(startStep, upstreamContext).catch(err => {
      // Only set failed if worker didn't already handle it (avoid duplicate error events)
      if (entry.state.status !== 'failed') {
        entry.state.status = 'failed';
        entry.state.error = err?.message || String(err);
        this.emit('event', { type: 'error', agentId, error: entry.state.error! } satisfies WorkerEvent);
      }
    });
  }

  /** Run all agents that have no unmet dependencies */
  async runAll(): Promise<void> {
    const ready = this.getReadyAgents();
    await Promise.all(ready.map(id => this.runAgent(id)));
  }

  /** Pause a running agent */
  pauseAgent(agentId: string): void {
    const entry = this.agents.get(agentId);
    entry?.worker?.pause();
  }

  /** Resume a paused agent */
  resumeAgent(agentId: string): void {
    const entry = this.agents.get(agentId);
    entry?.worker?.resume();
  }

  /** Stop a running agent */
  stopAgent(agentId: string): void {
    const entry = this.agents.get(agentId);
    entry?.worker?.stop();
  }

  /** Retry a failed agent from its last checkpoint */
  async retryAgent(agentId: string): Promise<void> {
    const entry = this.agents.get(agentId);
    if (!entry) return;
    if (entry.state.status !== 'failed' && entry.state.status !== 'interrupted') return;
    await this.runAgent(agentId);
  }

  /** Send a message to a running agent (human intervention) */
  sendMessageToAgent(agentId: string, content: string): void {
    const entry = this.agents.get(agentId);
    if (!entry) return;

    const logEntry = {
      type: 'system' as const,
      subtype: 'user_message',
      content: `[User]: ${content}`,
      timestamp: new Date().toISOString(),
    };

    // Always log to bus
    this.bus.send('user', agentId, 'notify', {
      action: 'user_message',
      content,
    });

    if (entry.worker) {
      // Agent is running — inject into pending messages for next step
      entry.worker.injectMessage(logEntry);
    } else {
      // Agent is idle/done — store in history so it's available on next run
      entry.state.history.push(logEntry);
    }

    // Emit so UI can show the message
    this.emit('event', { type: 'log', agentId, entry: logEntry } satisfies WorkerEvent);
  }

  /** Approve a waiting agent to start execution */
  approveAgent(agentId: string): void {
    if (!this.approvalQueue.has(agentId)) return;
    this.approvalQueue.delete(agentId);
    this.runAgent(agentId).catch(() => {});
  }

  /** Save tmux session name for an agent (for reattach after refresh) */
  setTmuxSession(agentId: string, sessionName: string): void {
    const entry = this.agents.get(agentId);
    if (!entry) return;
    entry.state.tmuxSession = sessionName;
    this.saveNow();
    this.emitAgentsChanged();
  }

  /** Switch an agent to manual mode (user operates in terminal) */
  setManualMode(agentId: string): void {
    const entry = this.agents.get(agentId);
    if (!entry) return;
    if (entry.worker) entry.worker.stop();
    entry.worker = null;
    entry.state.runMode = 'manual';
    entry.state.tmuxSession = undefined; // clear stale session — new one will be saved via setTmuxSession
    entry.state.status = 'running';
    entry.state.startedAt = Date.now();
    this.emit('event', { type: 'status', agentId, status: 'running' } satisfies WorkerEvent);
    this.emitAgentsChanged();
    this.saveNow();
    console.log(`[workspace] Agent "${entry.config.label}" switched to manual mode`);
  }

  /** Complete a manual agent — called by forge-done skill from terminal */
  completeManualAgent(agentId: string, changedFiles: string[]): void {
    const entry = this.agents.get(agentId);
    if (!entry) return;

    entry.state.status = 'done';
    entry.state.runMode = undefined; // clear manual mode
    entry.state.completedAt = Date.now();
    entry.state.artifacts = changedFiles.map(f => ({ type: 'file' as const, path: f }));

    console.log(`[workspace] Manual agent "${entry.config.label}" marked done. ${changedFiles.length} files changed.`);

    this.emit('event', { type: 'status', agentId, status: 'done' } satisfies WorkerEvent);
    this.emit('event', { type: 'done', agentId, summary: `Manual: ${changedFiles.length} files changed` } satisfies WorkerEvent);
    this.emitAgentsChanged();

    // Notify ALL agents that depend on this one (not just direct downstream)
    this.bus.notifyTaskComplete(agentId, changedFiles, `Manual work: ${changedFiles.length} files`);

    // Send individual bus messages to all downstream agents so they know
    for (const [id, other] of this.agents) {
      if (id === agentId || other.config.type === 'input') continue;
      if (other.config.dependsOn.includes(agentId)) {
        this.bus.send(agentId, id, 'notify', {
          action: 'update_notify',
          content: `${entry.config.label} completed manual work: ${changedFiles.length} files changed`,
          files: changedFiles,
        });
      }
    }

    this.triggerDownstream(agentId);
    this.notifyDownstreamForRevalidation(agentId, changedFiles);
    this.emitWorkspaceStatus();
    this.checkWorkspaceComplete();
    this.saveNow();
  }

  /** Reject an approval (set agent back to idle) */
  rejectApproval(agentId: string): void {
    this.approvalQueue.delete(agentId);
    const entry = this.agents.get(agentId);
    if (entry) {
      entry.state.status = 'idle';
      this.emit('event', { type: 'status', agentId, status: 'idle' } satisfies WorkerEvent);
    }
  }

  // ─── Bus Access ────────────────────────────────────────

  getBus(): AgentBus {
    return this.bus;
  }

  getBusLog(): readonly BusMessage[] {
    return this.bus.getLog();
  }

  // ─── State Snapshot (for persistence) ──────────────────

  /** Get full workspace state for auto-save */
  getFullState(): WorkspaceState {
    return {
      id: this.workspaceId,
      projectPath: this.projectPath,
      projectName: this.projectName,
      agents: Array.from(this.agents.values()).map(e => e.config),
      agentStates: this.getAllAgentStates(),
      nodePositions: {},
      busLog: [...this.bus.getLog()],
      busOutbox: this.bus.getAllOutbox(),
      createdAt: this.createdAt,
      updatedAt: Date.now(),
    };
  }

  getSnapshot(): {
    agents: WorkspaceAgentConfig[];
    agentStates: Record<string, AgentState>;
    busLog: BusMessage[];
  } {
    return {
      agents: Array.from(this.agents.values()).map(e => e.config),
      agentStates: this.getAllAgentStates(),
      busLog: [...this.bus.getLog()],
    };
  }

  /** Restore from persisted state */
  loadSnapshot(data: {
    agents: WorkspaceAgentConfig[];
    agentStates: Record<string, AgentState>;
    busLog: BusMessage[];
    busOutbox?: Record<string, BusMessage[]>;
  }): void {
    this.agents.clear();
    for (const config of data.agents) {
      const state = data.agentStates[config.id] || { status: 'idle' as const, history: [], artifacts: [] };
      // Mark interrupted agents as recoverable
      if (state.status === 'running') {
        state.status = 'interrupted';
      }
      this.agents.set(config.id, { config, worker: null, state });
    }
    this.bus.loadLog(data.busLog);
    if (data.busOutbox) {
      this.bus.loadOutbox(data.busOutbox);
    }

    // Initialize liveness for all loaded agents so bus delivery works
    for (const [agentId] of this.agents) {
      this.updateAgentLiveness(agentId);
    }
  }

  /** Stop all agents, save final state, and clean up */
  shutdown(): void {
    stopAutoSave(this.workspaceId);
    // Final save before shutdown
    saveWorkspace(this.getFullState()).catch(() => {});
    for (const [, entry] of this.agents) {
      entry.worker?.stop();
    }
    this.bus.clear();
  }

  // ─── Private ───────────────────────────────────────────

  private createBackend(config: WorkspaceAgentConfig, agentId?: string) {
    switch (config.backend) {
      case 'api':
        return new ApiBackend();
      case 'cli':
      default: {
        // Resume existing claude session if available
        const existingSessionId = agentId ? this.agents.get(agentId)?.state.cliSessionId : undefined;
        const backend = new CliBackend(existingSessionId);
        // Persist new sessionId back to agent state
        if (agentId) {
          backend.onSessionId = (id) => {
            const entry = this.agents.get(agentId);
            if (entry) entry.state.cliSessionId = id;
          };
        }
        return backend;
      }
    }
  }

  /** Build context string from upstream agents' outputs */
  private buildUpstreamContext(config: WorkspaceAgentConfig): string | undefined {
    if (config.dependsOn.length === 0) return undefined;

    const sections: string[] = [];

    for (const depId of config.dependsOn) {
      const dep = this.agents.get(depId);
      if (!dep || dep.state.status !== 'done') continue;

      const label = dep.config.label;

      // Input nodes: only send latest entry (not full history)
      if (dep.config.type === 'input') {
        const entries = dep.config.entries;
        if (entries && entries.length > 0) {
          const latest = entries[entries.length - 1];
          sections.push(`### ${label} (latest input):\n${latest.content}`);
        } else if (dep.config.content) {
          // Legacy fallback
          sections.push(`### ${label}:\n${dep.config.content}`);
        }
        continue;
      }

      const artifacts = dep.state.artifacts.filter(a => a.path);

      if (artifacts.length === 0) {
        const lastResult = [...dep.state.history].reverse().find(h => h.type === 'result');
        if (lastResult) {
          sections.push(`### From ${label}:\n${lastResult.content}`);
        }
        continue;
      }

      // Read file artifacts
      for (const artifact of artifacts) {
        if (!artifact.path) continue;
        const fullPath = resolve(this.projectPath, artifact.path);
        try {
          if (existsSync(fullPath)) {
            const content = readFileSync(fullPath, 'utf-8');
            const truncated = content.length > 10000
              ? content.slice(0, 10000) + '\n... (truncated)'
              : content;
            sections.push(`### From ${label} — ${artifact.path}:\n${truncated}`);
          }
        } catch {
          sections.push(`### From ${label} — ${artifact.path}: (could not read file)`);
        }
      }
    }

    if (sections.length === 0) return undefined;

    let combined = sections.join('\n\n---\n\n');

    // Cap total upstream context to ~50K chars (~12K tokens) to prevent token explosion
    const MAX_UPSTREAM_CHARS = 50000;
    if (combined.length > MAX_UPSTREAM_CHARS) {
      combined = combined.slice(0, MAX_UPSTREAM_CHARS) + '\n\n... (upstream context truncated, ' + combined.length + ' chars total)';
    }

    return combined;
  }

  /** After an agent completes, check if any downstream agents should be triggered */
  private triggerDownstream(completedAgentId: string): void {
    console.log(`[workspace] triggerDownstream for ${completedAgentId}. Checking ${this.agents.size} agents...`);
    for (const [id, entry] of this.agents) {
      if (id === completedAgentId) continue;
      if (entry.state.status !== 'idle') {
        console.log(`[workspace]   ${entry.config.label} (${id}): skip — status=${entry.state.status}`);
        continue;
      }
      if (!entry.config.dependsOn.includes(completedAgentId)) {
        console.log(`[workspace]   ${entry.config.label} (${id}): skip — doesn't depend on ${completedAgentId} (deps: ${entry.config.dependsOn.join(',')})`);
        continue;
      }

      // Check if ALL dependencies are done
      const allDepsDone = entry.config.dependsOn.every(depId => {
        const dep = this.agents.get(depId);
        return dep && dep.state.status === 'done';
      });

      if (!allDepsDone) continue;

      // Approval gate
      if (entry.config.requiresApproval) {
        entry.state.status = 'waiting_approval';
        this.approvalQueue.add(id);
        this.emit('event', {
          type: 'approval_required',
          agentId: id,
          upstreamId: completedAgentId,
        } satisfies OrchestratorEvent);
        this.emit('event', {
          type: 'status',
          agentId: id,
          status: 'waiting_approval',
        } satisfies WorkerEvent);
        continue;
      }

      // Auto-trigger
      this.runAgent(id).catch(err => {
        entry.state.status = 'failed';
        entry.state.error = err?.message || String(err);
        this.emit('event', { type: 'error', agentId: id, error: entry.state.error! } satisfies WorkerEvent);
      });
    }
  }

  // ─── Agent liveness ─────────────────────────────────────

  private updateAgentLiveness(agentId: string): void {
    const entry = this.agents.get(agentId);
    if (!entry) {
      this.bus.setAgentStatus(agentId, 'down');
      return;
    }
    const s = entry.state.status;
    if (s === 'running') this.bus.setAgentStatus(agentId, 'busy');
    else if (s === 'idle' || s === 'done' || s === 'paused') this.bus.setAgentStatus(agentId, 'alive');
    else this.bus.setAgentStatus(agentId, 'down');
  }

  // ─── Bus message handling ──────────────────────────────

  private handleBusMessage(msg: BusMessage): void {
    // Dedup
    if (this.bus.isDuplicate(msg.id)) return;

    // Emit to UI after dedup (no duplicates, no ACKs)
    this.emit('event', { type: 'bus_message', message: msg } satisfies OrchestratorEvent);

    // Route to target
    this.routeMessageToAgent(msg.to, msg);
    this.checkWorkspaceComplete();
  }

  private routeMessageToAgent(targetId: string, msg: BusMessage): void {
    const target = this.agents.get(targetId);
    if (!target) return;

    const fromLabel = this.agents.get(msg.from)?.config.label || msg.from;
    const action = msg.payload.action;
    const content = msg.payload.content || '';

    console.log(`[bus] ${fromLabel} → ${target.config.label}: ${action} "${content.slice(0, 80)}"`);

    const logEntry = {
      type: 'system' as const,
      subtype: 'bus_message',
      content: `[From ${fromLabel}]: ${content || action}`,
      timestamp: new Date(msg.timestamp).toISOString(),
    };

    // Helper: ACK + mark delivered when message is actually consumed
    const ackAndDeliver = () => {
      this.bus.markDelivered(msg.id);
      this.bus.ack(targetId, msg.from, msg.id);
    };

    // ── Input node: request user input ──
    if (target.config.type === 'input') {
      if (action === 'info_request' || action === 'question') {
        ackAndDeliver();
        this.emit('event', {
          type: 'user_input_request',
          agentId: targetId,
          fromAgent: msg.from,
          question: content,
        } satisfies OrchestratorEvent);
      }
      return;
    }

    // ── Store message in agent history (always) ──
    target.state.history.push(logEntry);

    // ── Actionable messages → queue for user confirmation ──
    if (action === 'fix_request' || action === 'update_request' || action === 'update_notify') {
      // Don't auto-rerun. Set waiting_approval so user decides.
      if (target.state.status !== 'running') {
        // Don't ACK yet — message stays pending until agent actually runs and processes it
        target.state.status = 'waiting_approval';
        this.approvalQueue.add(targetId);
        this.emit('event', {
          type: 'approval_required',
          agentId: targetId,
          upstreamId: msg.from,
        } satisfies OrchestratorEvent);
        this.emit('event', {
          type: 'status',
          agentId: targetId,
          status: 'waiting_approval',
        } satisfies WorkerEvent);
        console.log(`[bus] ${target.config.label} needs approval to re-run (${action} from ${fromLabel})`);
      } else {
        // Running: inject message into current execution for awareness
        ackAndDeliver();
        if (target.worker) target.worker.injectMessage(logEntry);
      }
      return;
    }

    // ── Informational messages → inject if running, store only if not ──
    if (target.worker) {
      ackAndDeliver();
      target.worker.injectMessage(logEntry);
    }
    // If not running, message stays pending in history — will be picked up on next runAgent
  }

  /** Check if all agents are done and no pending work remains */
  private checkWorkspaceComplete(): void {
    let allDone = true;
    for (const [, entry] of this.agents) {
      const s = entry.worker?.getState().status ?? entry.state.status;
      if (s === 'running' || s === 'paused' || s === 'waiting_approval') {
        allDone = false;
        break;
      }
      // idle agents with unmet deps don't block completion
      if (s === 'idle' && entry.config.dependsOn.length > 0) {
        const allDepsDone = entry.config.dependsOn.every(depId => {
          const dep = this.agents.get(depId);
          return dep && (dep.state.status === 'done');
        });
        if (allDepsDone) {
          allDone = false; // idle but ready to run = not complete
          break;
        }
      }
    }

    if (allDone && this.agents.size > 0) {
      const hasPendingRequests = this.bus.getLog().some(m =>
        m.type === 'request' && !this.bus.getLog().some(r =>
          r.type === 'response' && r.payload.replyTo === m.id
        )
      );
      if (!hasPendingRequests) {
        console.log('[workspace] All agents complete, no pending requests. Workspace done.');
        this.emit('event', { type: 'workspace_complete' } satisfies OrchestratorEvent);
      }
    }
  }

  /** Get agents that are idle and have all dependencies met */
  private getReadyAgents(): string[] {
    const ready: string[] = [];
    for (const [id, entry] of this.agents) {
      if (entry.state.status !== 'idle') continue;
      const allDepsDone = entry.config.dependsOn.every(depId => {
        const dep = this.agents.get(depId);
        return dep && dep.state.status === 'done';
      });
      if (allDepsDone) ready.push(id);
    }
    return ready;
  }

  /**
   * Parse CLI agent output for bus message markers.
   * Format: [SEND:TargetLabel:action] content
   * Example: [SEND:Engineer:fix_request] SQL injection found in auth module
   */
  /**
   * After an agent completes, notify downstream agents that already ran (done/failed)
   * to re-validate their work. Sets them to waiting_approval so user decides.
   */
  private notifyDownstreamForRevalidation(completedAgentId: string, files: string[]): void {
    const completedLabel = this.agents.get(completedAgentId)?.config.label || completedAgentId;

    for (const [id, entry] of this.agents) {
      if (id === completedAgentId) continue;
      if (!entry.config.dependsOn.includes(completedAgentId)) continue;

      // Only notify agents that already completed — they need to re-validate
      if (entry.state.status !== 'done' && entry.state.status !== 'failed') continue;

      console.log(`[workspace] ${completedLabel} changed → ${entry.config.label} needs re-validation`);

      // Send bus message
      this.bus.send(completedAgentId, id, 'notify', {
        action: 'update_notify',
        content: `${completedLabel} completed with changes. Please re-validate.`,
        files,
      });

      // Set to waiting_approval so user confirms re-run
      entry.state.status = 'waiting_approval';
      entry.state.history.push({
        type: 'system',
        subtype: 'revalidation_request',
        content: `[${completedLabel}] completed with changes — approve to re-run validation`,
        timestamp: new Date().toISOString(),
      });
      this.approvalQueue.add(id);
      this.emit('event', { type: 'status', agentId: id, status: 'waiting_approval' } satisfies WorkerEvent);
      this.emit('event', {
        type: 'approval_required',
        agentId: id,
        upstreamId: completedAgentId,
      } satisfies OrchestratorEvent);
    }
  }

  private parseBusMarkers(fromAgentId: string, history: { type: string; content: string }[]): void {
    const markerRegex = /\[SEND:([^:]+):([^\]]+)\]\s*(.+)/g;
    const labelToId = new Map<string, string>();
    for (const [id, e] of this.agents) {
      labelToId.set(e.config.label.toLowerCase(), id);
    }

    // Dedup: same target+action+content = only send once
    const sent = new Set<string>();

    for (const entry of history) {
      let match;
      while ((match = markerRegex.exec(entry.content)) !== null) {
        const targetLabel = match[1].trim();
        const action = match[2].trim();
        const content = match[3].trim();
        const targetId = labelToId.get(targetLabel.toLowerCase());

        if (targetId && targetId !== fromAgentId) {
          const key = `${targetId}:${action}:${content}`;
          if (sent.has(key)) continue;
          sent.add(key);

          console.log(`[bus] Parsed marker from ${fromAgentId}: → ${targetLabel} (${action}): ${content.slice(0, 60)}`);
          this.bus.send(fromAgentId, targetId, 'notify', { action, content });
        }
      }
    }
  }

  private saveNow(): void {
    saveWorkspace(this.getFullState()).catch(() => {});
  }

  /** Emit agents_changed so SSE pushes the updated list to frontend */
  private emitAgentsChanged(): void {
    const agents = Array.from(this.agents.values()).map(e => e.config);
    const agentStates = this.getAllAgentStates();
    this.emit('event', { type: 'agents_changed', agents, agentStates } satisfies WorkerEvent);
  }

  private emitWorkspaceStatus(): void {
    let running = 0, done = 0;
    for (const [, entry] of this.agents) {
      const s = entry.worker?.getState().status ?? entry.state.status;
      if (s === 'running') running++;
      if (s === 'done') done++;
    }
    this.emit('event', {
      type: 'workspace_status',
      running,
      done,
      total: this.agents.size,
    } satisfies OrchestratorEvent);
  }

  /**
   * Update agent memory after execution completes.
   * Parses step results into structured memory entries.
   */
  private async updateAgentMemory(agentId: string, config: WorkspaceAgentConfig, stepResults: string[]): Promise<void> {
    try {
      const entry = this.agents.get(agentId);

      // Capture observation from the last step (previous steps captured in 'step' event handler)
      const lastStep = config.steps[config.steps.length - 1];
      const lastResult = stepResults[stepResults.length - 1];
      if (lastStep && lastResult) {
        const obs = parseStepToObservations(lastStep.label, lastResult, entry?.state.artifacts || []);
        for (const o of obs) {
          await addObservation(this.workspaceId, agentId, config.label, config.role, o);
        }
      }

      // Add session summary
      const summary = buildSessionSummary(
        config.steps.map(s => s.label),
        stepResults,
        entry?.state.artifacts || [],
      );
      await addSessionSummary(this.workspaceId, agentId, summary);

      console.log(`[workspace] Updated memory for ${config.label}`);
    } catch (err: any) {
      console.error(`[workspace] Failed to update memory for ${config.label}:`, err.message);
    }
  }
}
