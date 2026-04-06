/**
 * Workspace Agent types — core interfaces for the multi-agent workspace system.
 */

import type { ProviderName, TaskLogEntry } from '../../src/types';

// ─── Agent Config ────────────────────────────────────────

export interface WorkspaceAgentConfig {
  id: string;
  label: string;
  icon: string;
  // Node type: 'agent' (default) or 'input' (user-provided requirements)
  type?: 'agent' | 'input';
  // Primary agent: one per workspace, terminal-only, root dir, fixed session
  primary?: boolean;
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
  // Working directory (relative to project root, default './' = root)
  workDir?: string;                  // e.g. 'docs/prd' — where this agent runs
  // Declared outputs (files or dirs this agent produces)
  outputs: string[];                 // e.g. ['docs/prd/v1.0.md']
  // Multi-step execution (user-defined, preset templates provide defaults)
  steps: AgentStep[];
  // Approval gate
  requiresApproval?: boolean;
  // Persistent terminal: keep a tmux+claude session alive, inject messages directly
  persistentSession?: boolean;
  // Bound CLI session ID for this agent (like fixedSessionId but per-agent)
  boundSessionId?: string;
  // Skip dangerous permissions check (default true when persistentSession is enabled)
  skipPermissions?: boolean;
  // Plugins: list of plugin IDs (or source IDs) this agent can use via MCP run_plugin
  plugins?: string[];
  // Watch: autonomous periodic monitoring
  watch?: WatchConfig;
}

// ─── Watch Config ─────────────────────────────────────────

export interface WatchTarget {
  type: 'directory' | 'git' | 'agent_output' | 'agent_log' | 'session' | 'command' | 'agent_status';
  path?: string;           // directory: relative path; agent_output/agent_log: agent ID
  pattern?: string;        // glob for directory, regex/keyword for agent_log, stdout pattern for command
  cmd?: string;            // shell command (type='command' only)
  contextChars?: number;   // agent_log/session: chars to capture around match (default 500)
  debounce?: number;       // seconds to wait after match before triggering (default 10)
}

export type WatchAction = 'log' | 'analyze' | 'approve' | 'send_message';

export interface WatchConfig {
  enabled: boolean;
  interval: number;        // check interval in seconds (default 60)
  targets: WatchTarget[];
  action: WatchAction;     // log=report only, analyze=auto-execute, approve=pending user approval, send_message=send to target agent
  prompt?: string;         // custom prompt for analyze action (default: "Analyze the following changes...")
  sendTo?: string;         // send_message: target agent ID
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

// ─── Agent State (Two-Layer Model) ───────────────────────

/** Smith layer: daemon lifecycle */
export type SmithStatus = 'down' | 'starting' | 'active';

/** Task layer: current work execution */
export type TaskStatus = 'idle' | 'running' | 'done' | 'failed';

/** @deprecated Use SmithStatus + TaskStatus instead */
export type AgentStatus = SmithStatus | TaskStatus | 'paused' | 'waiting_approval' | 'listening' | 'interrupted';

export interface AgentState {
  // ─── Smith layer (daemon lifecycle) ─────
  smithStatus: SmithStatus;           // down=not started, active=listening on bus

  // ─── Task layer (current work) ──────────
  taskStatus: TaskStatus;             // idle/running/done/failed

  // ─── Execution details ──────────────────
  currentStep?: number;
  history: TaskLogEntry[];
  artifacts: Artifact[];
  logFile?: string;
  lastCheckpoint?: number;
  cliSessionId?: string;
  currentMessageId?: string;          // bus message that triggered current/last task execution
  tmuxSession?: string;               // tmux session name (persistent or user-opened terminal)
  startedAt?: number;
  completedAt?: number;
  error?: string;
  daemonIteration?: number;           // how many times re-executed after initial steps
}

// ─── Daemon Wake Reason ──────────────────────────────────

export type DaemonWakeReason =
  | { type: 'abort' }
  | { type: 'bus_message'; messages: TaskLogEntry[] }
  | { type: 'upstream_changed'; agentId: string; files: string[] }
  | { type: 'input_changed'; content: string }
  | { type: 'user_message'; content: string };

// ─── Artifact ────────────────────────────────────────────

export interface Artifact {
  type: 'file' | 'text';
  path?: string;
  summary?: string;
}

// ─── Bus Message ─────────────────────────────────────────

export type MessageCategory = 'notification' | 'ticket';

export type TicketStatus = 'open' | 'in_progress' | 'fixed' | 'verified' | 'closed';

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
    ref?: string;                    // path to request/response document (reference-based notification)
  };
  timestamp: number;
  // Delivery tracking
  status?: 'pending' | 'pending_approval' | 'running' | 'done' | 'failed';
  retries?: number;
  // Message classification
  category?: MessageCategory;        // 'notification' (default, follows DAG) | 'ticket' (1-to-1, ignores DAG)
  // Causal chain — which inbox message triggered this outbox message
  causedBy?: {
    messageId: string;               // the inbox message being processed
    from: string;                    // who sent that inbox message
    to: string;                      // who received it (this agent)
  };
  // Ticket lifecycle (only for category='ticket')
  ticketStatus?: TicketStatus;
  ticketRetries?: number;            // how many times this ticket has been retried
  maxRetries?: number;               // configurable limit (default 3)
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
  /** Workspace ID — injected as env var for forge skills */
  workspaceId?: string;
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
  | { type: 'smith_status'; agentId: string; smithStatus: SmithStatus }
  | { type: 'task_status'; agentId: string; taskStatus: TaskStatus; error?: string }
  | { type: 'log'; agentId: string; entry: TaskLogEntry }
  | { type: 'step'; agentId: string; stepIndex: number; stepLabel: string }
  | { type: 'artifact'; agentId: string; artifact: Artifact }
  | { type: 'agents_changed'; agents: WorkspaceAgentConfig[]; agentStates?: Record<string, AgentState> }
  | { type: 'done'; agentId: string; summary: string }
  | { type: 'error'; agentId: string; error: string };
