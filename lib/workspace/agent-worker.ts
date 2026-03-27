/**
 * AgentWorker — manages the lifecycle of a single workspace agent.
 *
 * Responsibilities:
 * - Multi-step execution with context accumulation
 * - Pause / resume / stop
 * - Bus message injection between steps
 * - Event emission for UI and orchestrator
 */

import { EventEmitter } from 'node:events';
import type {
  WorkspaceAgentConfig,
  AgentState,
  TaskStatus,
  SmithStatus,
  AgentMode,
  AgentBackend,
  WorkerEvent,
  Artifact,
  BusMessage,
  DaemonWakeReason,
} from './types';
import type { TaskLogEntry } from '@/src/types';

export interface AgentWorkerOptions {
  config: WorkspaceAgentConfig;
  backend: AgentBackend;
  projectPath: string;
  initialTaskStatus?: 'idle' | 'running' | 'done' | 'failed';
  // Bus communication callbacks (injected by orchestrator)
  onBusSend?: (to: string, content: string) => void;
  onBusRequest?: (to: string, question: string) => Promise<string>;
  peerAgentIds?: string[];
  // Message status callback — smith marks its own messages
  onMessageDone?: (messageId: string) => void;
  onMessageFailed?: (messageId: string) => void;
  // Memory (injected by orchestrator)
  memoryContext?: string;
  onMemoryUpdate?: (stepResults: string[]) => void;
}

export class AgentWorker extends EventEmitter {
  readonly config: WorkspaceAgentConfig;
  private state: AgentState;
  private backend: AgentBackend;
  private projectPath: string;
  private busCallbacks: {
    onBusSend?: (to: string, content: string) => void;
    onBusRequest?: (to: string, question: string) => Promise<string>;
    peerAgentIds?: string[];
  };

  // Control
  private abortController: AbortController | null = null;
  private paused = false;
  private pauseResolve: (() => void) | null = null;

  // Bus messages queued between steps
  private pendingMessages: TaskLogEntry[] = [];

  // Memory
  private memoryContext?: string;
  private onMemoryUpdate?: (stepResults: string[]) => void;
  private stepResults: string[] = [];

  // Daemon mode
  private wakeResolve: ((reason: DaemonWakeReason) => void) | null = null;
  private daemonRetryCount = 0;
  private currentMessageId: string | null = null; // ID of the bus message being processed
  private onMessageDone?: (messageId: string) => void;
  private onMessageFailed?: (messageId: string) => void;

  constructor(opts: AgentWorkerOptions) {
    super();
    this.config = opts.config;
    this.backend = opts.backend;
    this.projectPath = opts.projectPath;
    this.busCallbacks = {
      onBusSend: opts.onBusSend,
      onBusRequest: opts.onBusRequest,
      peerAgentIds: opts.peerAgentIds,
    };
    this.memoryContext = opts.memoryContext;
    this.onMemoryUpdate = opts.onMemoryUpdate;
    this.onMessageDone = opts.onMessageDone;
    this.onMessageFailed = opts.onMessageFailed;
    this.state = {
      smithStatus: 'down',
      mode: 'auto',
      taskStatus: opts.initialTaskStatus || 'idle',
      history: [],
      artifacts: [],
    };
  }

  // ─── Public API ──────────────────────────────────────

