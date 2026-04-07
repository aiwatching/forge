/**
 * Claude Code Process Manager
 *
 * Uses `claude -p --verbose --output-format stream-json` for structured output.
 * Runs on your Claude Code subscription, not API key.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { loadSettings } from './settings';

export interface ClaudeMessage {
  type: 'system' | 'assistant' | 'result';
  subtype?: string;    // e.g. 'tool_use', 'text', 'init'
  content: string;
  tool?: string;       // tool name if tool_use
  costUSD?: number;
  sessionId?: string;
  timestamp: string;
}

export interface ClaudeProcess {
  id: string;
  projectName: string;
  projectPath: string;
  status: 'running' | 'idle' | 'exited';
  createdAt: string;
  messages: ClaudeMessage[];
  conversationId?: string;
}

interface ManagedProcess {
  info: ClaudeProcess;
  child: ChildProcess | null;
  listeners: Set<(msg: ClaudeMessage) => void>;
}

const processes = new Map<string, ManagedProcess>();

/**
 * Create a new Claude Code session for a project.
 */
export function createClaudeSession(projectName: string, projectPath: string): ClaudeProcess {
  const id = `claude-${projectName}-${Date.now().toString(36)}`;

  const info: ClaudeProcess = {
    id,
    projectName,
    projectPath,
    status: 'idle',
    createdAt: new Date().toISOString(),
    messages: [],
  };

  const managed: ManagedProcess = {
    info,
    child: null,
    listeners: new Set(),
  };

  processes.set(id, managed);
  return info;
}

/**
 * Send a message to Claude Code and stream the response.
 */
export function sendToClaudeSession(
  id: string,
  message: string,
  conversationId?: string
): boolean {
  const managed = processes.get(id);
  if (!managed) return false;
  if (managed.info.status === 'running') return false; // Already processing

  const settings = loadSettings();
  const claudePath = settings.claudePath || process.env.CLAUDE_PATH || 'claude';

  // Build command args — --verbose is required for stream-json
  const args = ['-p', '--verbose', '--output-format', 'stream-json'];

  // Continue conversation if we have a session ID
  const continueId = conversationId || managed.info.conversationId;
  if (continueId) {
    args.push('--resume', continueId);
  }

  // Message goes last
  args.push(message);

  // Remove CLAUDECODE env var to avoid nesting detection
  const env = { ...process.env };
  delete env.CLAUDECODE;

  const child = spawn(claudePath, args, {
    cwd: managed.info.projectPath,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  managed.child = child;
  managed.info.status = 'running';

  // Add user message
  const userMsg: ClaudeMessage = {
    type: 'system',
    subtype: 'user_input',
    content: message,
    timestamp: new Date().toISOString(),
  };
  managed.info.messages.push(userMsg);
  broadcast(managed, userMsg);

  let buffer = '';

  child.stdout?.on('data', (data: Buffer) => {
    buffer += data.toString();
    // stream-json outputs one JSON object per line
    const lines = buffer.split('\n');
    buffer = lines.pop() || ''; // Keep incomplete line in buffer

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        const messages = parseClaudeOutput(parsed);
        for (const msg of messages) {
          managed.info.messages.push(msg);

          // Capture session ID for conversation continuity
          if (parsed.session_id && !managed.info.conversationId) {
            managed.info.conversationId = parsed.session_id;
          }

          broadcast(managed, msg);
        }
      } catch {
        // Non-JSON line, treat as text
        const msg: ClaudeMessage = {
          type: 'assistant',
          subtype: 'text',
          content: line,
          timestamp: new Date().toISOString(),
        };
        managed.info.messages.push(msg);
        broadcast(managed, msg);
      }
    }
  });

  child.stderr?.on('data', (data: Buffer) => {
    const text = data.toString().trim();
    if (!text) return;
    const msg: ClaudeMessage = {
      type: 'system',
      subtype: 'error',
      content: text,
      timestamp: new Date().toISOString(),
    };
    managed.info.messages.push(msg);
    broadcast(managed, msg);
  });

  child.on('exit', (code) => {
    // Process remaining buffer
    if (buffer.trim()) {
      try {
        const parsed = JSON.parse(buffer);
        const messages = parseClaudeOutput(parsed);
        for (const msg of messages) {
          managed.info.messages.push(msg);
          broadcast(managed, msg);
        }
      } catch {}
      buffer = '';
    }

    managed.info.status = 'idle';
    managed.child = null;

    const msg: ClaudeMessage = {
      type: 'system',
      subtype: 'complete',
      content: `Done (exit ${code})`,
      timestamp: new Date().toISOString(),
    };
    managed.info.messages.push(msg);
    broadcast(managed, msg);
  });

  return true;
}

