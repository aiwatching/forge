/**
 * Claude Sessions — read Claude Code's on-disk session JSONL files.
 * Enables live-tailing of local CLI sessions from the web UI.
 */

import { existsSync, readFileSync, statSync, readdirSync, watch, openSync, readSync, closeSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { getProjectInfo } from './projects';

export interface ClaudeSessionInfo {
  sessionId: string;
  summary?: string;
  firstPrompt?: string;
  messageCount?: number;
  created?: string;
  modified?: string;
  gitBranch?: string;
  fileSize: number;
}

export interface SessionEntry {
  type: 'user' | 'assistant_text' | 'tool_use' | 'tool_result' | 'thinking' | 'system';
  content: string;
  toolName?: string;
  model?: string;
  timestamp?: string;
}

/**
 * Convert a project path to the Claude projects directory.
 * Claude uses: ~/.claude/projects/<path-with-slashes-replaced-by-dashes>/
 */
export function projectPathToClaudeDir(projectPath: string): string {
  const hash = projectPath.replace(/\//g, '-');
  return join(homedir(), '.claude', 'projects', hash);
}

/**
 * Get the Claude sessions directory for a project by name.
 */
export function getClaudeDirForProject(projectName: string): string | null {
  const project = getProjectInfo(projectName);
  if (!project) return null;
  const dir = projectPathToClaudeDir(project.path);
  return existsSync(dir) ? dir : null;
}

/**
 * List all sessions for a project.
 */
export function listClaudeSessions(projectName: string): ClaudeSessionInfo[] {
  const dir = getClaudeDirForProject(projectName);
  if (!dir) return [];

  // Try reading sessions-index.json first
  const indexPath = join(dir, 'sessions-index.json');
  if (existsSync(indexPath)) {
    try {
      const index = JSON.parse(readFileSync(indexPath, 'utf-8'));
      const sessions: ClaudeSessionInfo[] = (index.entries || []).map((e: any) => ({
        sessionId: e.sessionId,
        summary: e.summary,
        firstPrompt: e.firstPrompt,
        messageCount: e.messageCount,
        created: e.created,
        modified: e.modified,
        gitBranch: e.gitBranch,
        fileSize: 0,
      }));

      // Enrich with file size
      for (const s of sessions) {
        const fp = join(dir, `${s.sessionId}.jsonl`);
        try { s.fileSize = statSync(fp).size; } catch {}
      }

      return sessions.sort((a, b) => (b.modified || '').localeCompare(a.modified || ''));
    } catch {}
  }

  // Fallback: scan for .jsonl files
  try {
    const files = readdirSync(dir).filter(f => f.endsWith('.jsonl'));
    return files.map(f => {
      const sessionId = f.replace('.jsonl', '');
      const fp = join(dir, f);
      const stat = statSync(fp);
      return {
        sessionId,
        fileSize: stat.size,
        modified: stat.mtime.toISOString(),
        created: stat.birthtime.toISOString(),
      };
    }).sort((a, b) => (b.modified || '').localeCompare(a.modified || ''));
  } catch {
    return [];
  }
}

/**
 * Parse a single JSONL line into displayable SessionEntry items.
 * One JSONL line can produce multiple entries (e.g., assistant message with text + tool_use).
 */
export function parseSessionLine(line: string): SessionEntry[] {
  try {
    const obj = JSON.parse(line);
    const entries: SessionEntry[] = [];
    const ts = obj.timestamp;

    // Skip internal types
    if (obj.type === 'queue-operation' || obj.type === 'last-prompt' || obj.type === 'rate_limit_event') {
      return [];
    }

    // User message
    if (obj.type === 'user' && obj.message) {
      const content = typeof obj.message.content === 'string'
        ? obj.message.content
        : JSON.stringify(obj.message.content);
      entries.push({ type: 'user', content, timestamp: ts });
      return entries;
    }

    // Assistant message — can contain multiple content blocks
    if (obj.type === 'assistant' && obj.message?.content) {
      const model = obj.message.model;
      for (const block of obj.message.content) {
        if (block.type === 'thinking' && block.thinking) {
          entries.push({ type: 'thinking', content: block.thinking, model, timestamp: ts });
        } else if (block.type === 'text' && block.text) {
          entries.push({ type: 'assistant_text', content: block.text, model, timestamp: ts });
        } else if (block.type === 'tool_use') {
          entries.push({
            type: 'tool_use',
            content: JSON.stringify(block.input || {}, null, 2),
            toolName: block.name,
            model,
            timestamp: ts,
          });
        } else if (block.type === 'tool_result') {
          const resultContent = typeof block.content === 'string'
            ? block.content
            : JSON.stringify(block.content);
          entries.push({ type: 'tool_result', content: resultContent, timestamp: ts });
        }
      }
      return entries;
    }

    // Tool result message (separate line)
    if (obj.type === 'tool_result' && obj.message?.content) {
      for (const block of obj.message.content) {
        if (block.type === 'tool_result') {
          const content = typeof block.content === 'string'
            ? block.content
            : JSON.stringify(block.content);
          entries.push({ type: 'tool_result', content, timestamp: ts });
        }
      }
      return entries;
    }

    // System messages
    if (obj.type === 'system') {
      entries.push({ type: 'system', content: obj.content || JSON.stringify(obj), timestamp: ts });
      return entries;
    }

    return entries;
  } catch {
    return [];
  }
}

/**
 * Get the JSONL file path for a session.
 */
export function getSessionFilePath(projectName: string, sessionId: string): string | null {
  const dir = getClaudeDirForProject(projectName);
  if (!dir) return null;
  const fp = join(dir, `${sessionId}.jsonl`);
  return existsSync(fp) ? fp : null;
}

/**
 * Read all entries from a session file.
 */
export function readSessionEntries(filePath: string): SessionEntry[] {
  const content = readFileSync(filePath, 'utf-8');
  const entries: SessionEntry[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    entries.push(...parseSessionLine(line));
  }
  return entries;
}

/**
 * Delete a session file and its cache entry.
 */
export function deleteSession(projectName: string, sessionId: string): boolean {
  const dir = getClaudeDirForProject(projectName);
  if (!dir) return false;
  const fp = join(dir, `${sessionId}.jsonl`);
  if (!existsSync(fp)) return false;
  unlinkSync(fp);
  return true;
}

/**
 * Tail a session file — calls onNewEntries when new lines are appended.
 * Returns a cleanup function.
 */
export function tailSessionFile(
  filePath: string,
  onNewEntries: (entries: SessionEntry[], raw: string) => void,
  onError?: (err: Error) => void,
): () => void {
  let bytesRead = 0;

  try {
    bytesRead = statSync(filePath).size;
  } catch {}

  const readNewBytes = () => {
    try {
      const stat = statSync(filePath);
      if (stat.size <= bytesRead) return;

      const fd = openSync(filePath, 'r');
      const buf = Buffer.alloc(stat.size - bytesRead);
      readSync(fd, buf, 0, buf.length, bytesRead);
      closeSync(fd);
      bytesRead = stat.size;

      const newText = buf.toString('utf-8');
      const lines = newText.split('\n').filter(l => l.trim());
      const entries: SessionEntry[] = [];
      for (const line of lines) {
        entries.push(...parseSessionLine(line));
      }
      if (entries.length > 0) {
        onNewEntries(entries, newText);
      }
    } catch (err) {
      onError?.(err as Error);
    }
  };

  // Use both fs.watch AND polling as fallback (fs.watch is unreliable on macOS)
  const watcher = watch(filePath, (eventType) => {
    if (eventType === 'change') {
      readNewBytes();
    }
  });

  watcher.on('error', (err) => onError?.(err));

  // Poll every 5 seconds as fallback
  const pollTimer = setInterval(readNewBytes, 5000);

  return () => {
    watcher.close();
    clearInterval(pollTimer);
  };
}