  /**
   * Execute all steps starting from `startStep`.
   * For recovery, pass `lastCheckpoint + 1`.
   */
  async execute(startStep = 0, upstreamContext?: string): Promise<void> {
    const { steps } = this.config;
    if (steps.length === 0) {
      this.setTaskStatus('done');
      this.emitEvent({ type: 'done', agentId: this.config.id, summary: 'No steps defined' });
      return;
    }

    // Prepend memory to upstream context
    if (this.memoryContext) {
      upstreamContext = upstreamContext
        ? this.memoryContext + '\n\n---\n\n' + upstreamContext
        : this.memoryContext;
    }

    this.stepResults = [];
    this.abortController = new AbortController();
    this.setTaskStatus('running');
    this.state.startedAt = Date.now();

    for (let i = startStep; i < steps.length; i++) {
      // Check pause
      await this.waitIfPaused();

      // Check abort
      if (this.abortController.signal.aborted) {
        console.log(`[worker] ${this.config.label}: abort detected before step ${i} (signal already aborted)`);
        this.markMessageFailed();
        this.setTaskStatus('failed', 'Interrupted');
        return;
      }

      const step = steps[i];
      this.state.currentStep = i;
      this.emitEvent({ type: 'step', agentId: this.config.id, stepIndex: i, stepLabel: step.label });

      // Consume pending bus messages → append to history as context
      if (this.pendingMessages.length > 0) {
        for (const msg of this.pendingMessages) {
          this.state.history.push(msg);
        }
        this.pendingMessages = [];
      }

      try {
        const result = await this.backend.executeStep({
          config: this.config,
          step,
          stepIndex: i,
          history: this.state.history,
          projectPath: this.projectPath,
          upstreamContext: i === startStep ? upstreamContext : undefined,
          onBusSend: this.busCallbacks.onBusSend,
          onBusRequest: this.busCallbacks.onBusRequest,
          peerAgentIds: this.busCallbacks.peerAgentIds,
          abortSignal: this.abortController.signal,
          onLog: (entry) => {
            this.state.history.push(entry);
            this.emitEvent({ type: 'log', agentId: this.config.id, entry });
          },
        });

        // Validate result — detect if the agent hit an error but backend didn't catch it
        const failureCheck = detectStepFailure(result.response);
        if (failureCheck) {
          throw new Error(failureCheck);
        }

        // Record the assistant's final response for this step
        this.state.history.push({
          type: 'result',
          subtype: 'step_complete',
          content: result.response,
          timestamp: new Date().toISOString(),
        });

        // Collect artifacts
        for (const artifact of result.artifacts) {
          this.state.artifacts.push(artifact);
          this.emitEvent({ type: 'artifact', agentId: this.config.id, artifact });
        }

        // Emit step summary (compact, human-friendly)
        const stepSummary = summarizeStepResult(step.label, result.response, result.artifacts);
        this.emitEvent({
          type: 'log', agentId: this.config.id,
          entry: { type: 'system', subtype: 'step_summary', content: stepSummary, timestamp: new Date().toISOString() },
        });

        // Collect step result for memory update
        this.stepResults.push(result.response);

        // Checkpoint: this step succeeded
        this.state.lastCheckpoint = i;

      } catch (err: any) {
        const msg = err?.message || String(err);
        // Aborted = graceful stop (SIGTERM/SIGINT), not an error
        if (msg === 'Aborted' || this.abortController?.signal.aborted) {
          console.log(`[worker] ${this.config.label}: step catch — msg="${msg}", aborted=${this.abortController?.signal.aborted}`);
          this.markMessageFailed();
          this.setTaskStatus('failed', 'Interrupted');
          return;
        }
        this.markMessageFailed();
        this.setTaskStatus('failed', msg);
        this.emitEvent({ type: 'error', agentId: this.config.id, error: this.state.error! });
        return;
      }
    }

    // All steps done
    this.markMessageDone(); // mark trigger message before emitting done
    this.setTaskStatus('done');
    this.state.completedAt = Date.now();

    // Trigger memory update (orchestrator handles the actual LLM call)
    if (this.onMemoryUpdate && this.stepResults.length > 0) {
      try { this.onMemoryUpdate(this.stepResults); } catch {}
    }

    // Emit final summary
    const finalSummary = buildFinalSummary(this.config.label, this.config.steps, this.stepResults, this.state.artifacts);
    this.emitEvent({
      type: 'log', agentId: this.config.id,
      entry: { type: 'result', subtype: 'final_summary', content: finalSummary, timestamp: new Date().toISOString() },
    });

    const summary = this.state.artifacts.length > 0
      ? `Completed. Artifacts: ${this.state.artifacts.map(a => a.path || a.summary).join(', ')}`
      : 'Completed.';
    this.emitEvent({ type: 'done', agentId: this.config.id, summary });
  }

  /** Stop execution (abort current step and daemon loop) */
  stop(): void {
    console.log(`[worker] stop() called for ${this.config.label} (task=${this.state.taskStatus}, smith=${this.state.smithStatus})`, new Error().stack?.split('\n').slice(1, 4).join(' <- '));
    this.abortController?.abort();
    this.backend.abort();
    this.setSmithStatus('down');
    // Don't change taskStatus — keep done/failed/idle as-is
    // Only change running → done (graceful stop of an in-progress task)
    if (this.state.taskStatus === 'running') {
      this.setTaskStatus('failed', 'Interrupted');
    }
    // If paused, release the pause wait
    if (this.pauseResolve) {
      this.pauseResolve();
      this.pauseResolve = null;
    }
    // If in daemon wait, wake with abort
    if (this.wakeResolve) {
      this.wakeResolve({ type: 'abort' });
      this.wakeResolve = null;
    }
  }

