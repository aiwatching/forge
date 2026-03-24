/**
 * Claude Code adapter — handles Claude CLI specifics.
 */

import { execSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import type { AgentAdapter, AgentConfig, AgentSpawnOptions, AgentSpawnResult } from './types';

const CAPABILITIES = {
  supportsResume: true,
  supportsStreamJson: true,
  supportsModel: true,
  supportsSkipPermissions: true,
  hasSessionFiles: true,
};

/** Resolve claude binary path (symlink → real .js → node) */
function resolveClaudePath(claudePath: string): { cmd: string; prefix: string[] } {
  try {
    let resolved = claudePath;
    try {
      const which = execSync(`which ${claudePath}`, { encoding: 'utf-8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
      resolved = realpathSync(which);
    } catch {
      resolved = realpathSync(claudePath);
    }
    if (resolved.endsWith('.js') || resolved.endsWith('.mjs')) {
      return { cmd: process.execPath, prefix: [resolved] };
    }
    return { cmd: resolved, prefix: [] };
  } catch {
    return { cmd: process.execPath, prefix: [claudePath] };
  }
}

export function createClaudeAdapter(config: AgentConfig): AgentAdapter {
  return {
    id: 'claude',
    config: { ...config, capabilities: CAPABILITIES },

    buildTaskSpawn(opts: AgentSpawnOptions): AgentSpawnResult {
      const resolved = resolveClaudePath(config.path);
      const args = [...resolved.prefix, '-p', '--verbose'];

      if (opts.outputFormat === 'stream-json' || opts.outputFormat === undefined) {
        args.push('--output-format', 'stream-json');
      } else if (opts.outputFormat === 'json') {
        args.push('--output-format', 'json');
      }

      if (opts.skipPermissions !== false) {
        const flag = config.skipPermissionsFlag || '--dangerously-skip-permissions';
        if (flag) args.push(...flag.split(/\s+/));
      }

      if (opts.model && opts.model !== 'default') {
        args.push('--model', opts.model);
      }

      if (opts.conversationId) {
        args.push('--resume', opts.conversationId);
      }

      if (opts.extraFlags) {
        args.push(...opts.extraFlags);
      }

      args.push(opts.prompt);

      return { cmd: resolved.cmd, args };
    },

    buildTerminalCommand(opts) {
      const flag = config.skipPermissionsFlag || '--dangerously-skip-permissions';
      const skipFlag = opts.skipPermissions && flag ? ` ${flag}` : '';
      if (opts.sessionId) {
        return `cd "${opts.projectPath}" && claude --resume ${opts.sessionId}${skipFlag}\n`;
      }
      const resumeFlag = opts.resume ? ' -c' : '';
      return `cd "${opts.projectPath}" && claude${resumeFlag}${skipFlag}\n`;
    },
  };
}

/** Detect if claude is installed and return config */
export function detectClaude(customPath?: string): AgentConfig | null {
  const paths = customPath ? [customPath] : ['claude'];
  for (const p of paths) {
    try {
      execSync(`which ${p}`, { encoding: 'utf-8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'] });
      return {
        id: 'claude',
        name: 'Claude Code',
        path: p,
        enabled: true,
        type: 'claude-code',
        capabilities: CAPABILITIES,
        skipPermissionsFlag: '--dangerously-skip-permissions',
      };
    } catch {}
  }
  return null;
}
