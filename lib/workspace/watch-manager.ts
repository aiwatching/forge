/**
 * WatchManager — autonomous periodic monitoring for workspace agents.
 *
 * Fully independent from message bus / worker / state management.
 * Detects file changes, git diffs, agent outputs, or custom commands.
 * Writes results to agent log + emits SSE events. Never sends messages.
 */

import { EventEmitter } from 'node:events';
import { existsSync, readdirSync, statSync, readFileSync, openSync, readSync, fstatSync, closeSync } from 'node:fs';
import { join, relative } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';
import type { WorkspaceAgentConfig, WatchTarget, WatchConfig } from './types';
import { appendAgentLog } from './persistence';

// ─── Snapshot types ──────────────────────────────────────

interface WatchSnapshot {
  lastCheckTime: number;   // timestamp ms — only files modified after this are "changed"
  gitHash?: string;
  commandOutput?: string;
  logLineCount?: number;   // last known line count in agent's logs.jsonl
  sessionFileSize?: number; // last known file size of session JSONL (bytes)
}

interface WatchChange {
  targetType: WatchTarget['type'];
  description: string;
  files: string[];
}

// ─── Detection functions ─────────────────────────────────

/** Find files modified after `since` timestamp in a directory */
function findModifiedFiles(dir: string, since: number, pattern?: string, maxDepth = 3): string[] {
  const modified: string[] = [];
  if (!existsSync(dir)) return modified;

  const globMatch = pattern
    ? (name: string) => {
        if (pattern.startsWith('*.')) return name.endsWith(pattern.slice(1));
        return name.includes(pattern);
      }
    : () => true;

  function walk(current: string, depth: number) {
    if (depth > maxDepth) return;
    try {
      for (const entry of readdirSync(current)) {
        if (entry.startsWith('.') || entry === 'node_modules') continue;
        const full = join(current, entry);
        try {
          const st = statSync(full);
          if (st.isDirectory()) {
            walk(full, depth + 1);
          } else if (globMatch(entry) && st.mtimeMs > since) {
            modified.push(relative(dir, full));
          }
        } catch {}
      }
    } catch {}
  }

  walk(dir, 0);
  return modified;
}

function detectDirectoryChanges(projectPath: string, target: WatchTarget, since: number): { changes: WatchChange | null } {
  const dir = join(projectPath, target.path || '.');
  const files = findModifiedFiles(dir, since, target.pattern);

  if (files.length === 0) return { changes: null };

  return {
    changes: {
      targetType: 'directory',
      description: `${target.path || '.'}: ${files.length} file(s) changed`,
      files: files.slice(0, 20),
    },
  };
}

function detectGitChanges(projectPath: string, prevHash?: string): { changes: WatchChange | null; gitHash: string } {
  try {
    const hash = execSync('git rev-parse HEAD', { cwd: projectPath, timeout: 5000 }).toString().trim();
    if (hash === prevHash) return { changes: null, gitHash: hash };

    // Get diff summary
    let diffStat = '';
    try {
      const cmd = prevHash ? `git diff --stat ${prevHash}..${hash}` : 'git diff --stat HEAD~1';
      diffStat = execSync(cmd, { cwd: projectPath, timeout: 5000 }).toString().trim();
    } catch {}

    const files = diffStat.split('\n')
      .filter(l => l.includes('|'))
      .map(l => l.trim().split(/\s+\|/)[0].trim())
      .slice(0, 20);

    return {
      changes: {
        targetType: 'git',
        description: `New commit ${hash.slice(0, 8)}${files.length ? `: ${files.length} files changed` : ''}`,
        files,
      },
      gitHash: hash,
    };
  } catch {
    return { changes: null, gitHash: prevHash || '' };
  }
}

