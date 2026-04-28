export type MemoryStrategy = 'none' | 'sliding_window' | 'full' | 'full_with_summary' | 'external';

export type SessionStatus = 'running' | 'idle' | 'paused' | 'archived' | 'error';

export type ProviderName = 'anthropic' | 'google' | 'openai' | 'grok';

export interface ProviderConfig {
  name: ProviderName;
  displayName: string;
  apiKey?: string;
  defaultModel: string;
  models: string[];
  enabled: boolean;
}

export interface MemoryConfig {
  strategy: MemoryStrategy;
  windowSize?: number;       // for sliding_window
  compressAfter?: number;    // for full — compress after N messages
  summaryModel?: string;     // model to use for summarization
}

export interface SessionTemplate {
  id: string;
  name: string;
  description: string;
  provider: ProviderName;
  model?: string;
  fallbackProvider?: ProviderName;
  memory: MemoryConfig;
  systemPrompt: string;
  context?: {
    files?: string[];
  };
  commands?: Record<string, { description: string; action: string; prompt?: string }>;
  ui?: {
    icon?: string;
    color?: string;
    pinned?: boolean;
  };
}

export interface Message {
  id: number;
  sessionId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  provider: ProviderName;
  model: string;
  tokenCount?: number;
  createdAt: string;
}

export interface Session {
  id: string;
  name: string;
  templateId: string;
  provider: ProviderName;
  model: string;
  status: SessionStatus;
  memory: MemoryConfig;
  systemPrompt: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
  lastMessage?: string;
}

export interface UsageRecord {
  provider: ProviderName;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  date: string;
}

export type TaskStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
export type TaskMode = 'prompt' | 'monitor' | 'shell';

export interface WatchConfig {
  condition: 'change' | 'idle' | 'complete' | 'error' | 'keyword';
  keyword?: string;          // for 'keyword' condition
  idleMinutes?: number;      // for 'idle' condition (default 10)
  action: 'notify' | 'message' | 'task';
  actionPrompt?: string;     // message to send or task prompt
  actionProject?: string;    // for 'task' action
  repeat?: boolean;          // keep watching after trigger (default false)
  notifyIntervalSeconds?: number; // min seconds between notifications (default 60)
}

export interface Task {
  id: string;
  projectName: string;
  projectPath: string;
  prompt: string;
  mode: TaskMode;
  status: TaskStatus;
  priority: number;
  conversationId?: string;
  watchConfig?: WatchConfig;
  log: TaskLogEntry[];
  resultSummary?: string;
  gitDiff?: string;
  gitBranch?: string;
  costUSD?: number;
  error?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  scheduledAt?: string;
  agent?: string;
  // Lite-list metadata: present in /api/tasks responses, undefined in detail
  logSize?: number;
  hasGitDiff?: boolean;
}

export interface TaskLogEntry {
  type: 'system' | 'assistant' | 'result';
  subtype?: string;
  content: string;
  tool?: string;
  timestamp: string;
  // Slice-API metadata (server adds these when serving a truncated chunk)
  _index?: number;
  _truncated?: number;   // original content.length before truncation
}

export interface AppConfig {
  dataDir: string;
  providers: Record<ProviderName, ProviderConfig>;
  server: {
    host: string;
    port: number;
  };
}
