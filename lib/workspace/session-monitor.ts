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

import { statSync, readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
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
  private tmuxSessions = new Map<string, string>();
  // Heartbeat probe tracking: agentId → { probeCount, lastProbeTime }
  private probeState = new Map<string, { count: number; lastTime: number }>();

  /**
   * Start monitoring a session file for an agent.
   * @param agentId - Agent identifier
   * @param sessionFilePath - Full path to the .jsonl session file
   * @param tmuxSession - Optional tmux session name (for process-alive check)
   */
  startMonitoring(agentId: string, sessionFilePath: string, tmuxSession?: string): void {
    this.stopMonitoring(agentId);
    if (tmuxSession) this.tmuxSessions.set(agentId, tmuxSession);
    this.currentState.set(agentId, 'idle');
    this.lastStableTime.set(agentId, Date.now());

    const timer = setInterval(() => {
      this.checkFile(agentId, sessionFilePath);
    }, POLL_INTERVAL);
    timer.unref();
    this.timers.set(agentId, timer);

    console.log(`[session-monitor] Started monitoring ${agentId}: ${sessionFilePath}`);
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
    this.tmuxSessions.delete(agentId);
    this.probeState.delete(agentId);
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
        this.probeState.delete(agentId); // reset heartbeat probes
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
          // Instead of forcing done, send a heartbeat probe to the terminal.
          // If the agent responds → file changes → back to running.
          // If no response (still waiting for API) → probe again with increasing interval.
          const tmux = this.tmuxSessions.get(agentId);
          if (tmux) {
            const probe = this.probeState.get(agentId) || { count: 0, lastTime: 0 };
            // Increasing intervals: 10s, 20s, 30s, 60s, 60s, 60s...
            const intervals = [10000, 20000, 30000, 60000];
            const interval = intervals[Math.min(probe.count, intervals.length - 1)];
            const timeSinceProbe = Date.now() - probe.lastTime;

            if (timeSinceProbe >= interval) {
              this.sendHeartbeatProbe(agentId, tmux, probe.count);
              this.probeState.set(agentId, { count: probe.count + 1, lastTime: Date.now() });
            }
            // Don't mark done — wait for file activity or no-tmux fallback
            return;
          }
          // No tmux (headless fallback) → use stable timeout
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
   * Send a short heartbeat probe to the terminal to check if the agent is done.
   * If the agent is idle (waiting for input), it will process this and the session
   * file will update → detected as activity → done via result check.
   * If the agent is busy (waiting for API), the probe queues and won't be processed
   * until the current turn finishes.
   */
  private sendHeartbeatProbe(agentId: string, tmuxSession: string, probeCount: number): void {
    try {
      const msg = probeCount === 0
        ? '[Forge heartbeat] Are you done with your current task? If yes, reply with a brief status. If you received multiple of these, only respond to one and ignore the rest.'
        : '[Forge heartbeat] Status check — respond only if idle.';
      const tmpFile = `/tmp/forge-probe-${Date.now()}.txt`;
      writeFileSync(tmpFile, msg);
      execSync(`tmux load-buffer ${tmpFile} 2>/dev/null`, { timeout: 3000 });
      execSync(`tmux paste-buffer -t "${tmuxSession}" 2>/dev/null`, { timeout: 3000 });
      execSync(`tmux send-keys -t "${tmuxSession}" Enter 2>/dev/null`, { timeout: 3000 });
      try { require('node:fs').unlinkSync(tmpFile); } catch {}
      console.log(`[session-monitor] ${agentId}: heartbeat probe #${probeCount + 1} sent`);
    } catch (err: any) {
      console.log(`[session-monitor] ${agentId}: heartbeat probe failed — ${err.message}`);
    }
  }

  /**
   * Check if a CLI process (claude/codex/node) is still running in a tmux pane.
   * Only used for terminal mode — prevents false "done" during long API calls.
   */
  private isCliProcessAlive(tmuxSession: string): boolean {
    try {
      const panePid = execSync(`tmux display-message -t "${tmuxSession}" -p "#{pane_pid}" 2>/dev/null`, { timeout: 3000, encoding: 'utf-8' }).trim();
      if (!panePid) return false;
      // Check if the shell has any child processes (claude, codex, node, etc.)
      const children = execSync(`ps -ef | awk -v ppid=${panePid} '$3==ppid{print $NF}'`, { timeout: 3000, encoding: 'utf-8' }).trim();
      return children.length > 0; // any child = CLI still running
    } catch {
      return false; // can't check = assume not alive
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
