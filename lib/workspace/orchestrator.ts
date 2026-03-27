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
  SmithStatus,
  TaskStatus,
  AgentMode,
  WorkerEvent,
  BusMessage,
  Artifact,
  WorkspaceState,
  DaemonWakeReason,
} from './types';
import { AgentWorker } from './agent-worker';
import { AgentBus } from './agent-bus';
import { ApiBackend } from './backends/api-backend';
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
  | { type: 'workspace_complete' };

// ─── Orchestrator class ──────────────────────────────────

export class WorkspaceOrchestrator extends EventEmitter {
  readonly workspaceId: string;
  readonly projectPath: string;
  readonly projectName: string;

  private agents = new Map<string, { config: WorkspaceAgentConfig; worker: AgentWorker | null; state: AgentState }>();
  private bus: AgentBus;
  private approvalQueue = new Set<string>();
  private daemonActive = false;
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

    // Validate workDir is within project (no ../ escape)
    if (config.workDir) {
      const resolved = require('node:path').resolve(this.projectPath, config.workDir);
      if (!resolved.startsWith(this.projectPath)) {
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

  addAgent(config: WorkspaceAgentConfig): void {
    const conflict = this.validateOutputs(config);
    if (conflict) {
      throw new Error(conflict);
      // Still add but warn — don't block
    }

    const state: AgentState = {
      smithStatus: 'down',
      mode: 'auto',
      taskStatus: 'idle',
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
    if (entry.worker && entry.state.taskStatus === 'running') {
      entry.worker.stop();
    }
    entry.config = config;
    // Reset status but keep history/artifacts (don't wipe logs)
    entry.state.taskStatus = 'idle';
    entry.state.error = undefined;
    entry.worker = null;
    this.saveNow();
    this.emitAgentsChanged();
    // Push status update so frontend reflects the reset
    this.emit('event', { type: 'task_status', agentId: id, taskStatus: 'idle' } satisfies WorkerEvent);
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
    entry.state = { smithStatus: 'down', mode: 'auto', taskStatus: 'idle', history: [], artifacts: [] };
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
      entry.state = { smithStatus: entry.state.smithStatus, mode: entry.state.mode, taskStatus: 'idle', history: [], artifacts: [], cliSessionId: entry.state.cliSessionId };
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
        entry.state = { smithStatus: entry.state.smithStatus, mode: entry.state.mode, taskStatus: 'idle', history: [], artifacts: [], cliSessionId: entry.state.cliSessionId };
      } else {
        entry.state.taskStatus = 'idle';
        entry.state.error = undefined;
        entry.state.mode = 'auto';
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

      // On done → parse bus markers + notify + trigger downstream
      if (event.type === 'done') {
        const files = entry.state.artifacts.filter(a => a.path).map(a => a.path!);
        console.log(`[workspace] Agent "${config.label}" (${agentId}) completed. Artifacts: ${files.length}.`);

        // Parse CLI output for bus markers: [SEND:TargetLabel:action] content
        this.parseBusMarkers(agentId, entry.state.history);

        this.bus.notifyTaskComplete(agentId, files, event.summary);

        // Trigger idle downstream agents (first run)
        this.broadcastCompletion(agentId);

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
        mode: entry.state.mode,
        taskStatus: 'idle',
        history: [],
        artifacts: [],
        cliSessionId: entry.state.cliSessionId, // preserve session for --resume
      };
    }

    // Ensure smith is active when daemon starts this agent
    if (this.daemonActive && entry.state.smithStatus !== 'active') {
      entry.state.smithStatus = 'active';
      this.emit('event', { type: 'smith_status', agentId, smithStatus: 'active', mode: entry.state.mode } satisfies WorkerEvent);
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
        entry.state.mode = event.mode;
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
        // Trigger message already marked done in task_status handler above
        const files = entry.state.artifacts.filter(a => a.path).map(a => a.path!);
        this.parseBusMarkers(agentId, entry.state.history);
        this.bus.notifyTaskComplete(agentId, files, event.summary);
        this.broadcastCompletion(agentId);
        this.emitWorkspaceStatus();

        // Message loop will auto-consume next pending message
      }
      if (event.type === 'error') {
        // Trigger message already marked failed in task_status handler above
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
        entry.state.mode = 'auto';
        entry.state.error = undefined;

        // 4. Start message consumption loop
        this.startMessageLoop(id);

        // 5. Update liveness for bus routing
        this.updateAgentLiveness(id);

        // 6. Notify frontend
        this.emit('event', { type: 'smith_status', agentId: id, smithStatus: 'active', mode: 'auto' } satisfies WorkerEvent);

        started++;
        console.log(`[daemon] ✓ ${entry.config.label}: active (task=${entry.state.taskStatus})`);
      } catch (err: any) {
        entry.state.smithStatus = 'down';
        entry.state.error = `Failed to start: ${err.message}`;
        this.emit('event', { type: 'smith_status', agentId: id, smithStatus: 'down', mode: 'auto' } satisfies WorkerEvent);
        failed++;
        console.error(`[daemon] ✗ ${entry.config.label}: failed — ${err.message}`);
      }
    }

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

    const { config } = entry;

    // TODO: per-smith install hook for future use (commands, custom skills, etc.)
    // Skills are installed globally in startDaemon, not per-smith

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
        entry.state.mode = event.mode;
      }
      if (event.type === 'log') {
        appendAgentLog(this.workspaceId, agentId, event.entry).catch(() => {});
      }
      this.emit('event', event);
      if (event.type === 'task_status' || event.type === 'smith_status') {
        this.updateAgentLiveness(agentId);
      }
      if (event.type === 'done') {
        const files = entry.state.artifacts.filter(a => a.path).map(a => a.path!);
        this.parseBusMarkers(agentId, entry.state.history);
        this.bus.notifyTaskComplete(agentId, files, event.summary);
        this.broadcastCompletion(agentId);
        this.emitWorkspaceStatus();
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

      // 3. Set smith down
      entry.state.smithStatus = 'down';
      entry.state.error = undefined;
      this.updateAgentLiveness(id);
      this.emit('event', { type: 'smith_status', agentId: id, smithStatus: 'down', mode: entry.state.mode } satisfies WorkerEvent);

      console.log(`[daemon] ■ ${entry.config.label}: stopped`);
    }

    // Mark running messages as failed
    this.bus.markAllRunningAsFailed();
    this.emitAgentsChanged();
    console.log('[workspace] Daemon stopped');
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
  stopAgent(agentId: string): void {
    const entry = this.agents.get(agentId);
    entry?.worker?.stop();
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

  /** Switch an agent to manual mode (user operates in terminal) */
  setManualMode(agentId: string): void {
    const entry = this.agents.get(agentId);
    if (!entry) return;
    if (entry.worker) entry.worker.stop();
    entry.worker = null;
    entry.state.mode = 'manual';
    entry.state.tmuxSession = undefined;
    entry.state.smithStatus = 'active';
    // Don't set running — user hasn't started working yet. Keep current taskStatus.
    entry.state.error = undefined;

    this.emit('event', { type: 'smith_status', agentId, smithStatus: 'active', mode: 'manual' } satisfies WorkerEvent);
    this.emit('event', { type: 'task_status', agentId, taskStatus: 'running' } satisfies WorkerEvent);
    this.emitAgentsChanged();
    this.saveNow();
    console.log(`[workspace] Agent "${entry.config.label}" switched to manual mode`);
  }

  /** Re-enter daemon mode for an agent after manual terminal is closed */
  restartAgentDaemon(agentId: string): void {
    if (!this.daemonActive) return;
    const entry = this.agents.get(agentId);
    if (!entry || entry.config.type === 'input') return;
    if (entry.worker) return; // already has a worker

    // Back to auto mode, enter listening (don't execute steps — wait for messages)
    entry.state.mode = 'auto';
    entry.state.error = undefined;
    this.emit('event', { type: 'smith_status', agentId, smithStatus: 'active', mode: 'auto' } satisfies WorkerEvent);

    this.enterDaemonListening(agentId);
    this.startMessageLoop(agentId);
  }

  /** Complete a manual agent — called by forge-done skill from terminal */
  completeManualAgent(agentId: string, changedFiles: string[]): void {
    const entry = this.agents.get(agentId);
    if (!entry) return;

    entry.state.taskStatus = 'done';
    entry.state.mode = 'auto'; // clear manual mode
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
      const state = data.agentStates[config.id] || { smithStatus: 'down' as const, mode: 'auto' as const, taskStatus: 'idle' as const, history: [], artifacts: [] };

      // Migrate old format if loading from pre-two-layer state
      if ('status' in state && !('smithStatus' in state)) {
        const oldStatus = (state as any).status;
        (state as any).smithStatus = 'down';
        (state as any).mode = (state as any).runMode || 'auto';
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
  private broadcastCompletion(completedAgentId: string): void {
    const completed = this.agents.get(completedAgentId);
    if (!completed) return;

    const completedLabel = completed.config.label;
    const files = completed.state.artifacts.filter(a => a.path).map(a => a.path!);
    const summary = completed.state.history
      .filter(h => h.subtype === 'final_summary' || h.subtype === 'step_summary')
      .slice(-1)[0]?.content || '';

    // Always broadcast — downstream decides whether to act based on message content
    const content = files.length > 0
      ? `${completedLabel} completed: ${files.length} files changed. ${summary.slice(0, 200)}`
      : `${completedLabel} completed. ${summary.slice(0, 300) || 'Check upstream outputs for updates.'}`;

    // Find all downstream agents that depend on this one
    let sent = 0;
    for (const [id, entry] of this.agents) {
      if (id === completedAgentId) continue;
      if (entry.config.type === 'input') continue;
      if (!entry.config.dependsOn.includes(completedAgentId)) continue;

      this.bus.send(completedAgentId, id, 'notify', {
        action: 'upstream_complete',
        content,
        files,
      });
      sent++;
      console.log(`[bus] ${completedLabel} → ${entry.config.label}: upstream_complete (${files.length} files)`);
    }

    if (sent === 0) {
      console.log(`[bus] ${completedLabel} completed — no downstream agents`);
    }
  }

  // ─── Agent liveness ─────────────────────────────────────

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

    // ── Manual mode → mark done (user handles in terminal) ──
    if (target.state.mode === 'manual') {
      ackAndDeliver();
      console.log(`[bus] ${target.config.label}: received ${action} in manual mode — stored in inbox`);
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

    const tick = () => {
      const entry = this.agents.get(agentId);
      if (!entry || entry.state.smithStatus !== 'active') {
        this.stopMessageLoop(agentId);
        return;
      }

      // Skip if task is running — check again next tick
      if (entry.state.taskStatus === 'running') return;

      // Skip if no worker or worker not listening
      if (!entry.worker?.isListening()) return;

      // Find next pending message
      const pending = this.bus.getPendingMessagesFor(agentId).filter(m => m.from !== agentId && m.type !== 'ack');
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

      entry.worker.setProcessingMessage(nextMsg.id);
      entry.worker.wake({ type: 'bus_message', messages: [logEntry] });
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
