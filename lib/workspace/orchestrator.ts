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
import { readFileSync, existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import type {
  WorkspaceAgentConfig,
  AgentState,
  SmithStatus,
  TaskStatus,
  WorkerEvent,
  BusMessage,
  Artifact,
  WorkspaceState,
  DaemonWakeReason,
} from './types';
import { AgentWorker } from './agent-worker';
import { AgentBus } from './agent-bus';
import { WatchManager } from './watch-manager';
// ApiBackend loaded dynamically — its dependency chain uses @/src path aliases
// that only work in Next.js context, not in standalone tsx process
// import { ApiBackend } from './backends/api-backend';
import { CliBackend } from './backends/cli-backend';
import { appendAgentLog, saveWorkspace, saveWorkspaceSync, startAutoSave, stopAutoSave } from './persistence';
import { hasForgeSkills, installForgeSkills } from './skill-installer';
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
  | { type: 'workspace_complete' }
  | { type: 'watch_alert'; agentId: string; changes: any[]; summary: string; timestamp: number };

// ─── Orchestrator class ──────────────────────────────────

export class WorkspaceOrchestrator extends EventEmitter {
  readonly workspaceId: string;
  readonly projectPath: string;
  readonly projectName: string;

  private agents = new Map<string, { config: WorkspaceAgentConfig; worker: AgentWorker | null; state: AgentState }>();
  private bus: AgentBus;
  private watchManager: WatchManager;
  private sessionMonitor: import('./session-monitor').SessionFileMonitor | null = null;
  private approvalQueue = new Set<string>();
  private daemonActive = false;
  private createdAt = Date.now();
  private healthCheckTimer: NodeJS.Timeout | null = null;

  /** Emit a log event (auto-persisted via constructor listener) */
  emitLog(agentId: string, entry: any): void {
    this.emit('event', { type: 'log', agentId, entry } as any);
  }

  constructor(workspaceId: string, projectPath: string, projectName: string) {
    super();
    this.workspaceId = workspaceId;
    this.projectPath = projectPath;
    this.projectName = projectName;
    this.bus = new AgentBus();
    this.watchManager = new WatchManager(workspaceId, projectPath, () => this.agents as any);

    // Auto-persist all log events to disk (so LogPanel can read them)
    this.on('event', (event: any) => {
      if (event.type === 'log' && event.agentId && event.entry) {
        appendAgentLog(this.workspaceId, event.agentId, event.entry).catch(() => {});
      }
    });
    // Handle watch events
    this.watchManager.on('watch_alert', (event) => {
      this.emit('event', event);
      // Push alert to agent history so Log panel shows it
      const alertEntry = this.agents.get(event.agentId);
      if (alertEntry && event.entry) {
        alertEntry.state.history.push(event.entry);
        this.emit('event', { type: 'log', agentId: event.agentId, entry: event.entry } as any);
      }
      this.handleWatchAlert(event.agentId, event.summary);
    });
    // Note: watch_heartbeat (no changes) only logs to console, not to agent history/logs.jsonl

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

    const normalize = (p: string) => p.replace(/^\.?\//, '').replace(/\/$/, '') || '.';

    // Validate workDir is within project (no ../ escape)
    if (config.workDir) {
      const relativeDir = config.workDir.replace(/^\.?\//, '');
      if (relativeDir.includes('..')) {
        return `Work directory "${config.workDir}" contains "..". Must be a subdirectory of the project.`;
      }
      const projectRoot = this.projectPath.endsWith('/') ? this.projectPath : this.projectPath + '/';
      const resolved = resolve(this.projectPath, relativeDir);
      if (resolved !== this.projectPath && !resolved.startsWith(projectRoot)) {
        return `Work directory "${config.workDir}" is outside the project. Must be a subdirectory.`;
      }
    }

    // Every non-input smith must have a unique workDir
    const newDir = normalize(config.workDir || '.');

    for (const [id, entry] of this.agents) {
      if (id === excludeId || entry.config.type === 'input') continue;

      const existingDir = normalize(entry.config.workDir || '.');

      // Same workDir → conflict
      if (newDir === existingDir) {
        return `Work directory conflict: "${config.label}" and "${entry.config.label}" both use "${newDir === '.' ? 'project root' : newDir}/". Each smith must have a unique work directory.`;
      }

      // One is parent of the other → conflict (e.g., "src" and "src/components")
      if (newDir.startsWith(existingDir + '/') || existingDir.startsWith(newDir + '/')) {
        return `Work directory conflict: "${config.label}" (${newDir}/) overlaps with "${entry.config.label}" (${existingDir}/). Nested directories not allowed.`;
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

  /** Detect if adding dependsOn edges would create a cycle in the DAG */
  private detectCycle(agentId: string, dependsOn: string[]): string | null {
    // Build adjacency: agent → agents it depends on
    const deps = new Map<string, string[]>();
    for (const [id, entry] of this.agents) {
      if (id !== agentId) deps.set(id, [...entry.config.dependsOn]);
    }
    deps.set(agentId, [...dependsOn]);

    // DFS cycle detection
    const visited = new Set<string>();
    const inStack = new Set<string>();

    const dfs = (node: string): string | null => {
      if (inStack.has(node)) return node; // cycle found
      if (visited.has(node)) return null;
      visited.add(node);
      inStack.add(node);
      for (const dep of deps.get(node) || []) {
        const cycle = dfs(dep);
        if (cycle) return cycle;
      }
      inStack.delete(node);
      return null;
    };

    for (const id of deps.keys()) {
      const cycle = dfs(id);
      if (cycle) {
        const cycleName = this.agents.get(cycle)?.config.label || cycle;
        return `Circular dependency detected involving "${cycleName}". Dependencies must form a DAG (no cycles).`;
      }
    }
    return null;
  }

  /** Check if agentA is upstream of agentB (A is in B's dependency chain) */
  isUpstream(agentA: string, agentB: string): boolean {
    const visited = new Set<string>();
    const check = (current: string): boolean => {
      if (current === agentA) return true;
      if (visited.has(current)) return false;
      visited.add(current);
      const entry = this.agents.get(current);
      if (!entry) return false;
      return entry.config.dependsOn.some(dep => check(dep));
    };
    return check(agentB);
  }

  /** Get the primary agent for this workspace (if any) */
  getPrimaryAgent(): { config: WorkspaceAgentConfig; state: AgentState } | null {
    for (const [, entry] of this.agents) {
      if (entry.config.primary) return entry;
    }
    return null;
  }

  addAgent(config: WorkspaceAgentConfig): void {
    const conflict = this.validateOutputs(config);
    if (conflict) throw new Error(conflict);

    // Check DAG cycle before adding
    const cycleErr = this.detectCycle(config.id, config.dependsOn);
    if (cycleErr) throw new Error(cycleErr);

    // Primary agent validation
    this.validatePrimaryRules(config);

    const state: AgentState = {
      smithStatus: 'down',
      taskStatus: 'idle',
      history: [],
      artifacts: [],
    };
    // Primary agent: force terminal-only, root dir
    if (config.primary) {
      config.persistentSession = true;
      config.workDir = './';
    }
    this.agents.set(config.id, { config, worker: null, state });
    // If daemon active, start persistent session + worker
    if (this.daemonActive && config.type !== 'input' && config.persistentSession) {
      this.enterDaemonListening(config.id);
      const entry = this.agents.get(config.id)!;
      entry.state.smithStatus = 'active';
      this.ensurePersistentSession(config.id, config).then(() => {
        this.startMessageLoop(config.id);
      });
    }
    this.saveNow();
    this.emitAgentsChanged();
  }

  removeAgent(id: string): void {
    const entry = this.agents.get(id);
    if (entry?.config.primary) throw new Error('Cannot remove the primary agent');
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

  /** Validate primary agent rules */
  private validatePrimaryRules(config: WorkspaceAgentConfig, excludeId?: string): void {
    if (config.primary) {
      // Only one primary allowed
      for (const [id, entry] of this.agents) {
        if (id !== excludeId && entry.config.primary) {
          throw new Error(`Only one primary agent allowed. "${entry.config.label}" is already primary.`);
        }
      }
    }
    // Non-primary agents cannot use root directory if a primary exists
    if (!config.primary && config.type !== 'input') {
      const workDir = config.workDir?.replace(/\/+$/, '') || '';
      if (!workDir || workDir === '.' || workDir === './') {
        const primary = this.getPrimaryAgent();
        if (primary && primary.config.id !== excludeId) {
          throw new Error(`Root directory is reserved for primary agent "${primary.config.label}". Choose a subdirectory.`);
        }
      }
    }
  }

  updateAgentConfig(id: string, config: WorkspaceAgentConfig): void {
    const entry = this.agents.get(id);
    if (!entry) return;
    const conflict = this.validateOutputs(config, id);
    if (conflict) throw new Error(conflict);
    const cycleErr = this.detectCycle(id, config.dependsOn);
    if (cycleErr) throw new Error(cycleErr);
    this.validatePrimaryRules(config, id);
    // Primary agent: force terminal-only, root dir
    if (config.primary) {
      config.persistentSession = true;
      config.workDir = './';
    }
    if (entry.worker && entry.state.taskStatus === 'running') {
      entry.worker.stop();
    }

    // If agent CLI changed (claude→codex, etc.), kill old terminal and clear bound session
    const agentChanged = entry.config.agentId !== config.agentId;
    if (agentChanged) {
      console.log(`[workspace] ${config.label}: agent changed ${entry.config.agentId} → ${config.agentId}`);
      if (entry.state.tmuxSession) {
        try { execSync(`tmux kill-session -t "${entry.state.tmuxSession}" 2>/dev/null`, { timeout: 3000 }); } catch {}
        console.log(`[workspace] ${config.label}: killed tmux session ${entry.state.tmuxSession}`);
      }
      entry.state.tmuxSession = undefined;
      config.boundSessionId = undefined;
    }

    entry.config = config;
    // Reset status but keep history/artifacts (don't wipe logs)
    entry.state.taskStatus = 'idle';
    entry.state.error = undefined;
    if (entry.worker) {
      entry.worker.removeAllListeners();
      entry.worker.stop();
    }
    entry.worker = null;

    if (this.daemonActive) {
      // Rebuild worker + message loop
      this.enterDaemonListening(id);
      entry.state.smithStatus = 'active';
      // Restart watch if config changed
      this.watchManager.startWatch(id, config);
      // Create persistent session if configured (before message loop so inject works)
      if (config.persistentSession) {
        this.ensurePersistentSession(id, config).then(() => {
          this.startMessageLoop(id);
        });
      } else {
        this.startMessageLoop(id);
      }
    }
    this.saveNow();
    this.emitAgentsChanged();
    this.emit('event', { type: 'task_status', agentId: id, taskStatus: 'idle' } satisfies WorkerEvent);
    this.emit('event', { type: 'smith_status', agentId: id, smithStatus: entry.state.smithStatus } as any);
  }

  getAgentState(id: string): Readonly<AgentState> | undefined {
    return this.agents.get(id)?.state;
  }

  getAllAgentStates(): Record<string, AgentState> {
    const result: Record<string, AgentState> = {};
    for (const [id, entry] of this.agents) {
      const workerState = entry.worker?.getState();
      // Merge: worker state for task/smith, entry.state for mode (orchestrator controls mode)
      result[id] = workerState
        ? { ...workerState, taskStatus: entry.state.taskStatus, tmuxSession: entry.state.tmuxSession, currentMessageId: entry.state.currentMessageId }
        : entry.state;
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

    const isUpdate = entry.state.taskStatus === 'done';

    // Append to entries (incremental, not overwrite)
    if (!entry.config.entries) entry.config.entries = [];
    entry.config.entries.push({ content, timestamp: Date.now() });
    // Keep bounded — max 100 entries, oldest removed
    if (entry.config.entries.length > 100) {
      entry.config.entries = entry.config.entries.slice(-100);
    }
    // Also set content to latest for backward compat
    entry.config.content = content;

    entry.state.taskStatus = 'done';
    entry.state.completedAt = Date.now();
    entry.state.artifacts = [{ type: 'text', summary: content.slice(0, 200) }];

    this.emit('event', { type: 'task_status', agentId, taskStatus: 'done' } satisfies WorkerEvent);
    this.emit('event', { type: 'done', agentId, summary: 'Input provided' } satisfies WorkerEvent);
    this.emitAgentsChanged(); // push updated entries to frontend
    this.bus.notifyTaskComplete(agentId, [], content.slice(0, 200));

    // Send input_updated messages to downstream agents via bus
    // routeMessageToAgent handles auto-execution for active smiths
    for (const [id, downstream] of this.agents) {
      if (downstream.config.type === 'input') continue;
      if (!downstream.config.dependsOn.includes(agentId)) continue;
      this.bus.send(agentId, id, 'notify', {
        action: 'input_updated',
        content: content.slice(0, 500),
      });
      console.log(`[bus] Input → ${downstream.config.label}: input_updated`);
    }

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
    entry.state = { smithStatus: 'down', taskStatus: 'idle', history: entry.state.history, artifacts: [] };
    this.emit('event', { type: 'task_status', agentId, taskStatus: 'idle' } satisfies WorkerEvent);
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
      if (entry.state.taskStatus === 'idle') continue;
      console.log(`[workspace] Resetting ${entry.config.label} (${id}) to idle (upstream ${agentId} changed)`);
      if (entry.worker) entry.worker.stop();
      entry.worker = null;
      entry.state = { smithStatus: entry.state.smithStatus, taskStatus: 'idle', history: entry.state.history, artifacts: [], cliSessionId: entry.state.cliSessionId };
      this.emit('event', { type: 'task_status', agentId: id, taskStatus: 'idle' } satisfies WorkerEvent);
      this.resetDownstream(id, visited);
    }
  }

  /** Validate that an agent can run (sync check). Throws on error. */
  validateCanRun(agentId: string): void {
    const entry = this.agents.get(agentId);
    if (!entry) throw new Error(`Agent "${agentId}" not found`);
    if (entry.config.type === 'input') return;
    if (entry.state.taskStatus === 'running') throw new Error(`Agent "${entry.config.label}" is already running`);
    for (const depId of entry.config.dependsOn) {
      const dep = this.agents.get(depId);
      if (!dep) throw new Error(`Dependency "${depId}" not found (deleted?). Edit the agent to fix.`);
      if (dep.state.taskStatus !== 'done') {
        const hint = dep.state.taskStatus === 'idle' ? ' (never executed — run it first)'
          : dep.state.taskStatus === 'failed' ? ' (failed — retry it first)'
          : dep.state.taskStatus === 'running' ? ' (still running — wait for it to finish)'
          : '';
        throw new Error(`Dependency "${dep.config.label}" not completed yet${hint}`);
      }
    }
  }

  /** Run a specific agent. Requires daemon mode. force=true bypasses status checks (for retry). */
  async runAgent(agentId: string, userInput?: string, force = false): Promise<void> {
    if (!this.daemonActive) {
      throw new Error('Start daemon first before running agents');
    }
    const label = this.agents.get(agentId)?.config.label || agentId;
    console.log(`[workspace] runAgent(${label}, force=${force})`, new Error().stack?.split('\n').slice(2, 5).join(' <- '));
    return this.runAgentDaemon(agentId, userInput, force);
  }

  /** @deprecated Use runAgent (which now delegates to daemon mode) */
  private async runAgentLegacy(agentId: string, userInput?: string): Promise<void> {
    const entry = this.agents.get(agentId);
    if (!entry) throw new Error(`Agent "${agentId}" not found`);

    // Input nodes are completed via completeInput(), not run
    if (entry.config.type === 'input') {
      if (userInput) this.completeInput(agentId, userInput);
      return;
    }

    if (entry.state.taskStatus === 'running') return;

    // Allow re-running done/failed/idle(was interrupted)/waiting_approval agents — reset them first
    let resumeFromCheckpoint = false;
    if (entry.state.taskStatus === 'done' || entry.state.taskStatus === 'failed' || entry.state.taskStatus === 'idle' || this.approvalQueue.has(agentId)) {
      this.approvalQueue.delete(agentId);
      console.log(`[workspace] Re-running ${entry.config.label} (was taskStatus=${entry.state.taskStatus})`);
      // For failed: keep lastCheckpoint for resume
      resumeFromCheckpoint = (entry.state.taskStatus === 'failed')
        && entry.state.lastCheckpoint !== undefined;
      if (entry.worker) entry.worker.stop();
      entry.worker = null;
      if (!resumeFromCheckpoint) {
        entry.state = { smithStatus: entry.state.smithStatus, taskStatus: 'idle', history: entry.state.history, artifacts: [], cliSessionId: entry.state.cliSessionId };
      } else {
        entry.state.taskStatus = 'idle';
        entry.state.error = undefined;
      }
    }

    const { config } = entry;

    // Check if all dependencies are done
    for (const depId of config.dependsOn) {
      const dep = this.agents.get(depId);
      if (!dep || dep.state.taskStatus !== 'done') {
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
      projectPath: this.projectPath, workspaceId: this.workspaceId,
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
      if (event.type === 'task_status' || event.type === 'smith_status') {
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

      // On done → notify + trigger downstream (or reply to sender if from downstream)
      if (event.type === 'done') {
        this.handleAgentDone(agentId, entry, event.summary);

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
      msg.status = 'done';
    }

    // Start from checkpoint if recovering from failure
    const startStep = resumeFromCheckpoint && entry.state.lastCheckpoint !== undefined
      ? entry.state.lastCheckpoint + 1
      : 0;

    this.emitWorkspaceStatus();

    // Execute (non-blocking — fire and forget, events handle the rest)
    worker.execute(startStep, upstreamContext).catch(err => {
      // Only set failed if worker didn't already handle it (avoid duplicate error events)
      if (entry.state.taskStatus !== 'failed') {
        entry.state.taskStatus = 'failed';
        entry.state.error = err?.message || String(err);
        this.emit('event', { type: 'error', agentId, error: entry.state.error! } satisfies WorkerEvent);
      }
    });
  }

  /** Run all agents — starts daemon if not active, then runs all ready agents */
  async runAll(): Promise<void> {
    if (!this.daemonActive) {
      return this.startDaemon();
    }
    const ready = this.getDaemonReadyAgents();
    await Promise.all(ready.map(id => this.runAgentDaemon(id)));
  }

  /** Run a single agent in daemon mode. force=true resets failed/interrupted agents. triggerMessageId tracks which bus message started this. */
  async runAgentDaemon(agentId: string, userInput?: string, force = false, triggerMessageId?: string): Promise<void> {
    const entry = this.agents.get(agentId);
    if (!entry) throw new Error(`Agent "${agentId}" not found`);

    if (entry.config.type === 'input') {
      if (userInput) this.completeInput(agentId, userInput);
      return;
    }

    if (entry.state.taskStatus === 'running' && !force) return;
    // Already has a daemon worker running → skip (unless force retry)
    if (entry.worker && entry.state.smithStatus === 'active' && !force) return;

    // Already done → enter daemon listening directly (don't re-run steps)
    if (entry.state.taskStatus === 'done' && !force) {
      return this.enterDaemonListening(agentId);
    }

    if (!force) {
      // Failed → leave as-is, user must retry explicitly
      if (entry.state.taskStatus === 'failed') return;
      // waiting_approval → leave as-is
      if (this.approvalQueue.has(agentId)) return;
    }

    // Reset state for fresh start — preserve smithStatus and mode
    if (entry.state.taskStatus !== 'idle') {
      this.approvalQueue.delete(agentId);
      if (entry.worker) entry.worker.stop();
      entry.worker = null;
      entry.state = {
        smithStatus: entry.state.smithStatus,
        taskStatus: 'idle',
        history: [],
        artifacts: [],
        cliSessionId: entry.state.cliSessionId, // preserve session for --resume
      };
    }

    // Ensure smith is active when daemon starts this agent
    if (this.daemonActive && entry.state.smithStatus !== 'active') {
      entry.state.smithStatus = 'active';
      this.emit('event', { type: 'smith_status', agentId, smithStatus: 'active' } satisfies WorkerEvent);
    }

    const { config } = entry;

    // Check dependencies
    for (const depId of config.dependsOn) {
      const dep = this.agents.get(depId);
      if (!dep) throw new Error(`Dependency "${depId}" not found`);
      if (force) {
        // Manual trigger: only require upstream smith to be active (online)
        if (dep.config.type !== 'input' && dep.state.smithStatus !== 'active') {
          throw new Error(`Dependency "${dep.config.label}" smith is not active — start daemon first`);
        }
      } else {
        // Auto trigger: require upstream task completed
        if (dep.state.taskStatus !== 'done') {
          throw new Error(`Dependency "${dep.config.label}" not completed yet`);
        }
      }
    }

    let upstreamContext = this.buildUpstreamContext(config);
    if (userInput) {
      const prefix = '## Additional Instructions:\n' + userInput;
      upstreamContext = upstreamContext ? prefix + '\n\n---\n\n' + upstreamContext : prefix;
    }

    const backend = this.createBackend(config, agentId);
    const memory = loadMemory(this.workspaceId, agentId);
    const memoryContext = formatMemoryForPrompt(memory);
    const peerAgentIds = Array.from(this.agents.keys()).filter(id => id !== agentId);

    const worker = new AgentWorker({
      config, backend,
      projectPath: this.projectPath, workspaceId: this.workspaceId,
      peerAgentIds,
      memoryContext: memoryContext || undefined,
      onBusSend: (to, content) => {
        this.bus.send(agentId, to, 'notify', { action: 'agent_message', content });
      },
      onBusRequest: async (to, question) => {
        const response = await this.bus.request(agentId, to, { action: 'question', content: question });
        return response.payload.content || '(no response)';
      },
      onMessageDone: (messageId) => {
        const busMsg = this.bus.getLog().find(m => m.id === messageId);
        if (busMsg) {
          busMsg.status = 'done';
          this.emit('event', { type: 'bus_message_status', messageId, status: 'done' } as any);
          this.emitAgentsChanged();
        }
      },
      onMessageFailed: (messageId) => {
        const busMsg = this.bus.getLog().find(m => m.id === messageId);
        if (busMsg) {
          busMsg.status = 'failed';
          this.emit('event', { type: 'bus_message_status', messageId, status: 'failed' } as any);
          this.emitAgentsChanged();
        }
      },
      onMemoryUpdate: (stepResults) => {
        try {
          const observations = stepResults.flatMap((r, i) =>
            parseStepToObservations(config.steps[i]?.label || `Step ${i}`, r, entry.state.artifacts)
          );
          for (const obs of observations) addObservation(this.workspaceId, agentId, config.label, config.role, obs);
          const stepLabels = config.steps.map(s => s.label);
          const summary = buildSessionSummary(stepLabels, stepResults, entry.state.artifacts);
          addSessionSummary(this.workspaceId, agentId, summary);
        } catch {}
      },
    });

    entry.worker = worker;

    // Track trigger message so smith can mark it done/failed on completion
    if (triggerMessageId) {
      worker.setProcessingMessage(triggerMessageId);
    }

    // Forward events (same as runAgent)
    worker.on('event', (event: WorkerEvent) => {
      if (event.type === 'task_status') {
        entry.state.taskStatus = event.taskStatus;
        entry.state.error = event.error;
        if (event.taskStatus === 'running') entry.state.startedAt = Date.now();
        const workerState = worker.getState();
        entry.state.daemonIteration = workerState.daemonIteration;
      }
      if (event.type === 'smith_status') {
        entry.state.smithStatus = event.smithStatus;
      }
      if (event.type === 'log') {
        appendAgentLog(this.workspaceId, agentId, event.entry).catch(() => {});
      }
      this.emit('event', event);
      if (event.type === 'task_status' || event.type === 'smith_status') {
        this.updateAgentLiveness(agentId);
      }
      if (event.type === 'step' && event.stepIndex >= 0) {
        const step = config.steps[event.stepIndex];
        if (step) this.bus.notifyStepComplete(agentId, step.label);
      }
      if (event.type === 'done') {
        this.handleAgentDone(agentId, entry, event.summary);
      }
      if (event.type === 'error') {
        this.bus.notifyError(agentId, event.error);
        this.emitWorkspaceStatus();
      }
    });

    // Inject pending messages
    const pendingMsgs = this.bus.getPendingMessagesFor(agentId)
      .filter(m => m.from !== agentId);
    for (const msg of pendingMsgs) {
      const fromLabel = this.agents.get(msg.from)?.config.label || msg.from;
      worker.injectMessage({
        type: 'system', subtype: 'bus_message',
        content: `[From ${fromLabel}]: ${msg.payload.content || msg.payload.action}`,
        timestamp: new Date(msg.timestamp).toISOString(),
      });
      msg.status = 'done';
    }

    this.emitWorkspaceStatus();

    // Execute in daemon mode (non-blocking)
    worker.executeDaemon(0, upstreamContext).catch(err => {
      if (entry.state.taskStatus !== 'failed') {
        entry.state.taskStatus = 'failed';
        entry.state.error = err?.message || String(err);
        this.emit('event', { type: 'error', agentId, error: entry.state.error! } satisfies WorkerEvent);
      }
    });
  }

  /** Start all agents in daemon mode — orchestrator manages each smith's lifecycle */
  async startDaemon(): Promise<void> {
    if (this.daemonActive) return;
    this.daemonActive = true;
    console.log(`[workspace] Starting daemon mode...`);

    // Clean up stale state from previous run
    this.bus.markAllRunningAsFailed();

    // Install forge skills globally (once per daemon start)
    try {
      installForgeSkills(this.projectPath, this.workspaceId, '', Number(process.env.PORT) || 8403);
    } catch {}

    // Start each smith one by one, verify each starts correctly
    let started = 0;
    let failed = 0;
    for (const [id, entry] of this.agents) {
      if (entry.config.type === 'input') continue;

      // Kill any stale worker from previous run
      if (entry.worker) {
        entry.worker.stop();
        entry.worker = null;
      }

      // Stop any existing message loop
      this.stopMessageLoop(id);

      try {
        // 1. Start daemon listening loop (creates worker)
        this.enterDaemonListening(id);

        // 2. Verify worker was created
        if (!entry.worker) {
          throw new Error('Worker not created');
        }

        // 3. Set smith status to active
        entry.state.smithStatus = 'active';
        entry.state.error = undefined;

        // 4. Start message loop (delayed for persistent session agents — session must exist first)
        if (!entry.config.persistentSession) {
          this.startMessageLoop(id);
        }

        // 5. Update liveness for bus routing
        this.updateAgentLiveness(id);

        // 6. Notify frontend
        this.emit('event', { type: 'smith_status', agentId: id, smithStatus: 'active' } satisfies WorkerEvent);

        started++;
        console.log(`[daemon] ✓ ${entry.config.label}: active (task=${entry.state.taskStatus})`);
      } catch (err: any) {
        entry.state.smithStatus = 'down';
        entry.state.error = `Failed to start: ${err.message}`;
        this.emit('event', { type: 'smith_status', agentId: id, smithStatus: 'down' } satisfies WorkerEvent);
        failed++;
        console.error(`[daemon] ✗ ${entry.config.label}: failed — ${err.message}`);
      }
    }

    // Create persistent terminal sessions, then start their message loops
    for (const [id, entry] of this.agents) {
      if (entry.config.type === 'input' || !entry.config.persistentSession) continue;
      await this.ensurePersistentSession(id, entry.config);
      // Only start message loop if session was created successfully
      if (entry.state.smithStatus === 'active') {
        this.startMessageLoop(id);
      } else {
        console.log(`[daemon] ${entry.config.label}: skipped message loop (smith=${entry.state.smithStatus})`);
      }
    }

    // Start watch loops for agents with watch config
    this.watchManager.start();

    // Start session file monitors for agents with known session IDs
    this.startSessionMonitors().catch(err => console.error('[session-monitor] Failed to start:', err.message));

    // Start health check — monitor all agents every 10s, auto-heal
    this.startHealthCheck();

    console.log(`[workspace] Daemon started: ${started} smiths active, ${failed} failed`);
    this.emitAgentsChanged();
  }

  /** Get agents that can start in daemon mode (idle, done — with deps met) */
  private getDaemonReadyAgents(): string[] {
    const ready: string[] = [];
    for (const [id, entry] of this.agents) {
      if (entry.config.type === 'input') continue;
      if (entry.state.taskStatus === 'running' || entry.state.smithStatus === 'active') {
        console.log(`[daemon]   ${entry.config.label}: already smithStatus=${entry.state.smithStatus} taskStatus=${entry.state.taskStatus}`);
        continue;
      }
      const allDepsDone = entry.config.dependsOn.every(depId => {
        const dep = this.agents.get(depId);
        return dep && (dep.state.taskStatus === 'done');
      });
      if (allDepsDone) {
        console.log(`[daemon]   ${entry.config.label}: ready (taskStatus=${entry.state.taskStatus})`);
        ready.push(id);
      } else {
        const unmet = entry.config.dependsOn.filter(d => {
          const dep = this.agents.get(d);
          return !dep || (dep.state.taskStatus !== 'done');
        }).map(d => this.agents.get(d)?.config.label || d);
        console.log(`[daemon]   ${entry.config.label}: not ready — deps unmet: ${unmet.join(', ')} (taskStatus=${entry.state.taskStatus})`);
      }
    }
    return ready;
  }

  /** Put a done agent into daemon listening mode without re-running steps */
  private enterDaemonListening(agentId: string): void {
    const entry = this.agents.get(agentId);
    if (!entry) return;

    // Stop existing worker first to prevent duplicate execution
    if (entry.worker) {
      entry.worker.removeAllListeners();
      entry.worker.stop();
      entry.worker = null;
    }

    const { config } = entry;

    const backend = this.createBackend(config, agentId);
    const peerAgentIds = Array.from(this.agents.keys()).filter(id => id !== agentId);

    const worker = new AgentWorker({
      config, backend,
      projectPath: this.projectPath, workspaceId: this.workspaceId,
      peerAgentIds,
      initialTaskStatus: entry.state.taskStatus, // preserve current task status
      onBusSend: (to, content) => {
        this.bus.send(agentId, to, 'notify', { action: 'agent_message', content });
      },
      onBusRequest: async (to, question) => {
        const response = await this.bus.request(agentId, to, { action: 'question', content: question });
        return response.payload.content || '(no response)';
      },
      onMessageDone: (messageId) => {
        const busMsg = this.bus.getLog().find(m => m.id === messageId);
        if (busMsg) {
          busMsg.status = 'done';
          this.emit('event', { type: 'bus_message_status', messageId, status: 'done' } as any);
          this.emitAgentsChanged();
        }
      },
      onMessageFailed: (messageId) => {
        const busMsg = this.bus.getLog().find(m => m.id === messageId);
        if (busMsg) {
          busMsg.status = 'failed';
          this.emit('event', { type: 'bus_message_status', messageId, status: 'failed' } as any);
          this.emitAgentsChanged();
        }
      },
    });

    entry.worker = worker;

    // Forward events (same handler as runAgentDaemon)
    worker.on('event', (event: WorkerEvent) => {
      if (event.type === 'task_status') {
        entry.state.taskStatus = event.taskStatus;
        entry.state.error = event.error;
        const workerState = worker.getState();
        entry.state.daemonIteration = workerState.daemonIteration;
      }
      if (event.type === 'smith_status') {
        entry.state.smithStatus = event.smithStatus;
      }
      if (event.type === 'log') {
        appendAgentLog(this.workspaceId, agentId, event.entry).catch(() => {});
      }
      this.emit('event', event);
      if (event.type === 'task_status' || event.type === 'smith_status') {
        this.updateAgentLiveness(agentId);
      }
      if (event.type === 'done') {
        this.handleAgentDone(agentId, entry, event.summary);
      }
      if (event.type === 'error') {
        this.bus.notifyError(agentId, event.error);
      }
    });

    // Message loop (startMessageLoop) handles auto-consumption of pending messages

    console.log(`[workspace] Agent "${config.label}" entering daemon listening (task=${entry.state.taskStatus})`);

    // executeDaemon with skipSteps=true → goes directly to listening loop
    worker.executeDaemon(0, undefined, true).catch(err => {
      console.error(`[workspace] enterDaemonListening error for ${config.label}:`, err.message);
    });
  }

  /** Stop all agents (exit daemon mode) */
  /** Stop all agents — orchestrator shuts down each smith */
  stopDaemon(): void {
    this.daemonActive = false;
    console.log('[workspace] Stopping daemon...');

    for (const [id, entry] of this.agents) {
      if (entry.config.type === 'input') continue;

      // 1. Stop message loop
      this.stopMessageLoop(id);

      // 2. Stop worker
      if (entry.worker) {
        entry.worker.stop();
        entry.worker = null;
      }

      // 3. Kill tmux session (skip if user is attached to it)
      if (entry.state.tmuxSession) {
        let isAttached = false;
        try {
          const info = execSync(`tmux display-message -t "${entry.state.tmuxSession}" -p "#{session_attached}" 2>/dev/null`, { timeout: 3000, encoding: 'utf-8' }).trim();
          isAttached = info !== '0';
        } catch {}
        if (isAttached) {
          console.log(`[daemon] ${entry.config.label}: tmux session attached by user, not killing`);
        } else {
          try { execSync(`tmux kill-session -t "${entry.state.tmuxSession}" 2>/dev/null`, { timeout: 3000 }); } catch {}
        }
        entry.state.tmuxSession = undefined;
      }

      // 4. Set smith down, reset running tasks
      entry.state.smithStatus = 'down';
      if (entry.state.taskStatus === 'running') {
        entry.state.taskStatus = 'idle';
      }
      entry.state.error = undefined;
      this.updateAgentLiveness(id);
      this.emit('event', { type: 'smith_status', agentId: id, smithStatus: 'down' } satisfies WorkerEvent);

      console.log(`[daemon] ■ ${entry.config.label}: stopped`);
    }

    // Mark running messages as failed
    this.bus.markAllRunningAsFailed();
    this.emitAgentsChanged();
    this.watchManager.stop();
    this.stopAllTerminalMonitors();
    if (this.sessionMonitor) { this.sessionMonitor.stopAll(); this.sessionMonitor = null; }
    this.stopHealthCheck();
    this.forgeActedMessages.clear();
    console.log('[workspace] Daemon stopped');
  }

  // ─── Hook-based completion ─────────────────────────────

  /** Called by Claude Code Stop hook via HTTP — agent finished a turn */
  handleHookDone(agentId: string): void {
    const entry = this.agents.get(agentId);
    if (!entry) return;
    if (!this.daemonActive) return;

    // Only transition running → done (ignore if already idle/done)
    if (entry.state.taskStatus !== 'running') {
      console.log(`[hook] ${entry.config.label}: Stop hook fired but task=${entry.state.taskStatus}, ignoring`);
      return;
    }

    console.log(`[hook] ${entry.config.label}: Stop hook → done`);
    entry.state.taskStatus = 'done';
    entry.state.completedAt = Date.now();
    this.emit('event', { type: 'task_status', agentId, taskStatus: 'done' } as any);
    this.emit('event', { type: 'log', agentId, entry: { type: 'system', subtype: 'hook_done', content: 'Claude Code Stop hook: turn completed', timestamp: new Date().toISOString() } } as any);
    this.handleAgentDone(agentId, entry, 'Stop hook');
    this.sessionMonitor?.resetState(agentId);
    this.saveNow();
    this.emitAgentsChanged();
  }

  // ─── Session File Monitor ──────────────────────────────

  private async startSessionMonitors(): Promise<void> {
    console.log('[session-monitor] Initializing...');
    const { SessionFileMonitor } = await import('./session-monitor');
    this.sessionMonitor = new SessionFileMonitor();

    // Listen for state changes from session file monitor
    this.sessionMonitor.on('stateChange', (event: any) => {
      const entry = this.agents.get(event.agentId);
      if (!entry) {
        console.log(`[session-monitor] stateChange: agent ${event.agentId} not found in map`);
        return;
      }
      console.log(`[session-monitor] stateChange: ${entry.config.label} ${event.state} (current taskStatus=${entry.state.taskStatus})`);

      if (event.state === 'running' && entry.state.taskStatus !== 'running') {
        entry.state.taskStatus = 'running';
        console.log(`[session-monitor] → emitting task_status=running for ${entry.config.label}`);
        this.emit('event', { type: 'task_status', agentId: event.agentId, taskStatus: 'running' } as any);
        this.emitAgentsChanged();
      }

      if (event.state === 'done' && entry.state.taskStatus === 'running') {
        entry.state.taskStatus = 'done';
        this.emit('event', { type: 'task_status', agentId: event.agentId, taskStatus: 'done' } as any);
        console.log(`[session-monitor] ${event.agentId}: done — ${event.detail || 'turn completed'}`);
        this.handleAgentDone(event.agentId, entry, event.detail);
        this.emitAgentsChanged();
      }
    });

    // Start monitors for all agents with known session IDs
    for (const [id, entry] of this.agents) {
      if (entry.config.type === 'input') continue;
      await this.startAgentSessionMonitor(id, entry.config);
    }
  }

  private async startAgentSessionMonitor(agentId: string, config: WorkspaceAgentConfig): Promise<void> {
    if (!this.sessionMonitor) return;

    // Determine session file path
    let sessionId: string | undefined;

    if (config.primary) {
      try {
        const mod = await import('../project-sessions');
        sessionId = (mod as any).getFixedSession(this.projectPath);
        console.log(`[session-monitor] ${config.label}: primary fixedSession=${sessionId || 'NONE'}`);
      } catch (err: any) {
        console.log(`[session-monitor] ${config.label}: failed to get fixedSession: ${err.message}`);
      }
    } else {
      sessionId = config.boundSessionId;
      console.log(`[session-monitor] ${config.label}: boundSession=${sessionId || 'NONE'}`);
    }

    if (!sessionId) {
      // Try to auto-bind from session files on disk
      try {
        const sessionDir = this.getCliSessionDir(config.workDir);
        if (existsSync(sessionDir)) {
          const files = require('node:fs').readdirSync(sessionDir).filter((f: string) => f.endsWith('.jsonl'));
          if (files.length > 0) {
            const sorted = files
              .map((f: string) => ({ name: f, mtime: require('node:fs').statSync(join(sessionDir, f)).mtimeMs }))
              .sort((a: any, b: any) => b.mtime - a.mtime);
            sessionId = sorted[0].name.replace('.jsonl', '');
            if (!config.primary) {
              config.boundSessionId = sessionId;
              this.saveNow();
              console.log(`[session-monitor] ${config.label}: auto-bound to ${sessionId}`);
            }
          }
        }
      } catch {}
      if (!sessionId) {
        console.log(`[session-monitor] ${config.label}: no sessionId, skipping`);
        return;
      }
    }

    const { SessionFileMonitor } = await import('./session-monitor');
    const filePath = SessionFileMonitor.resolveSessionPath(this.projectPath, config.workDir, sessionId);
    this.sessionMonitor.startMonitoring(agentId, filePath);
  }

  // ─── Health Check — auto-heal agents ─────────────────

  private startHealthCheck(): void {
    if (this.healthCheckTimer) return;
    this.healthCheckTimer = setInterval(() => this.runHealthCheck(), 10_000);
    this.healthCheckTimer.unref();
  }

  private stopHealthCheck(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  private runHealthCheck(): void {
    if (!this.daemonActive) return;

    for (const [id, entry] of this.agents) {
      if (entry.config.type === 'input') continue;

      // Check 1: Worker should exist for all active agents
      if (!entry.worker) {
        console.log(`[health] ${entry.config.label}: no worker — recreating`);
        this.enterDaemonListening(id);
        entry.state.smithStatus = 'active';
        this.emit('event', { type: 'smith_status', agentId: id, smithStatus: 'active' } as any);
        continue;
      }

      // Check 2: SmithStatus should be active
      if (entry.state.smithStatus !== 'active') {
        console.log(`[health] ${entry.config.label}: smith=${entry.state.smithStatus} — setting active`);
        entry.state.smithStatus = 'active';
        this.emit('event', { type: 'smith_status', agentId: id, smithStatus: 'active' } as any);
      }

      // Check 3: Message loop should be running
      if (!this.messageLoopTimers.has(id)) {
        console.log(`[health] ${entry.config.label}: message loop stopped — restarting`);
        this.startMessageLoop(id);
      }

      // Check 4: Stale running messages (agent not actually running) → mark failed
      if (entry.state.taskStatus !== 'running') {
        const staleRunning = this.bus.getLog().filter(m => m.to === id && m.status === 'running' && m.type !== 'ack');
        for (const m of staleRunning) {
          const age = Date.now() - m.timestamp;
          if (age > 60_000) { // running for 60s+ but agent is idle = stale
            console.log(`[health] ${entry.config.label}: stale running message ${m.id.slice(0, 8)} (${Math.round(age/1000)}s) — marking failed`);
            m.status = 'failed';
            this.emit('event', { type: 'bus_message_status', messageId: m.id, status: 'failed' } as any);
          }
        }
      }

      // Check 5: Pending messages but agent idle — try wake
      if (entry.state.taskStatus !== 'running') {
        const pending = this.bus.getPendingMessagesFor(id).filter(m => m.from !== id && m.type !== 'ack');
        if (pending.length > 0 && entry.worker.isListening()) {
          // Message loop should handle this, but if it didn't, log it
          const age = Date.now() - pending[0].timestamp;
          if (age > 30_000) { // stuck for 30+ seconds
            console.log(`[health] ${entry.config.label}: ${pending.length} pending msg(s) stuck for ${Math.round(age/1000)}s — message loop should pick up`);
          }
        }
      }

      // Check 6: persistentSession agent without tmux → auto-restart terminal
      if (entry.config.persistentSession && !entry.state.tmuxSession) {
        console.log(`[health] ${entry.config.label}: persistentSession but no tmux — restarting terminal`);
        this.ensurePersistentSession(id, entry.config).catch(err => {
          console.error(`[health] ${entry.config.label}: failed to restart terminal: ${err.message}`);
        });
      }
    }

    // ── Forge Agent: autonomous bus monitor ──
    this.runForgeAgentCheck();
  }

  // Track which messages Forge agent already acted on (avoid duplicate nudges)
  private forgeActedMessages = new Set<string>();
  private forgeAgentStartTime = 0;

  /** Forge agent scans bus for actionable states (only recent messages) */
  private runForgeAgentCheck(): void {
    if (!this.forgeAgentStartTime) this.forgeAgentStartTime = Date.now();
    const log = this.bus.getLog();
    const now = Date.now();

    // Only scan messages from after daemon start (skip all history)
    for (const msg of log) {
      if (msg.timestamp < this.forgeAgentStartTime) continue;
      if (msg.type === 'ack' || msg.from === '_forge') continue;
      if (this.forgeActedMessages.has(msg.id)) continue;

      // Case 1: Message done but no reply from target → ask target to send summary (once per pair)
      // Skip notification-only messages that don't need replies
      if (msg.status === 'done') {
        const action = msg.payload?.action;
        if (action === 'upstream_complete' || action === 'task_complete' || action === 'ack') { this.forgeActedMessages.add(msg.id); continue; }
        if (msg.from === '_system' || msg.from === '_watch') { this.forgeActedMessages.add(msg.id); continue; }
        const age = now - msg.timestamp;
        if (age < 30_000) continue;

        // Dedup by target→sender pair (only nudge once per relationship)
        const nudgeKey = `nudge-${msg.to}->${msg.from}`;
        if (this.forgeActedMessages.has(nudgeKey)) { this.forgeActedMessages.add(msg.id); continue; }

        const hasReply = log.some(r =>
          r.from === msg.to && r.to === msg.from &&
          r.timestamp > msg.timestamp && r.type !== 'ack'
        );
        if (!hasReply) {
          const senderLabel = this.agents.get(msg.from)?.config.label || msg.from;
          const targetEntry = this.agents.get(msg.to);
          if (targetEntry && targetEntry.state.smithStatus === 'active') {
            this.bus.send('_forge', msg.to, 'notify', {
              action: 'info_request',
              content: `[IMPORTANT] You finished a task requested by ${senderLabel} but did not send them the results. You MUST call the MCP tool "send_message" (NOT the forge-send skill) with to="${senderLabel}" and include a summary of what you did and the outcome. Do not do any other work until you have sent this reply.`,
            });
            this.forgeActedMessages.add(msg.id);
            this.forgeActedMessages.add(nudgeKey);
            console.log(`[forge-agent] Nudged ${targetEntry.config.label} to reply to ${senderLabel} (once)`);
          }
        }
      }

      // Case 2: Message running too long (>5min) → log warning
      if (msg.status === 'running') {
        const age = now - msg.timestamp;
        if (age > 300_000 && !this.forgeActedMessages.has(`running-${msg.id}`)) {
          const targetLabel = this.agents.get(msg.to)?.config.label || msg.to;
          console.log(`[forge-agent] Warning: ${targetLabel} has been running message ${msg.id.slice(0, 8)} for ${Math.round(age / 60000)}min`);
          this.emit('event', { type: 'log', agentId: msg.to, entry: { type: 'system', subtype: 'warning', content: `Message running for ${Math.round(age / 60000)}min — may be stuck`, timestamp: new Date().toISOString() } } as any);
          this.forgeActedMessages.add(`running-${msg.id}`);
        }
      }

      // Case 3: Pending too long (>2min) → try to restart message loop
      if (msg.status === 'pending') {
        const age = now - msg.timestamp;
        if (age > 120_000 && !this.forgeActedMessages.has(`pending-${msg.id}`)) {
          const targetEntry = this.agents.get(msg.to);
          const targetLabel = targetEntry?.config.label || msg.to;

          // If agent is active but not running a task, restart message loop
          if (targetEntry && targetEntry.state.smithStatus === 'active' && targetEntry.state.taskStatus !== 'running') {
            if (!this.messageLoopTimers.has(msg.to)) {
              this.startMessageLoop(msg.to);
              console.log(`[forge-agent] Restarted message loop for ${targetLabel} (pending ${Math.round(age / 60000)}min)`);
            } else {
              console.log(`[forge-agent] ${targetLabel} has pending message ${msg.id.slice(0, 8)} for ${Math.round(age / 60000)}min — loop running but not consuming`);
            }
          }

          this.emit('event', { type: 'log', agentId: msg.to, entry: { type: 'system', subtype: 'warning', content: `Pending message from ${this.agents.get(msg.from)?.config.label || msg.from} waiting for ${Math.round(age / 60000)}min`, timestamp: new Date().toISOString() } } as any);
          this.forgeActedMessages.add(`pending-${msg.id}`);
        }
      }

      // Case 4: Failed → notify sender (once per sender→target pair)
      if (msg.status === 'failed') {
        const failKey = `failed-${msg.from}->${msg.to}`;
        if (!this.forgeActedMessages.has(failKey)) {
          const senderEntry = this.agents.get(msg.from);
          const targetLabel = this.agents.get(msg.to)?.config.label || msg.to;
          if (senderEntry && msg.from !== '_forge' && msg.from !== '_system') {
            this.bus.send('_forge', msg.from, 'notify', {
              action: 'update_notify',
              content: `Your message to ${targetLabel} has failed. You may want to retry or take a different approach.`,
            });
            console.log(`[forge-agent] Notified ${senderEntry.config.label} that message to ${targetLabel} failed (once)`);
          }
          this.forgeActedMessages.add(failKey);
        }
        this.forgeActedMessages.add(`failed-${msg.id}`);
      }

      // Case 5: Pending approval too long (>5min) → log reminder
      if (msg.status === 'pending_approval') {
        const age = now - msg.timestamp;
        if (age > 300_000 && !this.forgeActedMessages.has(`approval-${msg.id}`)) {
          const targetLabel = this.agents.get(msg.to)?.config.label || msg.to;
          this.emit('event', { type: 'log', agentId: msg.to, entry: { type: 'system', subtype: 'warning', content: `Message awaiting approval for ${Math.round(age / 60000)}min — requires manual action`, timestamp: new Date().toISOString() } } as any);
          this.forgeActedMessages.add(`approval-${msg.id}`);
        }
      }
    }
  }

  /** Handle watch alert based on agent's configured action */
  private handleWatchAlert(agentId: string, summary: string): void {
    const entry = this.agents.get(agentId);
    if (!entry) return;
    const action = entry.config.watch?.action || 'log';

    if (action === 'log') {
      // Already logged by watch-manager, nothing more to do
      return;
    }

    if (action === 'analyze') {
      // Auto-wake agent to analyze changes (skip if busy/manual)
      if (entry.state.taskStatus === 'running') {
        console.log(`[watch] ${entry.config.label}: skipped analyze (task=${entry.state.taskStatus})`);
        return;
      }
      if (!entry.worker?.isListening()) {
        console.log(`[watch] ${entry.config.label}: skipped analyze (worker=${!!entry.worker} listening=${entry.worker?.isListening()})`);
        return;
      }
      console.log(`[watch] ${entry.config.label}: triggering analyze`);

      const prompt = entry.config.watch?.prompt || 'Analyze the following changes and produce a report:';
      const logEntry = {
        type: 'system' as const,
        subtype: 'watch_trigger',
        content: `[Watch] ${prompt}\n\n${summary}`,
        timestamp: new Date().toISOString(),
      };
      entry.worker.wake({ type: 'bus_message', messages: [logEntry] });
      console.log(`[watch] ${entry.config.label}: auto-analyzing detected changes`);
      return;
    }

    if (action === 'approve') {
      // Create message with pending_approval status — user must approve to execute
      const msg = this.bus.send('_watch', agentId, 'notify', {
        action: 'watch_changes',
        content: `Watch detected changes (awaiting approval):\n${summary}`,
      });
      msg.status = 'pending_approval';
      this.emit('event', { type: 'bus_message_status', messageId: msg.id, status: 'pending_approval' } as any);
      console.log(`[watch] ${entry.config.label}: changes detected, awaiting approval`);
    }

    if (action === 'send_message') {
      const targetId = entry.config.watch?.sendTo;
      if (!targetId) {
        console.log(`[watch] ${entry.config.label}: send_message but no sendTo configured`);
        return;
      }
      const targetEntry = this.agents.get(targetId);
      if (!targetEntry) {
        console.log(`[watch] ${entry.config.label}: sendTo agent ${targetId} not found`);
        return;
      }

      const prompt = entry.config.watch?.prompt;
      // For terminal injection: send the configured prompt directly (pattern is the trigger, not the payload)
      // If no prompt configured, send the summary
      const message = prompt || summary;

      // Try to inject directly into an open terminal session
      // Verify stored session is alive, clear if dead
      if (targetEntry.state.tmuxSession) {
        try { execSync(`tmux has-session -t "${targetEntry.state.tmuxSession}" 2>/dev/null`, { timeout: 3000 }); }
        catch { targetEntry.state.tmuxSession = undefined; }
      }
      const tmuxSession = targetEntry.state.tmuxSession || this.findTmuxSession(targetEntry.config.label);
      if (tmuxSession) {
        try {
          const tmpFile = `/tmp/forge-watch-${Date.now()}.txt`;
          writeFileSync(tmpFile, message);
          execSync(`tmux load-buffer ${tmpFile}`, { timeout: 5000 });
          execSync(`tmux paste-buffer -t "${tmuxSession}" && sleep 0.2 && tmux send-keys -t "${tmuxSession}" Enter`, { timeout: 5000 });
          try { unlinkSync(tmpFile); } catch {}
          console.log(`[watch] ${entry.config.label} → ${targetEntry.config.label}: injected into terminal (${tmuxSession})`);
        } catch (err: any) {
          console.error(`[watch] Terminal inject failed: ${err.message}, falling back to bus`);
          this.bus.send(agentId, targetId, 'notify', { action: 'watch_alert', content: message });
        }
        return;
      }

      // No terminal open — send via bus (will start new session)
      const hasPendingFromWatch = this.bus.getLog().some(m =>
        m.from === agentId && m.to === targetId &&
        (m.status === 'pending' || m.status === 'running' || m.status === 'pending_approval') &&
        m.type !== 'ack'
      );
      if (hasPendingFromWatch) {
        console.log(`[watch] ${entry.config.label}: skipping bus send — target still processing`);
        return;
      }

      this.bus.send(agentId, targetId, 'notify', { action: 'watch_alert', content: message });
      console.log(`[watch] ${entry.config.label} → ${targetEntry.config.label}: sent via bus`);
    }
  }

  /** Check if daemon mode is active */
  isDaemonActive(): boolean {
    return this.daemonActive;
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
  /** Mark agent task as done (user manually confirms completion) */
  markAgentDone(agentId: string, notify: boolean): void {
    const entry = this.agents.get(agentId);
    if (!entry) return;

    // Mark running inbox messages as done
    const runningMsgs = this.bus.getLog().filter(m => m.to === agentId && m.status === 'running' && m.type !== 'ack');
    for (const m of runningMsgs) {
      m.status = 'done' as any;
      this.emit('event', { type: 'bus_message_status', messageId: m.id, status: 'done' } as any);
    }

    entry.state.taskStatus = notify ? 'done' : 'idle';
    entry.state.completedAt = Date.now();
    this.emit('event', { type: 'task_status', agentId, taskStatus: entry.state.taskStatus } as any);
    if (notify) {
      this.handleAgentDone(agentId, entry, 'Manually marked done');
    }
    this.sessionMonitor?.resetState(agentId);
    this.saveNow();
    this.emitAgentsChanged();
    console.log(`[workspace] ${entry.config.label}: manually marked ${notify ? 'done' : 'idle'} (${runningMsgs.length} messages completed)`);
  }

  /** Mark agent task as failed (user manually marks failure) */
  markAgentFailed(agentId: string, notify: boolean): void {
    const entry = this.agents.get(agentId);
    if (!entry) return;

    // Mark running inbox messages as failed
    const runningMsgs = this.bus.getLog().filter(m => m.to === agentId && m.status === 'running' && m.type !== 'ack');
    for (const m of runningMsgs) {
      m.status = 'failed' as any;
      this.emit('event', { type: 'bus_message_status', messageId: m.id, status: 'failed' } as any);
    }

    entry.state.taskStatus = 'failed';
    entry.state.error = 'Manually marked as failed';
    this.emit('event', { type: 'task_status', agentId, taskStatus: 'failed' } as any);
    if (notify) {
      this.bus.notifyTaskComplete(agentId, [], 'Task failed');
    }
    this.sessionMonitor?.resetState(agentId);
    this.saveNow();
    this.emitAgentsChanged();
    console.log(`[workspace] ${entry.config.label}: manually marked failed (${runningMsgs.length} messages failed)`);
  }

  /** Legacy stop — for headless mode */
  stopAgent(agentId: string): void {
    const entry = this.agents.get(agentId);
    if (!entry) return;
    if (entry.config.persistentSession) {
      this.markAgentDone(agentId, false);
    } else {
      entry.worker?.stop();
    }
  }

  /** Retry a failed agent from its last checkpoint */
  async retryAgent(agentId: string): Promise<void> {
    const entry = this.agents.get(agentId);
    if (!entry) throw new Error(`Agent "${agentId}" not found`);
    if (entry.state.taskStatus === 'running') {
      throw new Error(`Agent "${entry.config.label}" is already running`);
    }
    if (entry.state.taskStatus !== 'failed') {
      throw new Error(`Agent "${entry.config.label}" is ${entry.state.taskStatus}, not failed`);
    }
    // force=true: skip dep taskStatus check, only require upstream smith active
    await this.runAgent(agentId, undefined, true);
  }

  /** Send a message to a running agent (human intervention) */
  /** Send a message to a smith — becomes a pending inbox message, processed by message loop */
  sendMessageToAgent(agentId: string, content: string): void {
    const entry = this.agents.get(agentId);
    if (!entry) return;

    // Send via bus → becomes pending inbox message → message loop will consume it
    this.bus.send('user', agentId, 'notify', {
      action: 'user_message',
      content,
    });
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

  clearTmuxSession(agentId: string): void {
    const entry = this.agents.get(agentId);
    if (!entry) return;
    entry.state.tmuxSession = undefined;
    this.saveNow();
    this.emitAgentsChanged();
  }

  /** Record that an agent has an open terminal (tmux session tracking) */
  setManualMode(agentId: string): void {
    const entry = this.agents.get(agentId);
    if (!entry) return;
    // tmuxSession is set separately when terminal opens
    this.emitAgentsChanged();
    this.saveNow();
    console.log(`[workspace] Agent "${entry.config.label}" terminal opened`);
  }

  /** Called when agent's terminal is closed */
  restartAgentDaemon(agentId: string): void {
    if (!this.daemonActive) return;
    const entry = this.agents.get(agentId);
    if (!entry || entry.config.type === 'input') return;

    entry.state.error = undefined;
    // Don't clear tmuxSession here — it may still be alive (persistent session)
    // Terminal close just means the UI panel is closed, not necessarily tmux killed

    // Recreate worker if needed
    if (!entry.worker) {
      this.enterDaemonListening(agentId);
      this.startMessageLoop(agentId);
    }

    entry.state.smithStatus = 'active';
    this.emit('event', { type: 'smith_status', agentId, smithStatus: 'active' } satisfies WorkerEvent);
    this.emitAgentsChanged();
  }

  /** Complete an agent from terminal — called by forge-done skill */
  completeManualAgent(agentId: string, changedFiles: string[]): void {
    const entry = this.agents.get(agentId);
    if (!entry) return;

    entry.state.taskStatus = 'done';
    entry.state.completedAt = Date.now();
    entry.state.artifacts = changedFiles.map(f => ({ type: 'file' as const, path: f }));

    console.log(`[workspace] Manual agent "${entry.config.label}" marked done. ${changedFiles.length} files changed.`);

    this.emit('event', { type: 'task_status', agentId, taskStatus: 'done' } satisfies WorkerEvent);
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

    if (this.daemonActive) {
      this.broadcastCompletion(agentId);
    }
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
      entry.state.taskStatus = 'idle';
      this.emit('event', { type: 'task_status', agentId, taskStatus: 'idle' } satisfies WorkerEvent);
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
    daemonActive: boolean;
  } {
    return {
      agents: Array.from(this.agents.values()).map(e => e.config),
      agentStates: this.getAllAgentStates(),
      busLog: [...this.bus.getLog()],
      daemonActive: this.daemonActive,
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
    this.daemonActive = false; // Reset daemon — user must click Start Daemon again after restart
    for (const config of data.agents) {
      const state = data.agentStates[config.id] || { smithStatus: 'down' as const, taskStatus: 'idle' as const, history: [], artifacts: [] };

      // Migrate old format if loading from pre-two-layer state
      if ('status' in state && !('smithStatus' in state)) {
        const oldStatus = (state as any).status;
        (state as any).smithStatus = 'down';
        (state as any).taskStatus = (oldStatus === 'running' || oldStatus === 'listening') ? 'idle' :
                       (oldStatus === 'interrupted') ? 'idle' :
                       (oldStatus === 'waiting_approval') ? 'idle' :
                       (oldStatus === 'paused') ? 'idle' :
                       oldStatus;
        delete (state as any).status;
        delete (state as any).runMode;
        delete (state as any).daemonMode;
      }

      // Mark running agents as failed (interrupted by restart)
      if (state.taskStatus === 'running') {
        state.taskStatus = 'failed';
        state.error = 'Interrupted by restart';
      }
      // Smith is down after restart (no daemon loop running)
      state.smithStatus = 'down';
      state.daemonIteration = undefined;
      this.agents.set(config.id, { config, worker: null, state });
    }
    this.bus.loadLog(data.busLog);
    if (data.busOutbox) {
      this.bus.loadOutbox(data.busOutbox);
    }

    // Mark all pending messages as failed (they were lost on shutdown)
    // Users can retry agents manually if needed
    // Running messages from before crash → failed (pending stays pending for retry)
    this.bus.markAllRunningAsFailed();

    // Initialize liveness for all loaded agents so bus delivery works
    for (const [agentId] of this.agents) {
      this.updateAgentLiveness(agentId);
    }
  }

  /** Stop all agents, save final state, and clean up */
  shutdown(): void {
    this.stopAllMessageLoops();
    stopAutoSave(this.workspaceId);
    // Sync save — must complete before process exits
    try { saveWorkspaceSync(this.getFullState()); } catch (err) {
      console.error(`[workspace] Failed to save on shutdown:`, err);
    }
    for (const [, entry] of this.agents) {
      entry.worker?.stop();
    }
    this.bus.clear();
  }

  // ─── Private ───────────────────────────────────────────

  private createBackend(config: WorkspaceAgentConfig, agentId?: string) {
    switch (config.backend) {
      case 'api':
        // TODO: ApiBackend uses @/src path aliases that don't work in standalone tsx.
        // Need to refactor api-backend imports before enabling.
        throw new Error('API backend not yet supported in workspace daemon. Use CLI backend instead.');
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
      if (!dep || (dep.state.taskStatus !== 'done')) continue;

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
  /**
   * Broadcast completion to all downstream agents via bus messages.
   * Replaces direct triggerDownstream — all execution is now message-driven.
   * If no artifacts/changes, no message is sent → downstream stays idle.
   */
  /** Build causedBy from the message currently being processed */
  private buildCausedBy(agentId: string, entry: { worker: AgentWorker | null }): BusMessage['causedBy'] | undefined {
    const msgId = entry.worker?.getCurrentMessageId?.();
    if (!msgId) return undefined;
    const msg = this.bus.getLog().find(m => m.id === msgId);
    if (!msg) return undefined;
    return { messageId: msg.id, from: msg.from, to: msg.to };
  }

  /** Unified done handler: broadcast downstream or reply to sender based on message source */
  private handleAgentDone(agentId: string, entry: { config: WorkspaceAgentConfig; worker: AgentWorker | null; state: AgentState }, summary?: string): void {
    const files = entry.state.artifacts.filter(a => a.path).map(a => a.path!);
    console.log(`[workspace] Agent "${entry.config.label}" (${agentId}) completed. Artifacts: ${files.length}.`);

    this.bus.notifyTaskComplete(agentId, files, summary);

    // Check what message triggered this execution
    const causedBy = this.buildCausedBy(agentId, entry);
    const processedMsg = causedBy ? this.bus.getLog().find(m => m.id === causedBy.messageId) : null;

    this.broadcastCompletion(agentId, causedBy);
    // Note: Forge agent (runForgeAgentCheck) monitors for missing replies
    // and nudges agents to send summaries. No action needed here.

    this.emitWorkspaceStatus();
    this.checkWorkspaceComplete?.();
  }

  private broadcastCompletion(completedAgentId: string, causedBy?: BusMessage['causedBy']): void {
    const completed = this.agents.get(completedAgentId);
    if (!completed) return;

    const completedLabel = completed.config.label;
    const files = completed.state.artifacts.filter(a => a.path).map(a => a.path!);
    const summary = completed.state.history
      .filter(h => h.subtype === 'final_summary' || h.subtype === 'step_summary')
      .slice(-1)[0]?.content || '';

    const content = files.length > 0
      ? `${completedLabel} completed: ${files.length} files changed. ${summary.slice(0, 200)}. If you are currently processing a task or have seen this before, ignore this notification.`
      : `${completedLabel} completed. ${summary.slice(0, 300) || 'If you are currently processing a task or have seen this before, ignore this notification.'}`;

    // Find all downstream agents — skip if already sent upstream_complete recently (60s)
    const now = Date.now();
    let sent = 0;
    for (const [id, entry] of this.agents) {
      if (id === completedAgentId) continue;
      if (entry.config.type === 'input') continue;
      if (!entry.config.dependsOn.includes(completedAgentId)) continue;

      // Dedup: skip if upstream_complete was sent to this target within last 60s
      const recentDup = this.bus.getLog().some(m =>
        m.from === completedAgentId && m.to === id &&
        m.payload?.action === 'upstream_complete' &&
        now - m.timestamp < 60_000
      );
      if (recentDup) {
        console.log(`[bus] ${completedLabel} → ${entry.config.label}: upstream_complete skipped (sent <60s ago)`);
        continue;
      }

      // Merge: auto-complete older pending upstream_complete from same sender
      for (const m of this.bus.getLog()) {
        if (m.from === completedAgentId && m.to === id && m.status === 'pending' && m.payload?.action === 'upstream_complete') {
          m.status = 'done' as any;
          this.emit('event', { type: 'bus_message_status', messageId: m.id, status: 'done' } as any);
        }
      }

      this.bus.send(completedAgentId, id, 'notify', {
        action: 'upstream_complete',
        content,
        files,
      }, { category: 'notification', causedBy });
      sent++;
      console.log(`[bus] ${completedLabel} → ${entry.config.label}: upstream_complete (${files.length} files)`);
    }

    if (sent === 0) {
      console.log(`[bus] ${completedLabel} completed — no downstream agents`);
    }
  }

  // ─── Agent liveness ─────────────────────────────────────

  /** Find an active tmux session for an agent by checking naming conventions */
  // ─── Persistent Terminal Sessions ────────────────────────

  /** Resolve the CLI session directory for a given project path */
  private getCliSessionDir(workDir?: string): string {
    const projectPath = workDir && workDir !== './' && workDir !== '.'
      ? join(this.projectPath, workDir) : this.projectPath;
    const encoded = resolve(projectPath).replace(/\//g, '-');
    return join(homedir(), '.claude', 'projects', encoded);
  }

  /** Create a persistent tmux session with the CLI agent */
  private async ensurePersistentSession(agentId: string, config: WorkspaceAgentConfig): Promise<void> {
    const safeName = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').slice(0, 20);
    const sessionName = `mw-forge-${safeName(this.projectName)}-${safeName(config.label)}`;

    // Pre-flight: check project's .claude/settings.json is valid
    const workDir = config.workDir && config.workDir !== './' && config.workDir !== '.'
      ? `${this.projectPath}/${config.workDir}` : this.projectPath;
    const projectSettingsFile = join(workDir, '.claude', 'settings.json');
    if (existsSync(projectSettingsFile)) {
      try {
        const raw = readFileSync(projectSettingsFile, 'utf-8');
        JSON.parse(raw);
      } catch (err: any) {
        const errorMsg = `Invalid .claude/settings.json: ${err.message}`;
        console.error(`[daemon] ${config.label}: ${errorMsg}`);
        const entry = this.agents.get(agentId);
        if (entry) {
          entry.state.error = errorMsg;
          entry.state.smithStatus = 'down';
          this.emit('event', { type: 'smith_status', agentId, smithStatus: 'down' } as any);
          this.emit('event', { type: 'log', agentId, entry: { type: 'system', subtype: 'error', content: `⚠️ ${errorMsg}`, timestamp: new Date().toISOString() } } as any);
          this.emitAgentsChanged();
        }
        return;
      }
    }

    // Write agent context file for hooks to read (workDir/.forge/agent-context.json)
    try {
      const forgeDir = join(workDir, '.forge');
      const { mkdirSync: mkdirS } = require('node:fs');
      mkdirS(forgeDir, { recursive: true });
      const ctxPath = join(forgeDir, 'agent-context.json');
      writeFileSync(ctxPath, JSON.stringify({
        workspaceId: this.workspaceId,
        agentId: config.id,
        agentLabel: config.label,
        forgePort: Number(process.env.PORT) || 8403,
      }, null, 2));
      console.log(`[daemon] ${config.label}: wrote agent-context.json to ${ctxPath}`);
    } catch (err: any) {
      console.error(`[daemon] ${config.label}: failed to write agent-context.json: ${err.message}`);
    }

    // Check if tmux session already exists
    let sessionAlreadyExists = false;
    try {
      execSync(`tmux has-session -t "${sessionName}" 2>/dev/null`, { timeout: 3000 });
      sessionAlreadyExists = true;
      console.log(`[daemon] ${config.label}: persistent session already exists (${sessionName})`);
      // Ensure FORGE env vars are set in the tmux session environment
      // (for hooks that read them — set-environment makes them available to new processes in this session)
      try {
        execSync(`tmux set-environment -t "${sessionName}" FORGE_WORKSPACE_ID "${this.workspaceId}"`, { timeout: 3000 });
        execSync(`tmux set-environment -t "${sessionName}" FORGE_AGENT_ID "${config.id}"`, { timeout: 3000 });
        execSync(`tmux set-environment -t "${sessionName}" FORGE_PORT "${Number(process.env.PORT) || 8403}"`, { timeout: 3000 });
      } catch {}
      // Note: set-environment affects new processes in this tmux session.
      // Claude Code hooks run as child processes of the shell, which inherits tmux environment.
    } catch {
      // Create new tmux session and start the CLI agent
      try {
        // Resolve agent launch info
        let cliCmd = 'claude';
        let cliType = 'claude-code';
        let supportsSession = true;
        let skipPermissionsFlag = '--dangerously-skip-permissions';
        let envExports = '';
        let modelFlag = '';
        try {
          const { resolveTerminalLaunch, listAgents } = await import('../agents/index') as any;
          const info = resolveTerminalLaunch(config.agentId);
          cliCmd = info.cliCmd || 'claude';
          cliType = info.cliType || 'claude-code';
          supportsSession = info.supportsSession ?? true;
          const agents = listAgents();
          const agentDef = agents.find((a: any) => a.id === config.agentId);
          if (agentDef?.skipPermissionsFlag) skipPermissionsFlag = agentDef.skipPermissionsFlag;
          if (info.env) {
            envExports = Object.entries(info.env)
              .filter(([k]) => k !== 'CLAUDE_MODEL')
              .map(([k, v]) => `export ${k}="${v}"`)
              .join(' && ');
            if (envExports) envExports += ' && ';
          }
          if (info.model) modelFlag = ` --model ${info.model}`;
        } catch {}

        // Generate MCP config for Claude Code agents
        let mcpConfigFlag = '';
        if (cliType === 'claude-code') {
          try {
            const mcpPort = Number(process.env.MCP_PORT) || 8406;
            const mcpConfigPath = join(workDir, '.forge', 'mcp.json');
            const mcpConfig = {
              mcpServers: {
                forge: {
                  type: 'sse',
                  url: `http://localhost:${mcpPort}/sse?workspaceId=${this.workspaceId}&agentId=${config.id}`,
                },
              },
            };
            const { mkdirSync: mkdirS } = await import('node:fs');
            mkdirS(join(workDir, '.forge'), { recursive: true });
            writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2));
            mcpConfigFlag = ` --mcp-config "${mcpConfigPath}"`;
          } catch (err: any) {
            console.log(`[daemon] ${config.label}: MCP config generation failed: ${err.message}`);
          }
        }

        execSync(`tmux new-session -d -s "${sessionName}" -c "${workDir}"`, { timeout: 5000 });

        // Build launch script to avoid tmux send-keys truncation
        const scriptLines: string[] = ['#!/bin/bash', `cd "${workDir}"`];

        // Unset old profile vars
        scriptLines.push('unset ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL ANTHROPIC_SMALL_FAST_MODEL CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC DISABLE_TELEMETRY DISABLE_ERROR_REPORTING DISABLE_AUTOUPDATER DISABLE_NON_ESSENTIAL_MODEL_CALLS CLAUDE_MODEL');

        // Set FORGE env vars
        scriptLines.push(`export FORGE_WORKSPACE_ID="${this.workspaceId}" FORGE_AGENT_ID="${config.id}" FORGE_PORT="${Number(process.env.PORT) || 8403}"`);

        // Set profile env vars
        if (envExports) {
          scriptLines.push(envExports.replace(/ && /g, '\n').replace(/\n$/, ''));
        }

        // Build CLI command
        let cmd = cliCmd;
        if (supportsSession) {
          let sessionId: string | undefined;
          if (config.primary) {
            // Read fixedSessionId directly from file (avoid dynamic import issues in production build)
            try {
              const psPath = join(homedir(), '.forge', 'data', 'project-sessions.json');
              if (existsSync(psPath)) {
                const psData = JSON.parse(readFileSync(psPath, 'utf-8'));
                sessionId = psData[this.projectPath];
              }
              console.log(`[daemon] ${config.label}: fixedSession=${sessionId || 'NONE'} for ${this.projectPath}`);
            } catch (err: any) {
              console.error(`[daemon] ${config.label}: failed to read fixedSession: ${err.message}`);
            }
          } else {
            sessionId = config.boundSessionId;
          }
          if (sessionId) {
            const sessionFile = join(this.getCliSessionDir(config.workDir), `${sessionId}.jsonl`);
            if (existsSync(sessionFile)) {
              cmd += ` --resume ${sessionId}`;
            } else {
              console.log(`[daemon] ${config.label}: bound session ${sessionId} missing, starting fresh`);
            }
          }
        }
        if (modelFlag) cmd += modelFlag;
        if (config.skipPermissions !== false && skipPermissionsFlag) cmd += ` ${skipPermissionsFlag}`;
        if (mcpConfigFlag) cmd += mcpConfigFlag;
        scriptLines.push(`exec ${cmd}`);

        // Write script and execute in tmux
        const scriptPath = `/tmp/forge-launch-${config.id.replace(/[^a-z0-9-]/g, '')}.sh`;
        writeFileSync(scriptPath, scriptLines.join('\n'), { mode: 0o755 });
        execSync(`tmux send-keys -t "${sessionName}" 'bash ${scriptPath}' Enter`, { timeout: 5000 });

        console.log(`[daemon] ${config.label}: persistent session created (${sessionName}) [${cliType}: ${cliCmd}]`);

        // Verify CLI started successfully (check after 3s if process is still alive)
        await new Promise(resolve => setTimeout(resolve, 3000));
        try {
          const paneContent = execSync(`tmux capture-pane -t "${sessionName}" -p -S -20`, { timeout: 3000, encoding: 'utf-8' });
          // Check for common startup errors
          const errorPatterns = [
            /error.*settings\.json/i,
            /invalid.*json/i,
            /SyntaxError/i,
            /ENOENT.*settings/i,
            /failed to parse/i,
            /could not read/i,
            /fatal/i,
            /No conversation found/i,
            /could not connect/i,
            /ECONNREFUSED/i,
          ];
          const hasError = errorPatterns.some(p => p.test(paneContent));
          if (hasError) {
            const errorLines = paneContent.split('\n').filter(l => /error|invalid|syntax|fatal|failed|No conversation|ECONNREFUSED/i.test(l)).slice(0, 3);
            const errorMsg = errorLines.join(' ').slice(0, 200) || 'CLI failed to start (check project settings)';
            console.error(`[daemon] ${config.label}: CLI startup error detected: ${errorMsg}`);

            const entry = this.agents.get(agentId);
            if (entry) {
              entry.state.error = `Terminal failed: ${errorMsg}. Falling back to headless mode.`;
              entry.state.tmuxSession = undefined; // clear so message loop uses headless (claude -p)
              this.emit('event', { type: 'log', agentId, entry: { type: 'system', subtype: 'error', content: `Terminal startup failed: ${errorMsg}. Auto-fallback to headless.`, timestamp: new Date().toISOString() } } as any);
              this.emitAgentsChanged();
            }
            // Kill the failed tmux session
            try { execSync(`tmux kill-session -t "${sessionName}" 2>/dev/null`, { timeout: 3000 }); } catch {}
            return;
          }
        } catch {}
        // Auto-bind session: if no boundSessionId, detect new session file after 5s
        if (!config.primary && !config.boundSessionId && supportsSession) {
          setTimeout(() => {
            try {
              const sessionDir = this.getCliSessionDir(config.workDir);
              if (existsSync(sessionDir)) {
                const { readdirSync, statSync: statS } = require('node:fs');
                const files = readdirSync(sessionDir).filter((f: string) => f.endsWith('.jsonl'));
                if (files.length > 0) {
                  const latest = files
                    .map((f: string) => ({ name: f, mtime: statS(join(sessionDir, f)).mtimeMs }))
                    .sort((a: any, b: any) => b.mtime - a.mtime)[0];
                  config.boundSessionId = latest.name.replace('.jsonl', '');
                  this.saveNow();
                  console.log(`[daemon] ${config.label}: auto-bound to session ${config.boundSessionId}`);
                }
              }
            } catch {}
          }, 5000);
        }
      } catch (err: any) {
        console.error(`[daemon] ${config.label}: failed to create persistent session: ${err.message}`);
        const entry = this.agents.get(agentId);
        if (entry) {
          entry.state.error = `Failed to create terminal: ${err.message}`;
          entry.state.smithStatus = 'down';
          this.emit('event', { type: 'smith_status', agentId, smithStatus: 'down' } as any);
          this.emitAgentsChanged();
        }
        return;
      }
    }

    // Store tmux session name in agent state
    const entry = this.agents.get(agentId);
    if (entry) {
      entry.state.tmuxSession = sessionName;
      this.saveNow();
      this.emitAgentsChanged();
    }

    // Ensure boundSessionId is set (required for session monitor + --resume)
    if (!config.primary && !config.boundSessionId) {
      const bindDelay = sessionAlreadyExists ? 500 : 5000;
      setTimeout(() => {
        try {
          const sessionDir = this.getCliSessionDir(config.workDir);
          if (existsSync(sessionDir)) {
            const { readdirSync, statSync: statS } = require('node:fs');
            const files = readdirSync(sessionDir).filter((f: string) => f.endsWith('.jsonl'));
            if (files.length > 0) {
              const latest = files
                .map((f: string) => ({ name: f, mtime: statS(join(sessionDir, f)).mtimeMs }))
                .sort((a: any, b: any) => b.mtime - a.mtime)[0];
              config.boundSessionId = latest.name.replace('.jsonl', '');
              this.saveNow();
              console.log(`[daemon] ${config.label}: bound to session ${config.boundSessionId}`);
              this.startAgentSessionMonitor(agentId, config);
            } else {
              console.log(`[daemon] ${config.label}: no session files yet, will bind on next check`);
            }
          }
        } catch {}
      }, bindDelay);
    }
  }

  /** Inject text into an agent's persistent terminal session */
  injectIntoSession(agentId: string, text: string): boolean {
    const entry = this.agents.get(agentId);
    // Verify stored session is alive
    if (entry?.state.tmuxSession) {
      try { execSync(`tmux has-session -t "${entry.state.tmuxSession}" 2>/dev/null`, { timeout: 3000 }); }
      catch { entry.state.tmuxSession = undefined; }
    }
    const tmuxSession = entry?.state.tmuxSession || this.findTmuxSession(entry?.config.label || '');
    if (!tmuxSession) return false;
    // Cache found session for future use
    if (entry && !entry.state.tmuxSession) entry.state.tmuxSession = tmuxSession;

    try {
      const tmpFile = `/tmp/forge-inject-${Date.now()}.txt`;
      writeFileSync(tmpFile, text);
      execSync(`tmux load-buffer ${tmpFile}`, { timeout: 5000 });
      execSync(`tmux paste-buffer -t "${tmuxSession}"`, { timeout: 5000 });
      execSync(`tmux send-keys -t "${tmuxSession}" Enter`, { timeout: 5000 });
      try { unlinkSync(tmpFile); } catch {}
      return true;
    } catch (err: any) {
      console.error(`[inject] Failed for ${tmuxSession}: ${err.message}`);
      return false;
    }
  }

  /** Check if agent has a persistent session available */
  hasPersistentSession(agentId: string): boolean {
    const entry = this.agents.get(agentId);
    if (!entry) return false;
    if (entry.state.tmuxSession) return true;
    return !!this.findTmuxSession(entry.config.label);
  }

  private findTmuxSession(agentLabel: string): string | null {
    const safeName = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').slice(0, 20);
    const projectSafe = safeName(this.projectName);
    const agentSafe = safeName(agentLabel);

    // Try workspace naming: mw-forge-{project}-{agent}
    const wsName = `mw-forge-${projectSafe}-${agentSafe}`;
    try { execSync(`tmux has-session -t "${wsName}" 2>/dev/null`, { timeout: 3000 }); return wsName; } catch {}

    // Try VibeCoding naming: mw-{project}
    const vcName = `mw-${projectSafe}`;
    try { execSync(`tmux has-session -t "${vcName}" 2>/dev/null`, { timeout: 3000 }); return vcName; } catch {}

    // Search terminal-state.json for project matching tmux session
    try {
      const statePath = join(homedir(), '.forge', 'data', 'terminal-state.json');
      if (existsSync(statePath)) {
        const termState = JSON.parse(readFileSync(statePath, 'utf-8'));
        for (const tab of termState.tabs || []) {
          if (tab.projectPath === this.projectPath) {
            const findSession = (tree: any): string | null => {
              if (tree?.type === 'terminal' && tree.sessionName) return tree.sessionName;
              for (const child of tree?.children || []) {
                const found = findSession(child);
                if (found) return found;
              }
              return null;
            };
            const sess = findSession(tab.tree);
            if (sess) {
              try { execSync(`tmux has-session -t "${sess}" 2>/dev/null`, { timeout: 3000 }); return sess; } catch {}
            }
          }
        }
      }
    } catch {}

    return null;
  }

  private updateAgentLiveness(agentId: string): void {
    const entry = this.agents.get(agentId);
    if (!entry) {
      this.bus.setAgentStatus(agentId, 'down');
      return;
    }
    if (entry.state.taskStatus === 'running') this.bus.setAgentStatus(agentId, 'busy');
    else if (entry.state.smithStatus === 'active') this.bus.setAgentStatus(agentId, 'alive');
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

    // Helper: mark message as processed when actually consumed
    const ackAndDeliver = () => {
      msg.status = 'done';
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

    // ── Store message in agent history ──
    target.state.history.push(logEntry);

    // ── requiresApproval → set pending_approval on arrival ──
    if (target.config.requiresApproval) {
      msg.status = 'pending_approval';
      this.emit('event', { type: 'bus_message_status', messageId: msg.id, status: 'pending_approval' } as any);
      console.log(`[bus] ${target.config.label}: received ${action} — pending approval`);
      return;
    }

    // ── Message stays pending — message loop will consume it when smith is ready ──
    console.log(`[bus] ${target.config.label}: received ${action} — queued in inbox (${msg.status})`);
  }

  // ─── Message consumption loop ─────────────────────────
  private messageLoopTimers = new Map<string, NodeJS.Timeout>();

  /** Start the message consumption loop for a smith */
  private startMessageLoop(agentId: string): void {
    if (this.messageLoopTimers.has(agentId)) return; // already running

    let debugTick = 0;
    const tick = () => {
      const entry = this.agents.get(agentId);
      if (!entry) {
        this.stopMessageLoop(agentId);
        return;
      }

      // Don't stop loop if smith is down — just skip this tick
      // (loop stays alive so it works when smith comes back)
      if (entry.state.smithStatus !== 'active') return;

      // Skip if already busy
      if (entry.state.taskStatus === 'running') return;

      // Skip if any message is already running for this agent
      const hasRunning = this.bus.getLog().some(m => m.to === agentId && m.status === 'running' && m.type !== 'ack');
      if (hasRunning) return;

      // Execution path determined by config, not runtime tmux state
      const isTerminalMode = entry.config.persistentSession;
      if (isTerminalMode) {
        // Terminal mode: need tmux session. If missing, skip this tick (health check will restart it)
        if (!entry.state.tmuxSession) {
          if (++debugTick % 15 === 0) {
            console.log(`[inbox] ${entry.config.label}: terminal mode but no tmux session — waiting for auto-restart`);
          }
          return;
        }
      } else {
        // Headless mode: need worker ready
        if (!entry.worker) {
          if (this.daemonActive) {
            console.log(`[inbox] ${entry.config.label}: no worker, recreating...`);
            this.enterDaemonListening(agentId);
          }
          return;
        }
        if (!entry.worker.isListening()) {
          if (++debugTick % 15 === 0) {
            console.log(`[inbox] ${entry.config.label}: not listening (smith=${entry.state.smithStatus} task=${entry.state.taskStatus})`);
          }
          return;
        }
      }

      // requiresApproval is handled at message arrival time (routeMessageToAgent),
      // not in the message loop. Approved messages come through as normal 'pending'.

      // Dedup: if multiple upstream_complete from same sender are pending, keep only latest
      const allRaw = this.bus.getPendingMessagesFor(agentId).filter(m => m.from !== agentId && m.type !== 'ack');
      const upstreamSeen = new Set<string>();
      for (let i = allRaw.length - 1; i >= 0; i--) {
        const m = allRaw[i];
        if (m.payload?.action === 'upstream_complete') {
          const key = `upstream-${m.from}`;
          if (upstreamSeen.has(key)) {
            m.status = 'done' as any;
            this.emit('event', { type: 'bus_message_status', messageId: m.id, status: 'done' } as any);
          }
          upstreamSeen.add(key);
        }
      }

      // Find next pending message, applying causedBy rules
      const allPending = allRaw.filter(m => m.status === 'pending');
      const pending = allPending.filter(m => {
        // Tickets: accepted but check retry limit
        if (m.category === 'ticket') {
          const maxRetries = m.maxRetries ?? 3;
          if ((m.ticketRetries || 0) >= maxRetries) {
            console.log(`[inbox] ${entry.config.label}: ticket ${m.id.slice(0, 8)} exceeded max retries (${maxRetries}), marking failed`);
            m.status = 'failed' as any;
            m.ticketStatus = 'closed';
            this.emit('event', { type: 'bus_message_status', messageId: m.id, status: 'failed' } as any);
            return false;
          }
          return true;
        }

        // System messages (from _watch, _system, user) bypass causedBy rules
        if (m.from.startsWith('_') || m.from === 'user') return true;

        // Notifications: check causedBy for loop prevention
        if (m.causedBy) {
          // Rule 1: Is this a response to something I sent? → accept (for verification)
          const myOutbox = this.bus.getOutboxFor(agentId);
          if (myOutbox.some(o => o.id === m.causedBy!.messageId)) return true;

          // Rule 2: Notification from downstream → discard (prevents reverse flow)
          if (!this.isUpstream(m.from, agentId)) {
            console.log(`[inbox] ${entry.config.label}: discarding notification from downstream ${this.agents.get(m.from)?.config.label || m.from}`);
            m.status = 'done' as any; // silently consume
            return false;
          }
        }

        // Default: accept (upstream notifications, no causedBy = initial trigger)
        return true;
      });
      if (pending.length === 0) return;

      const nextMsg = pending[0];
      const fromLabel = this.agents.get(nextMsg.from)?.config.label || nextMsg.from;
      console.log(`[inbox] ${entry.config.label}: consuming message from ${fromLabel} (${nextMsg.payload.action})`);

      // Mark message as running (being processed)
      nextMsg.status = 'running' as any;
      this.emit('event', { type: 'bus_message_status', messageId: nextMsg.id, status: 'running' } as any);

      const logEntry = {
        type: 'system' as const,
        subtype: 'bus_message',
        content: `[From ${fromLabel}]: ${nextMsg.payload.content || nextMsg.payload.action}`,
        timestamp: new Date(nextMsg.timestamp).toISOString(),
      };

      // Terminal mode → inject; headless → worker (claude -p)
      if (isTerminalMode) {
        const injected = this.injectIntoSession(agentId, nextMsg.payload.content || nextMsg.payload.action);
        if (injected) {
          this.emit('event', { type: 'log', agentId, entry: { type: 'system', subtype: 'execution_method', content: '📺 Injected into terminal, monitoring for completion...', timestamp: new Date().toISOString() } } as any);
          console.log(`[inbox] ${entry.config.label}: injected into terminal, starting completion monitor`);
          entry.state.currentMessageId = nextMsg.id;
          this.monitorTerminalCompletion(agentId, nextMsg.id, entry.state.tmuxSession!);
        } else {
          // Terminal inject failed — clear dead session, message stays pending
          // Health check will auto-restart the terminal session
          entry.state.tmuxSession = undefined;
          nextMsg.status = 'pending' as any; // revert to pending for retry
          this.emit('event', { type: 'bus_message_status', messageId: nextMsg.id, status: 'pending' } as any);
          this.emit('event', { type: 'log', agentId, entry: { type: 'system', subtype: 'warning', content: '⚠️ Terminal session down — waiting for auto-restart, message will retry', timestamp: new Date().toISOString() } } as any);
          console.log(`[inbox] ${entry.config.label}: terminal inject failed, cleared session — waiting for health check restart`);
          this.emitAgentsChanged();
        }
      } else {
        entry.worker!.setProcessingMessage(nextMsg.id);
        entry.worker!.wake({ type: 'bus_message', messages: [logEntry] });
        this.emit('event', { type: 'log', agentId, entry: { type: 'system', subtype: 'execution_method', content: `⚡ Executed via headless (agent: ${entry.config.agentId || 'claude'})`, timestamp: new Date().toISOString() } } as any);
      }
    };

    // Check every 2 seconds
    const timer = setInterval(tick, 2000);
    timer.unref(); // Don't prevent process exit in tests
    this.messageLoopTimers.set(agentId, timer);
    // Also run immediately
    tick();
  }

  /** Stop the message consumption loop for a smith */
  private stopMessageLoop(agentId: string): void {
    const timer = this.messageLoopTimers.get(agentId);
    if (timer) {
      clearInterval(timer);
      this.messageLoopTimers.delete(agentId);
    }
  }

  /** Stop all message loops */
  private stopAllMessageLoops(): void {
    for (const [id] of this.messageLoopTimers) {
      this.stopMessageLoop(id);
    }
  }

  // ─── Terminal completion monitor ──────────────────────
  private terminalMonitors = new Map<string, NodeJS.Timeout>();

  /**
   * Monitor a tmux session for completion after injecting a message.
   * Detects CLI prompt patterns (❯, $, >) indicating the agent is idle.
   * Requires 2 consecutive prompt detections (10s) to confirm completion.
   */
  private monitorTerminalCompletion(agentId: string, messageId: string, tmuxSession: string): void {
    // Stop any existing monitor for this agent
    const existing = this.terminalMonitors.get(agentId);
    if (existing) clearInterval(existing);

    // Prompt patterns that indicate the CLI is idle and waiting for input
    // Claude Code: ❯  Codex: >  Aider: >  Generic shell: $ #
    const PROMPT_PATTERNS = [
      /^❯\s*$/,          // Claude Code idle prompt
      /^>\s*$/,           // Codex / generic prompt
      /^\$\s*$/,          // Shell prompt
      /^#\s*$/,           // Root shell prompt
      /^aider>\s*$/,      // Aider prompt
    ];

    let promptCount = 0;
    let started = false;
    const CONFIRM_CHECKS = 2;    // 2 consecutive prompt detections = done
    const CHECK_INTERVAL = 5000; // 5s between checks

    const timer = setInterval(() => {
      try {
        const output = execSync(`tmux capture-pane -t "${tmuxSession}" -p -S -30`, { timeout: 3000, encoding: 'utf-8' });

        // Strip ANSI escape sequences for clean matching
        const clean = output.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
        // Get last few non-empty lines
        const lines = clean.split('\n').map(l => l.trim()).filter(Boolean);
        const tail = lines.slice(-5);

        // First check: detect that agent started working (output changed from inject)
        if (!started && lines.length > 3) {
          started = true;
        }
        if (!started) return;

        // Check if any of the last lines match a prompt pattern
        const hasPrompt = tail.some(line => PROMPT_PATTERNS.some(p => p.test(line)));

        if (hasPrompt) {
          promptCount++;
          if (promptCount >= CONFIRM_CHECKS) {
            clearInterval(timer);
            this.terminalMonitors.delete(agentId);

            // Extract output summary (skip prompt lines)
            const contentLines = lines.filter(l => !PROMPT_PATTERNS.some(p => p.test(l)));
            const summary = contentLines.slice(-15).join('\n');

            // Mark message done
            const msg = this.bus.getLog().find(m => m.id === messageId);
            if (msg && msg.status !== 'done') {
              msg.status = 'done' as any;
              this.emit('event', { type: 'bus_message_status', messageId, status: 'done' } as any);
            }

            // Emit output to log panel
            this.emit('event', { type: 'log', agentId, entry: { type: 'assistant', subtype: 'terminal_output', content: `📺 Terminal completed:\n${summary.slice(0, 500)}`, timestamp: new Date().toISOString() } } as any);

            // Trigger downstream notifications
            const entry = this.agents.get(agentId);
            if (entry) {
              entry.state.currentMessageId = undefined;
              this.handleAgentDone(agentId, entry, summary.slice(0, 300));
            }
            console.log(`[terminal-monitor] ${agentId}: prompt detected, completed`);
          }
        } else {
          promptCount = 0; // reset — still working
        }
      } catch {
        // Session died
        clearInterval(timer);
        this.terminalMonitors.delete(agentId);
        const msg = this.bus.getLog().find(m => m.id === messageId);
        if (msg && msg.status !== 'done' && msg.status !== 'failed') {
          msg.status = 'failed' as any;
          this.emit('event', { type: 'bus_message_status', messageId, status: 'failed' } as any);
        }
        const entry = this.agents.get(agentId);
        if (entry) entry.state.currentMessageId = undefined;
        console.error(`[terminal-monitor] ${agentId}: session died, marked message failed`);
      }
    }, CHECK_INTERVAL);
    timer.unref();
    this.terminalMonitors.set(agentId, timer);
  }

  /** Stop all terminal monitors (on daemon stop) */
  private stopAllTerminalMonitors(): void {
    for (const [, timer] of this.terminalMonitors) clearInterval(timer);
    this.terminalMonitors.clear();
  }

  /** Check if all agents are done and no pending work remains */
  private checkWorkspaceComplete(): void {
    let allDone = true;
    for (const [id, entry] of this.agents) {
      const ws = entry.worker?.getState();
      const taskSt = ws?.taskStatus ?? entry.state.taskStatus;
      if (taskSt === 'running' || this.approvalQueue.has(id)) {
        allDone = false;
        break;
      }
      // idle agents with unmet deps don't block completion
      if (taskSt === 'idle' && entry.config.dependsOn.length > 0) {
        const allDepsDone = entry.config.dependsOn.every(depId => {
          const dep = this.agents.get(depId);
          return dep && (dep.state.taskStatus === 'done');
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
      if (entry.state.taskStatus !== 'idle') continue;
      const allDepsDone = entry.config.dependsOn.every(depId => {
        const dep = this.agents.get(depId);
        return dep && dep.state.taskStatus === 'done';
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
      if (entry.state.taskStatus !== 'done' && entry.state.taskStatus !== 'failed') continue;

      console.log(`[workspace] ${completedLabel} changed → ${entry.config.label} needs re-validation`);

      // Send bus message
      this.bus.send(completedAgentId, id, 'notify', {
        action: 'update_notify',
        content: `${completedLabel} completed with changes. Please re-validate.`,
        files,
      });

      // Set to waiting_approval so user confirms re-run
      entry.state.taskStatus = 'idle';
      entry.state.history.push({
        type: 'system',
        subtype: 'revalidation_request',
        content: `[${completedLabel}] completed with changes — approve to re-run validation`,
        timestamp: new Date().toISOString(),
      });
      this.approvalQueue.add(id);
      this.emit('event', { type: 'task_status', agentId: id, taskStatus: 'idle' } satisfies WorkerEvent);
      this.emit('event', {
        type: 'approval_required',
        agentId: id,
        upstreamId: completedAgentId,
      } satisfies OrchestratorEvent);
    }
  }

  /** Track how many history entries have been scanned per agent to avoid re-parsing */
  private busMarkerScanned = new Map<string, number>();

  private parseBusMarkers(fromAgentId: string, history: { type: string; content: string }[]): void {
    const markerRegex = /\[SEND:([^:]+):([^\]]+)\]\s*(.+)/g;
    const labelToId = new Map<string, string>();
    for (const [id, e] of this.agents) {
      labelToId.set(e.config.label.toLowerCase(), id);
    }

    // Only scan new entries since last parse (avoid re-sending from old history)
    const lastScanned = this.busMarkerScanned.get(fromAgentId) || 0;
    const newEntries = history.slice(lastScanned);
    this.busMarkerScanned.set(fromAgentId, history.length);

    for (const entry of newEntries) {
      let match;
      while ((match = markerRegex.exec(entry.content)) !== null) {
        const targetLabel = match[1].trim();
        const action = match[2].trim();
        const content = match[3].trim();
        const targetId = labelToId.get(targetLabel.toLowerCase());

        if (targetId && targetId !== fromAgentId) {
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
      const ws = entry.worker?.getState();
      const taskSt = ws?.taskStatus ?? entry.state.taskStatus;
      if (taskSt === 'running') running++;
      if (taskSt === 'done') done++;
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