function detectCommandChanges(projectPath: string, target: WatchTarget, prevOutput?: string): { changes: WatchChange | null; commandOutput: string } {
  if (!target.cmd) return { changes: null, commandOutput: prevOutput || '' };
  try {
    const output = execSync(target.cmd, { cwd: projectPath, timeout: 30000 }).toString().trim();
    if (output === prevOutput) return { changes: null, commandOutput: output };

    // Check pattern match if specified
    if (target.pattern && !output.includes(target.pattern)) {
      return { changes: null, commandOutput: output };
    }

    return {
      changes: {
        targetType: 'command',
        description: `Command "${target.cmd.slice(0, 40)}": output changed`,
        files: [],
      },
      commandOutput: output,
    };
  } catch {
    return { changes: null, commandOutput: prevOutput || '' };
  }
}

function detectAgentLogChanges(workspaceId: string, targetAgentId: string, pattern: string | undefined, prevLineCount: number, contextChars = 500): { changes: WatchChange | null; lineCount: number } {
  const logFile = join(homedir(), '.forge', 'workspaces', workspaceId, 'agents', targetAgentId, 'logs.jsonl');
  if (!existsSync(logFile)) return { changes: null, lineCount: 0 };

  try {
    const lines = readFileSync(logFile, 'utf-8').split('\n').filter(Boolean);
    const currentCount = lines.length;
    if (currentCount <= prevLineCount) return { changes: null, lineCount: currentCount };

    // Get new lines since last check
    const newLines = lines.slice(prevLineCount);
    const newEntries: string[] = [];

    // Build matcher: try regex first, fallback to case-insensitive includes
    let matcher: ((text: string) => boolean) | null = null;
    if (pattern) {
      try {
        const re = new RegExp(pattern, 'i');
        matcher = (text: string) => re.test(text);
      } catch {
        const lower = pattern.toLowerCase();
        matcher = (text: string) => text.toLowerCase().includes(lower);
      }
    }

    // Extract content around match (contextChars before + after match point)
    const extractContext = (text: string): string => {
      if (!pattern || text.length <= contextChars) return text.slice(0, contextChars);
      // Find match position for context window
      let matchIdx = 0;
      try {
        const re = new RegExp(pattern, 'i');
        const m = re.exec(text);
        if (m) matchIdx = m.index;
      } catch {
        matchIdx = text.toLowerCase().indexOf(pattern.toLowerCase());
        if (matchIdx === -1) matchIdx = 0;
      }
      const half = Math.floor(contextChars / 2);
      const start = Math.max(0, matchIdx - half);
      const end = Math.min(text.length, start + contextChars);
      return (start > 0 ? '...' : '') + text.slice(start, end) + (end < text.length ? '...' : '');
    };

    for (const line of newLines) {
      try {
        const entry = JSON.parse(line);
        const content = entry.content || '';
        if (matcher && !matcher(content)) continue;
        newEntries.push(extractContext(content));
      } catch {
        if (matcher && !matcher(line)) continue;
        newEntries.push(extractContext(line));
      }
    }

    if (newEntries.length === 0) return { changes: null, lineCount: currentCount };

    return {
      changes: {
        targetType: 'agent_log',
        description: `${newEntries.length} new log entries${pattern ? ` matching "${pattern}"` : ''}`,
        files: newEntries.slice(0, 10),
      },
      lineCount: currentCount,
    };
  } catch {
    return { changes: null, lineCount: prevLineCount };
  }
}