  /** Pause after current step completes */
  pause(): void {
    if (this.state.taskStatus !== 'running') return;
    this.paused = true;
    // Paused is a sub-state of running, no separate taskStatus
  }

  /** Resume from paused state */
  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    if (this.pauseResolve) {
      this.pauseResolve();
      this.pauseResolve = null;
    }
  }

  /**
   * Inject a message from the bus (or human) into the pending queue.
   * Will be consumed at the start of the next step.
   */
  injectMessage(entry: TaskLogEntry): void {
    this.pendingMessages.push(entry);
  }

  // ─── Daemon Mode ──────────────────────────────────────

  /**
   * Execute steps then enter daemon loop — agent stays alive waiting for events.
   * Errors do NOT kill the daemon; agent retries with backoff.
   */
  async executeDaemon(startStep = 0, upstreamContext?: string, skipSteps = false): Promise<void> {
    if (!skipSteps) {
      // Run initial steps
      await this.execute(startStep, upstreamContext);

      // If aborted, don't enter daemon loop
      if (this.abortController?.signal.aborted) return;
    } else {
      // Skip steps — just prepare for daemon loop
      this.abortController = new AbortController();
    }

    // Enter daemon mode: smith = active, task keeps its status (done/failed/idle)
    this.state.daemonIteration = 0;
    this.daemonRetryCount = 0;
    this.setSmithStatus('active');

    this.emitEvent({
      type: 'log', agentId: this.config.id,
      entry: { type: 'system', subtype: 'daemon', content: `[Smith] Active — listening for messages`, timestamp: new Date().toISOString() },
    });

    // Daemon loop — wait for messages, execute, repeat
    while (!this.abortController?.signal.aborted) {
      const reason = await this.waitForWake();

      if (reason.type === 'abort') break;

      this.state.daemonIteration = (this.state.daemonIteration || 0) + 1;
      this.daemonRetryCount = 0;

      try {
        await this.executeDaemonStep(reason);
        this.markMessageDone();
        this.setTaskStatus('done');
        this.emitEvent({ type: 'done', agentId: this.config.id, summary: `Daemon iteration ${this.state.daemonIteration}` });
      } catch (err: any) {
        const msg = err?.message || String(err);

        // Aborted = graceful stop, exit daemon loop
        if (msg === 'Aborted' || this.abortController?.signal.aborted) break;

        // Real errors: mark message failed, then backoff
        this.markMessageFailed();
        this.setTaskStatus('failed', msg);
        this.emitEvent({ type: 'error', agentId: this.config.id, error: msg });
        this.emitEvent({
          type: 'log', agentId: this.config.id,
          entry: { type: 'system', subtype: 'daemon', content: `[Smith] Error: ${msg}. Waiting for next event.`, timestamp: new Date().toISOString() },
        });

        const backoffMs = Math.min(5000 * Math.pow(2, this.daemonRetryCount++), 60_000);
        await this.sleep(backoffMs);

        if (this.abortController?.signal.aborted) break;
        // Keep failed status — next wake event will set running again
      }
    }

    // Exiting daemon loop
    this.setSmithStatus('down');
  }

  /** Wake the daemon from listening state */
  wake(reason: DaemonWakeReason): void {
    if (this.wakeResolve) {
      this.wakeResolve(reason);
      this.wakeResolve = null;
    }
  }

  /** Check if smith is active and idle (ready to receive messages) */
  isListening(): boolean {
    return this.state.smithStatus === 'active' && this.state.taskStatus !== 'running';
  }

  /** Set the bus message ID being processed — smith marks it done/failed on completion */
  setProcessingMessage(messageId: string): void {
    this.currentMessageId = messageId;
  }

  /** Mark current message as done and clear */
  private markMessageDone(): void {
    if (this.currentMessageId && this.onMessageDone) {
      this.onMessageDone(this.currentMessageId);
    }
    this.currentMessageId = null;
  }

  /** Mark current message as failed and clear */
  private markMessageFailed(): void {
    if (this.currentMessageId && this.onMessageFailed) {
      this.onMessageFailed(this.currentMessageId);
    }
    this.currentMessageId = null;
  }

  private waitForWake(): Promise<DaemonWakeReason> {
    return new Promise<DaemonWakeReason>((resolve) => {
      this.wakeResolve = resolve;
      // Also resolve on abort
      const onAbort = () => resolve({ type: 'abort' });
      this.abortController?.signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  private async executeDaemonStep(reason: DaemonWakeReason): Promise<void> {
    if (reason.type === 'abort') return;

    this.setTaskStatus('running');

    // Build prompt based on wake reason
    let prompt: string;
    switch (reason.type) {
      case 'bus_message':
        prompt = `You received new messages from other agents:\n${reason.messages.map(m => m.content).join('\n')}\n\nReact accordingly — update your work, respond, or take action as needed.`;
        break;
      case 'upstream_changed':
        prompt = `Your upstream dependency (agent ${reason.agentId}) has produced new output: ${reason.files.join(', ')}.\n\nRe-analyze and update your work based on the new upstream output.`;
        break;
      case 'input_changed':
        prompt = `New requirements have been provided:\n${reason.content}\n\nUpdate your work based on these new requirements.`;
        break;
      case 'user_message':
        prompt = `User message: ${reason.content}\n\nRespond and take action as needed.`;
        break;
    }

    // Consume any pending bus messages
    const contextMessages = [...this.pendingMessages];
    this.pendingMessages = [];

    for (const msg of contextMessages) {
      this.state.history.push(msg);
    }

    // Execute using the last step definition as template (or first if no steps)
    const stepTemplate = this.config.steps[this.config.steps.length - 1] || this.config.steps[0];
    if (!stepTemplate) {
      // No steps defined — just log
      this.state.history.push({
        type: 'system', subtype: 'daemon',
        content: `[Daemon] Wake: ${reason.type} — no steps defined to execute`,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const step = {
      ...stepTemplate,
      id: `daemon-${this.state.daemonIteration}`,
      label: `Daemon iteration ${this.state.daemonIteration}`,
      prompt,
    };

    this.emitEvent({ type: 'step', agentId: this.config.id, stepIndex: -1, stepLabel: step.label });

    const result = await this.backend.executeStep({
      config: this.config,
      step,
      stepIndex: -1,
      history: this.state.history,
      projectPath: this.projectPath,
      onBusSend: this.busCallbacks.onBusSend,
      onBusRequest: this.busCallbacks.onBusRequest,
      peerAgentIds: this.busCallbacks.peerAgentIds,
      abortSignal: this.abortController?.signal,
      onLog: (entry) => {
        this.state.history.push(entry);
        this.emitEvent({ type: 'log', agentId: this.config.id, entry });
      },
    });

    // Validate result
    const failureCheck = detectStepFailure(result.response);
    if (failureCheck) {
      throw new Error(failureCheck);
    }

    // Record result
    this.state.history.push({
      type: 'result', subtype: 'daemon_step',
      content: result.response,
      timestamp: new Date().toISOString(),
    });

    // Collect artifacts
    for (const artifact of result.artifacts) {
      this.state.artifacts.push(artifact);
      this.emitEvent({ type: 'artifact', agentId: this.config.id, artifact });
    }

    const stepSummary = summarizeStepResult(step.label, result.response, result.artifacts);
    this.emitEvent({
      type: 'log', agentId: this.config.id,
      entry: { type: 'system', subtype: 'step_summary', content: stepSummary, timestamp: new Date().toISOString() },
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /** Get current state snapshot (immutable copy) */
  getState(): Readonly<AgentState> {
    return { ...this.state };
  }

  /** Get the config */
  getConfig(): Readonly<WorkspaceAgentConfig> {
    return this.config;
  }

  // ─── Private ─────────────────────────────────────────

  private setTaskStatus(taskStatus: TaskStatus, error?: string): void {
    this.state.taskStatus = taskStatus;
    this.state.error = error;
    this.emitEvent({ type: 'task_status', agentId: this.config.id, taskStatus, error });
  }

  private setSmithStatus(smithStatus: SmithStatus, mode?: AgentMode): void {
    this.state.smithStatus = smithStatus;
    if (mode) this.state.mode = mode;
    this.emitEvent({ type: 'smith_status', agentId: this.config.id, smithStatus, mode: this.state.mode });
  }

  private emitEvent(event: WorkerEvent): void {
    this.emit('event', event);
  }

  private waitIfPaused(): Promise<void> {
    if (!this.paused) return Promise.resolve();
    return new Promise<void>(resolve => {
      this.pauseResolve = resolve;
    });
  }
}

// ─── Summary helpers (no LLM, pure heuristic) ────────────

/** Extract a compact step summary from raw output */
/**
 * Detect if a step's result indicates failure — covers all agent types:
 * - Rate/usage limits (codex, claude, API)
 * - Auth failures
 * - Subscription limits (claude code)
 * - Empty/meaningless output
 * Returns error message if failure detected, null if OK.
 */
function detectStepFailure(response: string): string | null {
  if (!response || response.trim().length === 0) {
    return 'Agent produced no output — step may not have executed';
  }

  const patterns: [RegExp, string][] = [
    // Usage/rate limits
    [/usage limit/i, 'Usage limit reached'],
    [/rate limit/i, 'Rate limit reached'],
    [/hit your.*limit/i, 'Account limit reached'],
    [/upgrade to (plus|pro|max)/i, 'Subscription upgrade required'],
    [/try again (at|in|after)/i, 'Temporarily unavailable — try again later'],
    // Claude Code specific
    [/exceeded.*monthly.*limit/i, 'Monthly usage limit exceeded'],
    [/opus limit|sonnet limit/i, 'Model usage limit reached'],
    [/you've been rate limited/i, 'Rate limited'],
    // API errors
    [/api key.*invalid/i, 'Invalid API key'],
    [/authentication failed/i, 'Authentication failed'],
    [/insufficient.*quota/i, 'Insufficient API quota'],
    [/billing.*not.*active/i, 'Billing not active'],
    [/overloaded|server error|503|502/i, 'Service temporarily unavailable'],
  ];

  for (const [pattern, msg] of patterns) {
    if (pattern.test(response)) {
      // Extract the actual error line for context
      const errorLine = response.split('\n').find(l => pattern.test(l))?.trim();
      return `${msg}${errorLine ? ': ' + errorLine.slice(0, 150) : ''}`;
    }
  }

  // Check for very short output that's just noise (spinner artifacts, etc.)
  const meaningful = response.replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, '').trim();
  if (meaningful.length < 10 && response.length > 50) {
    return 'Agent output appears to be only terminal noise — execution may have failed';
  }

  return null;
}

function summarizeStepResult(stepLabel: string, rawResult: string, artifacts: { path?: string; summary?: string }[]): string {
  const lines: string[] = [];
  lines.push(`✅ Step "${stepLabel}" done`);

  // Extract key sentences (first meaningful line, skip noise)
  const meaningful = rawResult
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 15 && l.length < 300)
    .filter(l => !/^[#\-*>|`]/.test(l))  // skip markdown headers, bullets, code blocks
    .filter(l => !/^(Working|W$|Wo$|•)/.test(l));  // skip codex noise

  if (meaningful.length > 0) {
    lines.push(`   ${meaningful[0].slice(0, 120)}`);
  }

  // List artifacts
  const filePaths = artifacts.filter(a => a.path).map(a => a.path!);
  if (filePaths.length > 0) {
    lines.push(`   Files: ${filePaths.join(', ')}`);
  }

  return lines.join('\n');
}

/** Build a final summary after all steps complete */
function buildFinalSummary(
  agentLabel: string,
  steps: { label: string }[],
  stepResults: string[],
  artifacts: { path?: string; summary?: string }[],
): string {
  const lines: string[] = [];
  lines.push(`══════════════════════════════════════`);
  lines.push(`📊 ${agentLabel} — Summary`);
  lines.push(`──────────────────────────────────────`);

  // Steps completed
  lines.push(`Steps: ${steps.map(s => s.label).join(' → ')}`);

  // Key output per step (one line each)
  for (let i = 0; i < steps.length; i++) {
    const result = stepResults[i] || '';
    const firstLine = result
      .split('\n')
      .map(l => l.trim())
      .filter(l => l.length > 15 && l.length < 200)
      .filter(l => !/^[#\-*>|`]/.test(l))
      .filter(l => !/^(Working|W$|Wo$|•)/.test(l))[0];
    if (firstLine) {
      lines.push(`  ${steps[i].label}: ${firstLine.slice(0, 100)}`);
    }
  }

  // All artifacts
  const files = artifacts.filter(a => a.path).map(a => a.path!);
  if (files.length > 0) {
    lines.push(`Produced: ${files.join(', ')}`);
  }

  lines.push(`══════════════════════════════════════`);
  return lines.join('\n');
}
