/**
 * Workspace Agent System — public API.
 */

// Types
export type {
  WorkspaceAgentConfig,
  AgentBackendType,
  AgentStep,
  AgentStatus,
  AgentState,
  Artifact,
  BusMessage,
  WorkspaceState,
  AgentBackend,
  StepExecutionParams,
  StepExecutionResult,
  WorkerEvent,
} from './types';

// Core
export { AgentWorker, type AgentWorkerOptions } from './agent-worker';
export { AgentBus } from './agent-bus';
export { WorkspaceOrchestrator, type OrchestratorEvent } from './orchestrator';

// Backends
export { ApiBackend } from './backends/api-backend';
export { CliBackend } from './backends/cli-backend';

// Presets
export { AGENT_PRESETS, createDeliveryPipeline, createFromPreset } from './presets';

// Manager (singleton orchestrator cache + SSE)
export {
  getOrchestrator,
  createOrchestratorFromState,
  getOrchestratorByProject,
  subscribeSSE,
  shutdownOrchestrator,
  shutdownAll,
} from './manager';

// Persistence
export {
  saveWorkspace,
  loadWorkspace,
  listWorkspaces,
  findWorkspaceByProject,
  deleteWorkspace,
  readAgentLog,
  readAgentLogTail,
  appendAgentLog,
  startAutoSave,
  stopAutoSave,
  type WorkspaceSummary,
} from './persistence';

// Smith Memory
export {
  loadMemory,
  saveMemory,
  createMemory,
  addObservation,
  addSessionSummary,
  formatMemoryForPrompt,
  formatMemoryForDisplay,
  getMemoryStats,
  parseStepToObservations,
  buildSessionSummary,
  type SmithMemory,
  type Observation,
  type ObservationType,
  type SessionSummary,
  type MemoryDisplayEntry,
} from './smith-memory';
