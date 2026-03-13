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

export interface ObsidianConfig {
  autoSave: 'false' | 'manual' | 'milestone' | 'always' | 'smart';
  saveTarget?: string;
  saveFormat?: 'append' | 'new_file' | 'replace';
  readPaths?: string[];
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
    obsidianPaths?: string[];
  };
  obsidian?: ObsidianConfig;
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

export interface Task {
  id: string;
  projectName: string;
  projectPath: string;
  prompt: string;
  status: TaskStatus;
  priority: number;
  conversationId?: string;
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
}

export interface TaskLogEntry {
  type: 'system' | 'assistant' | 'result';
  subtype?: string;
  content: string;
  tool?: string;
  timestamp: string;
}

export interface AppConfig {
  dataDir: string;
  providers: Record<ProviderName, ProviderConfig>;
  obsidian?: {
    vaultPath: string;
  };
  server: {
    host: string;
    port: number;
  };
}
