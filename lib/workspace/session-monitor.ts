/**
 * Session File Monitor — detects agent running/idle state by watching
 * Claude Code's .jsonl session files.
 *
 * How it works:
 * - Each agent has a known session file path (boundSessionId/fixedSessionId/--session-id)
 * - Monitor checks file mtime every 3s
 * - mtime changing → agent is running (LLM streaming, tool use, etc.)
 * - mtime stable for IDLE_THRESHOLD → check last lines for 'result' entry → done
 * - No session file → idle (not started)
 *
 * Works for both terminal and headless modes — both write the same .jsonl format.
 */

import { statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { EventEmitter } from 'node:events';

export type SessionMonitorState = 'idle' | 'running' | 'done';

export interface SessionMonitorEvent {
  agentId: string;
  state: SessionMonitorState;
  sessionFile: string;
  detail?: string; // e.g., result summary
}

const POLL_INTERVAL = 1000;    // check every 1s (need to catch short executions)
const IDLE_THRESHOLD = 10000;  // 10s of no file change → check for done
const STABLE_THRESHOLD = 20000; // 20s of no change → force done

export class SessionFileMonitor extends EventEmitter {
  private timers = new Map<string, NodeJS.Timeout>();
  private lastMtime = new Map<string, number>();
  private lastSize = new Map<string, number>();
  private lastStableTime = new Map<string, number>();
  private currentState = new Map<string, SessionMonitorState>();

  /**
   * Start monitoring session files for an agent.
   * Watches the session directory for the most recently modified .jsonl file,
   * so it tracks whichever session is active (workspace or VibeCoding).
   * @param agentId - Agent identifier
   * @param sessionFilePath - Full path to a .jsonl session file (used to derive directory)
   */
  startMonitoring(agentId: string, sessionFilePath: string): void {
    this.stopMonitoring(agentId);
    this.currentState.set(agentId, 'idle');
    this.lastStableTime.set(agentId, Date.now());

    // Watch the directory, not just one file — track whichever session is active
    const sessionDir = sessionFilePath.replace(/\/[^/]+\.jsonl$/, '');

    const timer = setInterval(() => {
      // Find the most recently modified .jsonl in the directory
      let latestFile = sessionFilePath;
      try {
        const { readdirSync, statSync: statS } = require('node:fs');
        const files = readdirSync(sessionDir).filter((f: string) => f.endsWith('.jsonl'));
        if (files.length > 0) {
          const sorted = files
            .map((f: string) => ({ path: join(sessionDir, f), mtime: statS(join(sessionDir, f)).mtimeMs }))
            .sort((a: any, b: any) => b.mtime - a.mtime);
          latestFile = sorted[0].path;
        }
      } catch {}
      this.checkFile(agentId, latestFile);
    }, POLL_INTERVAL);
    timer.unref();
    this.timers.set(agentId, timer);

    console.log(`[session-monitor] Started monitoring ${agentId}: dir=${sessionDir}`);
  }

  /**
   * Stop monitoring an agent's session file.
   */
  stopMonitoring(agentId: string): void {
    const timer = this.timers.get(agentId);
    if (timer) clearInterval(timer);
    this.timers.delete(agentId);
    this.lastMtime.delete(agentId);
    this.lastSize.delete(agentId);
    this.lastStableTime.delete(agentId);
    this.currentState.delete(agentId);
  }

  /**
   * Stop all monitors.
   */
  stopAll(): void {
    for (const [id] of this.timers) {
      this.stopMonitoring(id);
    }
  }

  /**
   * Get current state for an agent.
   */
  getState(agentId: string): SessionMonitorState {
    return this.currentState.get(agentId) || 'idle';
  }

  /**
   * Resolve session file path for a project + session ID.
   */
  static resolveSessionPath(projectPath: string, workDir: string | undefined, sessionId: string): string {
    const fullPath = workDir && workDir !== './' && workDir !== '.'
      ? join(projectPath, workDir) : projectPath;
    const encoded = resolve(fullPath).replace(/\//g, '-');
    return join(homedir(), '.claude', 'projects', encoded, `${sessionId}.jsonl`);
  }

  private initialized = new Set<string>();
  private checkFile(agentId: string, filePath: string): void {
    try {
      const stat = statSync(filePath);
      const mtime = stat.mtimeMs;
      const size = stat.size;

      // First poll: just record baseline, don't trigger state change
      if (!this.initialized.has(agentId)) {
        this.initialized.add(agentId);
        this.lastMtime.set(agentId, mtime);
        this.lastSize.set(agentId, size);
        this.lastStableTime.set(agentId, Date.now());
        console.log(`[session-monitor] ${agentId}: baseline mtime=${mtime} size=${size}`);
        return;
      }

      const prevMtime = this.lastMtime.get(agentId) || 0;
      const prevSize = this.lastSize.get(agentId) || 0;
      const prevState = this.currentState.get(agentId) || 'idle';
      const now = Date.now();

      this.lastMtime.set(agentId, mtime);
      this.lastSize.set(agentId, size);

      // File changed (mtime or size different) → running
      if (mtime !== prevMtime || size !== prevSize) {
        this.lastStableTime.set(agentId, now);
        if (prevState !== 'running') {
          this.setState(agentId, 'running', filePath);
        }
        return;
      }

      // File unchanged — how long has it been stable?
      const stableFor = now - (this.lastStableTime.get(agentId) || now);

      if (prevState === 'running') {
        if (stableFor >= IDLE_THRESHOLD) {
          // Check if session file has a 'result' entry at the end
          const resultInfo = this.checkForResult(filePath);
          if (resultInfo) {
            this.setState(agentId, 'done', filePath, resultInfo);
            return;
          }
        }
        if (stableFor >= STABLE_THRESHOLD) {
          // Force done after 30s even without result entry
          this.setState(agentId, 'done', filePath, 'stable timeout');
          return;
        }
      }
    } catch (err: any) {
      if (!this.initialized.has(`err-${agentId}`)) {
        this.initialized.add(`err-${agentId}`);
        console.log(`[session-monitor] ${agentId}: checkFile error — ${err.message}`);
      }
    }
  }

  /**
   * Check the last few lines of the session file for a 'result' type entry.
   * Claude Code writes this when a turn completes.
   */
  private checkForResult(filePath: string): string | null {
    try {
      // Read last 4KB of the file
      const stat = statSync(filePath);
      const readSize = Math.min(4096, stat.size);
      const fd = require('node:fs').openSync(filePath, 'r');
      const buf = Buffer.alloc(readSize);
      require('node:fs').readSync(fd, buf, 0, readSize, Math.max(0, stat.size - readSize));
      require('node:fs').closeSync(fd);

      const tail = buf.toString('utf-8');
      const lines = tail.split('\n').filter(l => l.trim());

      // Scan last lines for result entry
      for (let i = lines.length - 1; i >= Math.max(0, lines.length - 10); i--) {
        try {
          const entry = JSON.parse(lines[i]);
          // Claude Code writes result entries with these fields
          if (entry.type === 'result' || entry.result || entry.duration_ms !== undefined) {
            const summary = entry.result?.slice?.(0, 200) || entry.summary?.slice?.(0, 200) || '';
            return summary || 'completed';
          }
          // Also check for assistant message without tool_use (model stopped)
          if (entry.type === 'assistant' && entry.message?.content) {
            const content = entry.message.content;
            const hasToolUse = Array.isArray(content)
              ? content.some((b: any) => b.type === 'tool_use')
              : false;
            if (!hasToolUse) {
              return 'model stopped (no tool_use)';
            }
          }
        } catch {} // skip non-JSON lines
      }
    } catch {}
    return null;
  }

  private setState(agentId: string, state: SessionMonitorState, filePath: string, detail?: string): void {
    const prev = this.currentState.get(agentId);
    if (prev === state) return;

    this.currentState.set(agentId, state);
    const event: SessionMonitorEvent = { agentId, state, sessionFile: filePath, detail };
    this.emit('stateChange', event);
    console.log(`[session-monitor] ${agentId}: ${prev} → ${state}${detail ? ` (${detail})` : ''}`);
  }
}
