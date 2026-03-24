/**
 * Agent types — shared interfaces for multi-agent support.
 */

export type AgentId = string; // 'claude' | 'codex' | 'aider' | custom

export interface AgentCapabilities {
  supportsResume: boolean;          // -c / --resume (continue session)
  supportsStreamJson: boolean;      // structured output parsing
  supportsModel: boolean;           // --model flag
  supportsSkipPermissions: boolean; // --dangerously-skip-permissions or equivalent
  hasSessionFiles: boolean;         // on-disk session files (JSONL etc.)
}

export interface AgentConfig {
  id: AgentId;
  name: string;             // display name: "Claude Code", "OpenAI Codex", "Aider"
  path: string;             // binary path
  enabled: boolean;
  type: 'claude-code' | 'generic'; // adapter type
  flags?: string[];         // extra CLI flags
  capabilities: AgentCapabilities;
  version?: string;
  skipPermissionsFlag?: string; // e.g., "--dangerously-skip-permissions", "--full-auto"
}

export interface AgentSpawnOptions {
  projectPath: string;
  prompt: string;
  model?: string;
  conversationId?: string;  // for resume
  skipPermissions?: boolean;
  outputFormat?: 'stream-json' | 'json' | 'text';
  extraFlags?: string[];
}

export interface AgentSpawnResult {
  cmd: string;
  args: string[];
  env?: Record<string, string>;
}

export interface AgentAdapter {
  id: AgentId;
  config: AgentConfig;

  /** Build spawn command + args for non-interactive task execution */
  buildTaskSpawn(opts: AgentSpawnOptions): AgentSpawnResult;

  /** Build the terminal command string (e.g., "cd /path && claude -c") */
  buildTerminalCommand(opts: {
    projectPath: string;
    resume?: boolean;
    sessionId?: string;
    skipPermissions?: boolean;
  }): string;

  /** Parse a line of output into normalized events (for stream-json agents) */
  parseOutputLine?(line: string): any[];
}
