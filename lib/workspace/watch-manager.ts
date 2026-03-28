/**
 * WatchManager — autonomous periodic monitoring for workspace agents.
 *
 * Fully independent from message bus / worker / state management.
 * Detects file changes, git diffs, agent outputs, or custom commands.
 * Writes results to agent log + emits SSE events. Never sends messages.
 */

import { EventEmitter } from 'node:events';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { execSync } from 'node:child_process';
import type { WorkspaceAgentConfig, WatchTarget, WatchConfig } from './types';
import { appendAgentLog } from './persistence';

// ─── Snapshot types ──────────────────────────────────────

interface FileSnapshot {
  [path: string]: number;  // relative path → mtime ms
}

interface WatchSnapshot {
  files: FileSnapshot;
  gitHash?: string;
  commandOutput?: string;
}

interface WatchChange {
  targetType: WatchTarget['type'];
  description: string;
  files: string[];
}

// ─── Detection functions ─────────────────────────────────

function scanDirectory(dir: string, pattern?: string, maxDepth = 3): FileSnapshot {
  const snapshot: FileSnapshot = {};
  if (!existsSync(dir)) return snapshot;

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
          } else if (globMatch(entry)) {
            snapshot[relative(dir, full)] = st.mtimeMs;
          }
        } catch {}
      }
    } catch {}
  }

  walk(dir, 0);
  return snapshot;
}

function diffSnapshots(prev: FileSnapshot, curr: FileSnapshot): { added: string[]; modified: string[]; removed: string[] } {
  const added: string[] = [];
  const modified: string[] = [];
  const removed: string[] = [];

  for (const [path, mtime] of Object.entries(curr)) {
    if (!(path in prev)) added.push(path);
    else if (prev[path] !== mtime) modified.push(path);
  }
  for (const path of Object.keys(prev)) {
    if (!(path in curr)) removed.push(path);
  }

  return { added, modified, removed };
}

function detectDirectoryChanges(projectPath: string, target: WatchTarget, prev: FileSnapshot): { changes: WatchChange | null; snapshot: FileSnapshot } {
  const dir = join(projectPath, target.path || '.');
  const snapshot = scanDirectory(dir, target.pattern);
  const diff = diffSnapshots(prev, snapshot);
  const totalChanges = diff.added.length + diff.modified.length + diff.removed.length;

  if (totalChanges === 0) return { changes: null, snapshot };

  const parts: string[] = [];
  if (diff.added.length) parts.push(`${diff.added.length} added`);
  if (diff.modified.length) parts.push(`${diff.modified.length} modified`);
  if (diff.removed.length) parts.push(`${diff.removed.length} removed`);

  return {
    changes: {
      targetType: 'directory',
      description: `${target.path || '.'}: ${parts.join(', ')}`,
      files: [...diff.added, ...diff.modified, ...diff.removed].slice(0, 20),
    },
    snapshot,
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

// ─── WatchManager class ──────────────────────────────────

export class WatchManager extends EventEmitter {
  private timers = new Map<string, NodeJS.Timeout>();
  private snapshots = new Map<string, WatchSnapshot>();

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
    const prev = this.snapshots.get(agentId) || { files: {} };
    const allChanges: WatchChange[] = [];
    const newSnapshot: WatchSnapshot = { files: {} };

    for (const target of config.watch!.targets) {
      switch (target.type) {
        case 'directory': {
          const dir = join(this.projectPath, target.path || '.');
          const prevFiles = prev.files;
          const { changes, snapshot } = detectDirectoryChanges(this.projectPath, target, prevFiles);
          Object.assign(newSnapshot.files, snapshot);
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
          // Monitor another agent's declared output paths
          const agents = this.getAgents();
          const targetAgent = target.path ? agents.get(target.path) : null;
          if (targetAgent) {
            for (const outputPath of targetAgent.config.outputs) {
              const dir = join(this.projectPath, outputPath);
              const { changes, snapshot } = detectDirectoryChanges(this.projectPath, { ...target, path: outputPath }, prev.files);
              Object.assign(newSnapshot.files, snapshot);
              if (changes) allChanges.push({ ...changes, targetType: 'agent_output', description: `${targetAgent.config.label} output: ${changes.description}` });
            }
          }
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
      console.log(`[watch] ${config.label}: baseline snapshot built (${Object.keys(newSnapshot.files).length} files)`);
      return;
    }

    if (allChanges.length === 0) {
      console.log(`[watch] ${config.label}: checked — no changes`);
      const entry = { type: 'system' as const, subtype: 'watch_heartbeat', content: '👁 Watch checked — no changes detected', timestamp: new Date().toISOString() };
      appendAgentLog(this.workspaceId, agentId, entry).catch(() => {});
      this.emit('watch_heartbeat', { type: 'watch_heartbeat', agentId, entry });
      return;
    }

    // Build report
    const summary = allChanges.map(c =>
      `[${c.targetType}] ${c.description}${c.files.length ? '\n  ' + c.files.join('\n  ') : ''}`
    ).join('\n');

    console.log(`[watch] ${config.label}: detected ${allChanges.length} change(s)`);

    const entry = { type: 'system' as const, subtype: 'watch_detected', content: `🔍 Watch detected changes:\n${summary}`, timestamp: new Date().toISOString() };
    appendAgentLog(this.workspaceId, agentId, entry).catch(() => {});

    // Emit SSE event for UI
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