/**
 * Parse actual claude stream-json output into ClaudeMessage(s).
 *
 * Real format examples:
 * - {type: "system", subtype: "init", session_id: "...", model: "...", ...}
 * - {type: "assistant", message: {content: [{type: "text", text: "..."}, {type: "tool_use", name: "...", input: {...}}]}, session_id: "..."}
 * - {type: "result", subtype: "success", result: "...", total_cost_usd: 0.06, session_id: "..."}
 */
function parseClaudeOutput(parsed: any): ClaudeMessage[] {
  const msgs: ClaudeMessage[] = [];
  const ts = new Date().toISOString();

  // System init message
  if (parsed.type === 'system' && parsed.subtype === 'init') {
    msgs.push({
      type: 'system',
      subtype: 'init',
      content: `Model: ${parsed.model || 'unknown'}`,
      sessionId: parsed.session_id,
      timestamp: ts,
    });
    return msgs;
  }

  // Assistant message — contains content array with text and tool_use blocks
  if (parsed.type === 'assistant' && parsed.message?.content) {
    const content = parsed.message.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'text' && block.text) {
          msgs.push({
            type: 'assistant',
            subtype: 'text',
            content: block.text,
            sessionId: parsed.session_id,
            timestamp: ts,
          });
        } else if (block.type === 'tool_use') {
          msgs.push({
            type: 'assistant',
            subtype: 'tool_use',
            content: typeof block.input === 'string'
              ? block.input
              : JSON.stringify(block.input || {}),
            tool: block.name,
            sessionId: parsed.session_id,
            timestamp: ts,
          });
        } else if (block.type === 'tool_result') {
          msgs.push({
            type: 'assistant',
            subtype: 'tool_result',
            content: typeof block.content === 'string'
              ? block.content
              : JSON.stringify(block.content || ''),
            tool: block.tool_use_id,
            sessionId: parsed.session_id,
            timestamp: ts,
          });
        }
      }
    }
    return msgs;
  }

  // Result message
  if (parsed.type === 'result') {
    msgs.push({
      type: 'result',
      subtype: parsed.subtype || 'success',
      content: typeof parsed.result === 'string'
        ? parsed.result
        : JSON.stringify(parsed.result || ''),
      costUSD: parsed.total_cost_usd,
      sessionId: parsed.session_id,
      timestamp: ts,
    });
    return msgs;
  }

  // Skip rate_limit_event and other internal events silently
  if (parsed.type === 'rate_limit_event') {
    return msgs;
  }

  // Generic fallback — still show it
  msgs.push({
    type: 'assistant',
    subtype: parsed.type || 'unknown',
    content: JSON.stringify(parsed),
    timestamp: ts,
  });
  return msgs;
}

function broadcast(managed: ManagedProcess, msg: ClaudeMessage) {
  for (const listener of managed.listeners) {
    try { listener(msg); } catch {}
  }
}

/**
 * Attach a listener to receive messages from a Claude session.
 */
export function attachToProcess(id: string, onMessage: (msg: ClaudeMessage) => void): (() => void) | null {
  const managed = processes.get(id);
  if (!managed) return null;

  // Send history first
  for (const msg of managed.info.messages) {
    onMessage(msg);
  }

  managed.listeners.add(onMessage);
  return () => { managed.listeners.delete(onMessage); };
}

/**
 * Kill current running command (not the session).
 */
export function killProcess(id: string): boolean {
  const managed = processes.get(id);
  if (!managed) return false;
  if (managed.child) {
    managed.child.kill('SIGTERM');
    managed.info.status = 'idle';
  }
  return true;
}

/**
 * Delete a session entirely.
 */
export function deleteSession(id: string): boolean {
  const managed = processes.get(id);
  if (!managed) return false;
  if (managed.child) managed.child.kill('SIGTERM');
  processes.delete(id);
  return true;
}

/**
 * List all sessions.
 */
export function listProcesses(): ClaudeProcess[] {
  return Array.from(processes.values()).map(m => ({
    ...m.info,
    messages: [], // Don't send full history in list
  }));
}

/**
 * Get a single session.
 */
export function getProcess(id: string): ClaudeProcess | null {
  const managed = processes.get(id);
  return managed?.info || null;
}
