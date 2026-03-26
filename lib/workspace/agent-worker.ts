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
  AgentStatus,
  AgentBackend,
  WorkerEvent,
  Artifact,
  BusMessage,
} from './types';
import type { TaskLogEntry } from '@/src/types';

export interface AgentWorkerOptions {
  config: WorkspaceAgentConfig;
  backend: AgentBackend;
  projectPath: string;
  // Bus communication callbacks (injected by orchestrator)
  onBusSend?: (to: string, content: string) => void;
  onBusRequest?: (to: string, question: string) => Promise<string>;
  peerAgentIds?: string[];
  // Memory (injected by orchestrator)
  memoryContext?: string;              // formatted memory text to inject
  onMemoryUpdate?: (stepResults: string[]) => void; // called after all steps complete
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
    this.state = {
      status: 'idle',
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
      this.setStatus('done');
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
    this.setStatus('running');
    this.state.startedAt = Date.now();
    this.state.error = undefined;

    for (let i = startStep; i < steps.length; i++) {
      // Check pause
      await this.waitIfPaused();

      // Check abort
      if (this.abortController.signal.aborted) {
        this.setStatus('interrupted');
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
        this.state.error = err?.message || String(err);
        this.setStatus('failed');
        this.emitEvent({ type: 'error', agentId: this.config.id, error: this.state.error! });
        return;
      }
    }

    // All steps done
    this.setStatus('done');
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

  /** Stop execution (abort current step) */
  stop(): void {
    this.abortController?.abort();
    this.backend.abort();
    if (this.state.status === 'running' || this.state.status === 'paused') {
      this.setStatus('interrupted');
    }
    // If paused, release the pause wait
    if (this.pauseResolve) {
      this.pauseResolve();
      this.pauseResolve = null;
    }
  }

  /** Pause after current step completes */
  pause(): void {
    if (this.state.status !== 'running') return;
    this.paused = true;
    this.setStatus('paused');
  }

  /** Resume from paused state */
  resume(): void {
    if (this.state.status !== 'paused') return;
    this.paused = false;
    this.setStatus('running');
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

  /** Get current state snapshot (immutable copy) */
  getState(): Readonly<AgentState> {
    return { ...this.state };
  }

  /** Get the config */
  getConfig(): Readonly<WorkspaceAgentConfig> {
    return this.config;
  }

  // ─── Private ─────────────────────────────────────────

  private setStatus(status: AgentStatus): void {
    this.state.status = status;
    this.emitEvent({ type: 'status', agentId: this.config.id, status });
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
