/**
 * Workspace Agent types — core interfaces for the multi-agent workspace system.
 */

import type { ProviderName, TaskLogEntry } from '@/src/types';

// ─── Agent Config ────────────────────────────────────────

export interface WorkspaceAgentConfig {
  id: string;
  label: string;
  icon: string;
  // Node type: 'agent' (default) or 'input' (user-provided requirements)
  type?: 'agent' | 'input';
  // Input node: append-only entries (latest is active, older are history)
  content?: string;                    // legacy single content (migrated to entries)
  entries?: InputEntry[];              // incremental input history
  role: string;                      // system prompt / role description
  backend: AgentBackendType;
  // CLI mode
  agentId?: string;                  // 'claude' | 'codex' | 'aider'
  // API mode
  provider?: ProviderName;
  model?: string;                    // e.g. 'claude-sonnet-4-6'
  // Dependencies (replaces inputPaths matching)
  dependsOn: string[];               // upstream agent IDs to wait for
  // Declared outputs
  outputs: string[];                 // e.g. ['docs/prd.md']
  // Multi-step execution (user-defined, preset templates provide defaults)
  steps: AgentStep[];
  // Approval gate
  requiresApproval?: boolean;
}

export type AgentBackendType = 'api' | 'cli';

export interface InputEntry {
  content: string;
  timestamp: number;
}

export interface AgentStep {
  id: string;
  label: string;                     // e.g. "Analyze requirements"
  prompt: string;                    // instruction for this step
}

// ─── Agent State ─────────────────────────────────────────

export type AgentStatus =
  | 'idle'
  | 'running'
  | 'paused'
  | 'waiting_approval'
  | 'done'
  | 'failed'
  | 'interrupted';

export interface AgentState {
  status: AgentStatus;
  currentStep?: number;              // index into steps[]
  history: TaskLogEntry[];           // cross-step accumulated log
  artifacts: Artifact[];
  logFile?: string;                  // path to JSONL log file
  lastCheckpoint?: number;           // last successfully completed step index
  cliSessionId?: string;             // claude session ID for --resume (persisted across re-runs)
  startedAt?: number;
  completedAt?: number;
  error?: string;
}

// ─── Artifact ────────────────────────────────────────────

export interface Artifact {
  type: 'file' | 'text';
  path?: string;
  summary?: string;
}

// ─── Bus Message ─────────────────────────────────────────

export interface BusMessage {
  id: string;
  from: string;                      // source agent ID
  to: string;                        // target agent ID (no broadcast)
  type: 'notify' | 'request' | 'response' | 'artifact' | 'ack';
  payload: {
    action: string;                  // 'task_complete' | 'step_complete' | 'question' | 'fix_request' | ...
    content?: string;                // natural language message
    files?: string[];                // related file paths
    replyTo?: string;                // reply to which message ID
  };
  timestamp: number;
  // Delivery tracking
  status?: 'pending' | 'delivered' | 'acked' | 'failed';
  retries?: number;
}

// ─── Agent Heartbeat ─────────────────────────────────────

export type AgentLiveness = 'alive' | 'busy' | 'down';

export interface AgentHeartbeat {
  agentId: string;
  liveness: AgentLiveness;
  lastSeen: number;
  currentStep?: string;
}

// ─── Workspace State (persistence) ───────────────────────

export interface WorkspaceState {
  id: string;
  projectPath: string;
  projectName: string;
  agents: WorkspaceAgentConfig[];
  agentStates: Record<string, AgentState>;
  nodePositions: Record<string, { x: number; y: number }>;
  busLog: BusMessage[];
  busOutbox?: Record<string, BusMessage[]>; // agentId → undelivered messages
  createdAt: number;
  updatedAt: number;
}

// ─── Backend Interface ───────────────────────────────────

export interface StepExecutionParams {
  config: WorkspaceAgentConfig;
  step: AgentStep;
  stepIndex: number;
  history: TaskLogEntry[];           // accumulated context from prior steps
  projectPath: string;
  upstreamContext?: string;          // injected context from upstream agents
  onLog?: (entry: TaskLogEntry) => void;
  abortSignal?: AbortSignal;
  // Bus communication callbacks (injected by orchestrator)
  onBusSend?: (to: string, content: string) => void;
  onBusRequest?: (to: string, question: string) => Promise<string>;
  /** List of other agent IDs in the workspace (for communication tools) */
  peerAgentIds?: string[];
}

export interface StepExecutionResult {
  response: string;
  artifacts: Artifact[];
  sessionId?: string;                // CLI: conversation ID for --resume
  inputTokens?: number;
  outputTokens?: number;
}

export interface AgentBackend {
  /** Execute a single step */
  executeStep(params: StepExecutionParams): Promise<StepExecutionResult>;
  /** Abort a running step */
  abort(): void;
}

// ─── Worker Events ───────────────────────────────────────

export type WorkerEvent =
  | { type: 'status'; agentId: string; status: AgentStatus }
  | { type: 'log'; agentId: string; entry: TaskLogEntry }
  | { type: 'step'; agentId: string; stepIndex: number; stepLabel: string }
  | { type: 'artifact'; agentId: string; artifact: Artifact }
  | { type: 'agents_changed'; agents: WorkspaceAgentConfig[] }
  | { type: 'done'; agentId: string; summary: string }
  | { type: 'error'; agentId: string; error: string };