function detectSessionChanges(projectPath: string, pattern: string | undefined, prevLineCount: number, contextChars = 500, sessionId?: string): { changes: WatchChange | null; lineCount: number } {
  // Find session file for this project
  const claudeHome = join(homedir(), '.claude', 'projects');
  const encoded = projectPath.replace(/\//g, '-');
  const sessionDir = join(claudeHome, encoded);
  if (!existsSync(sessionDir)) return { changes: null, lineCount: prevLineCount };

  try {
    let latestFile: string;

    if (sessionId) {
      // Use specific session ID
      latestFile = join(sessionDir, `${sessionId}.jsonl`);
      if (!existsSync(latestFile)) return { changes: null, lineCount: prevLineCount };
    } else {
      // Find most recently modified .jsonl file
      const files = readdirSync(sessionDir)
        .filter(f => f.endsWith('.jsonl'))
        .map(f => ({ name: f, mtime: statSync(join(sessionDir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
      if (files.length === 0) return { changes: null, lineCount: prevLineCount };
      latestFile = join(sessionDir, files[0].name);
    }
    // Only read new bytes since last check (efficient for large 70MB+ files)
    const fd = openSync(latestFile, 'r');
    const fileSize = fstatSync(fd).size;
    if (fileSize <= prevLineCount) { closeSync(fd); return { changes: null, lineCount: fileSize }; }

    const readFrom = Math.max(0, prevLineCount > 0 ? prevLineCount - 1 : 0);
    const readSize = Math.min(fileSize - readFrom, 500_000); // max 500KB per check
    const buf = Buffer.alloc(readSize);
    readSync(fd, buf, 0, readSize, readFrom);
    closeSync(fd);

    const tail = buf.toString('utf-8');
    const newLines = tail.split('\n').filter(Boolean);
    if (prevLineCount > 0 && newLines.length > 0) newLines.shift(); // skip partial first line

    // Build matcher
    let matcher: ((text: string) => boolean) | null = null;
    if (pattern) {
      try {
        const re = new RegExp(pattern, 'i');
        matcher = (text: string) => re.test(text);
      } catch {
        const lower = pattern.toLowerCase();
        matcher = (text: string) => text.toLowerCase().includes(lower);
      }
    }

    // Only extract the LAST assistant/result text (not all entries)
    const entries: string[] = [];
    for (const line of [...newLines].reverse()) {
      try {
        const parsed = JSON.parse(line);
        let text = '';
        if (parsed.type === 'assistant' && parsed.message?.content) {
          for (const block of (Array.isArray(parsed.message.content) ? parsed.message.content : [parsed.message.content])) {
            if (typeof block === 'string') text += block;
            else if (block.type === 'text' && block.text) text += block.text;
          }
        } else if (parsed.type === 'result' && parsed.result) {
          text = typeof parsed.result === 'string' ? parsed.result : JSON.stringify(parsed.result);
        } else if (parsed.type === 'human' || parsed.type === 'user') {
          const content = parsed.content || parsed.message?.content;
          text = typeof content === 'string' ? content : '';
        }

        if (!text) continue;
        if (matcher && !matcher(text)) continue;

        // Context extraction around match
        if (text.length > contextChars && pattern) {
          let matchIdx = 0;
          try { matchIdx = new RegExp(pattern, 'i').exec(text)?.index || 0; } catch {}
          const half = Math.floor(contextChars / 2);
          const start = Math.max(0, matchIdx - half);
          const end = Math.min(text.length, start + contextChars);
          text = (start > 0 ? '...' : '') + text.slice(start, end) + (end < text.length ? '...' : '');
        } else {
          text = text.slice(0, contextChars);
        }
        entries.push(text);
        break; // only take the last matching entry (we're scanning in reverse)
      } catch {}
    }

    if (entries.length === 0) return { changes: null, lineCount: fileSize };

    return {
      changes: {
        targetType: 'session',
        description: `${entries.length} new session entries${pattern ? ` matching "${pattern}"` : ''}`,
        files: entries.slice(0, 10),
      },
      lineCount: fileSize, // actually bytes, reusing field name
    };
  } catch {
    return { changes: null, lineCount: prevLineCount };
  }
}

// ─── WatchManager class ──────────────────────────────────

export class WatchManager extends EventEmitter {
  private timers = new Map<string, NodeJS.Timeout>();
  private snapshots = new Map<string, WatchSnapshot>();
  private pendingAlert = new Map<string, { changes: WatchChange[]; summary: string; timestamp: number }>();
  private debounceTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private workspaceId: string,
    private projectPath: string,
    private getAgents: () => Map<string, { config: WorkspaceAgentConfig; state: { smithStatus: string; taskStatus: string; mode: string } }>,
  ) {
    super();
  }

  /** Start watch loops for all agents with watch config */
  start(): void {
    for (const [id, entry] of this.getAgents()) {
      if (entry.config.watch?.enabled) {
        this.startWatch(id, entry.config);
      }
    }
  }

  /** Stop all watch loops */
  stop(): void {
    for (const [id, timer] of this.timers) {
      clearInterval(timer);
    }
    this.timers.clear();
    console.log(`[watch] All watch loops stopped`);
  }

  /** Start/restart watch for a specific agent */
  startWatch(agentId: string, config: WorkspaceAgentConfig): void {
    this.stopWatch(agentId);
    if (!config.watch?.enabled || config.watch.targets.length === 0) return;

    const interval = Math.max(config.watch.interval || 60, 10) * 1000; // min 10s
    console.log(`[watch] ${config.label}: started (interval=${interval / 1000}s, targets=${config.watch.targets.length})`);

    // Initialize snapshot on first run (don't alert on existing state)
    this.runCheck(agentId, config, true);

    const timer = setInterval(() => {
      const agents = this.getAgents();
      const entry = agents.get(agentId);
      if (!entry || entry.state.smithStatus !== 'active') return;
      // Skip if agent is busy
      if (entry.state.taskStatus === 'running') return;

      this.runCheck(agentId, config, false);
    }, interval);

    timer.unref();
    this.timers.set(agentId, timer);
  }

  /** Stop watch for a specific agent */
  stopWatch(agentId: string): void {
    const timer = this.timers.get(agentId);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(agentId);
    }
  }

  /** Run a single check cycle */
  private runCheck(agentId: string, config: WorkspaceAgentConfig, initialRun: boolean): void {
    const now = Date.now();
    const prev = this.snapshots.get(agentId) || { lastCheckTime: now };
    const allChanges: WatchChange[] = [];
    const newSnapshot: WatchSnapshot = { lastCheckTime: now };

    for (const target of config.watch!.targets) {
      switch (target.type) {
        case 'directory': {
          const { changes } = detectDirectoryChanges(this.projectPath, target, prev.lastCheckTime);
          if (changes) allChanges.push(changes);
          break;
        }
        case 'git': {
          const { changes, gitHash } = detectGitChanges(this.projectPath, prev.gitHash);
          newSnapshot.gitHash = gitHash;
          if (changes) allChanges.push(changes);
          break;
        }
        case 'agent_output': {
          const agents = this.getAgents();
          const targetAgent = target.path ? agents.get(target.path) : null;
          if (targetAgent) {
            for (const outputPath of targetAgent.config.outputs) {
              const { changes } = detectDirectoryChanges(this.projectPath, { ...target, path: outputPath }, prev.lastCheckTime);
              if (changes) allChanges.push({ ...changes, targetType: 'agent_output', description: `${targetAgent.config.label} output: ${changes.description}` });
            }
          }
          break;
        }
        case 'agent_log': {
          if (target.path) {
            const agentLabel = this.getAgents().get(target.path)?.config.label || target.path;
            const { changes, lineCount } = detectAgentLogChanges(this.workspaceId, target.path, target.pattern, prev.logLineCount || 0, target.contextChars || 500);
            newSnapshot.logLineCount = lineCount;
            if (changes) allChanges.push({ ...changes, description: `${agentLabel} log: ${changes.description}` });
          }
          break;
        }
        case 'session': {
          // Resolve session ID: explicit (cmd field) > agent's cliSessionId > latest file
          let sessionId: string | undefined;
          if (target.cmd) {
            // Explicit session ID selected by user
            sessionId = target.cmd;
          } else if (target.path) {
            // Agent selected — use its current cliSessionId
            const agents = this.getAgents();
            const targetAgent = agents.get(target.path);
            if (targetAgent) {
              sessionId = (targetAgent.state as any).cliSessionId;
              if (!sessionId) {
                console.log(`[watch] Agent ${targetAgent.config.label} has no cliSessionId — falling back to latest session file`);
              }
            }
          }
          const { changes, lineCount: newFileSize } = detectSessionChanges(this.projectPath, target.pattern, prev.sessionFileSize || 0, target.contextChars || 500, sessionId);
          newSnapshot.sessionFileSize = newFileSize;
          if (changes) allChanges.push(changes);
          break;
        }
        case 'command': {
          const { changes, commandOutput } = detectCommandChanges(this.projectPath, target, prev.commandOutput);
          newSnapshot.commandOutput = commandOutput;
          if (changes) allChanges.push(changes);
          break;
        }
      }
    }

    this.snapshots.set(agentId, newSnapshot);

    if (initialRun) {
      console.log(`[watch] ${config.label}: baseline set (checkTime=${new Date(now).toLocaleTimeString()})`);
      return;
    }

    if (allChanges.length === 0) {
      console.log(`[watch] ${config.label}: checked — no changes`);
      // Heartbeat: only log to console, don't write to logs.jsonl or agent history
      // (prevents disk/memory bloat from frequent no-change checks)
      return;
    }

    // Build report
    const summary = allChanges.map(c =>
      `[${c.targetType}] ${c.description}${c.files.length ? '\n  ' + c.files.join('\n  ') : ''}`
    ).join('\n');

    console.log(`[watch] ${config.label}: detected ${allChanges.length} change(s)`);

    // Get debounce from first target that has it, or default 10s
    const debounceMs = (config.watch!.targets.find(t => t.debounce !== undefined)?.debounce ?? 10) * 1000;

    if (debounceMs > 0) {
      // Accumulate changes, reset timer each time
      const existing = this.pendingAlert.get(agentId);
      const merged = existing ? [...existing.changes, ...allChanges] : allChanges;
      const mergedSummary = merged.map(c =>
        `[${c.targetType}] ${c.description}${c.files.length ? '\n  ' + c.files.join('\n  ') : ''}`
      ).join('\n');
      this.pendingAlert.set(agentId, { changes: merged, summary: mergedSummary, timestamp: Date.now() });

      // Clear previous debounce timer, set new one
      const prevTimer = this.debounceTimers.get(agentId);
      if (prevTimer) clearTimeout(prevTimer);

      this.debounceTimers.set(agentId, setTimeout(() => {
        const pending = this.pendingAlert.get(agentId);
        if (!pending) return;
        this.pendingAlert.delete(agentId);
        this.debounceTimers.delete(agentId);
        this.emitAlert(agentId, config, pending.changes, pending.summary);
      }, debounceMs));

      console.log(`[watch] ${config.label}: debouncing ${debounceMs / 1000}s...`);
    } else {
      this.emitAlert(agentId, config, allChanges, summary);
    }
  }

  private emitAlert(agentId: string, config: WorkspaceAgentConfig, allChanges: WatchChange[], summary: string): void {
    const entry = { type: 'system' as const, subtype: 'watch_detected', content: `🔍 Watch detected changes:\n${summary}`, timestamp: new Date().toISOString() };
    appendAgentLog(this.workspaceId, agentId, entry).catch(() => {});

    this.emit('watch_alert', {
      type: 'watch_alert',
      agentId,
      entry,
      changes: allChanges,
      summary,
      timestamp: Date.now(),
    });
  }

  /** Manual trigger: run check now and return results */
  triggerCheck(agentId: string): { changes: WatchChange[] } | null {
    const agents = this.getAgents();
    const entry = agents.get(agentId);
    if (!entry?.config.watch?.enabled) return null;

    const prev = this.snapshots.get(agentId) || { files: {} };
    const allChanges: WatchChange[] = [];
    // Reuse runCheck logic but capture results
    this.runCheck(agentId, entry.config, false);
    return { changes: allChanges };
  }
}
