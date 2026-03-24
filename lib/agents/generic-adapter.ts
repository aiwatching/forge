/**
 * Generic agent adapter — works with any CLI agent that takes a prompt via args or stdin.
 * Supports: codex, aider, or any custom agent binary.
 */

import { execSync } from 'node:child_process';
import type { AgentAdapter, AgentConfig, AgentSpawnOptions, AgentSpawnResult } from './types';

export function createGenericAdapter(config: AgentConfig): AgentAdapter {
  return {
    id: config.id,
    config,

    buildTaskSpawn(opts: AgentSpawnOptions): AgentSpawnResult {
      const args: string[] = [];

      // Add configured flags (e.g., ['--message'] for aider)
      if (config.flags) {
        args.push(...config.flags);
      }

      // Add skip permissions flag if configured
      if (opts.skipPermissions !== false && config.skipPermissionsFlag) {
        args.push(...config.skipPermissionsFlag.split(/\s+/));
      }

      // Add prompt
      args.push(opts.prompt);

      if (opts.extraFlags) {
        args.push(...opts.extraFlags);
      }

      return { cmd: config.path, args };
    },

    buildTerminalCommand(opts) {
      return `cd "${opts.projectPath}" && ${config.path}\n`;
    },
  };
}

/** Detect known agents */
export function detectAgent(id: string, name: string, binaryName: string, flags?: string[]): AgentConfig | null {
  try {
    execSync(`which ${binaryName}`, { encoding: 'utf-8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'] });
    return {
      id,
      name,
      path: binaryName,
      enabled: true,
      type: 'generic',
      flags,
      capabilities: {
        supportsResume: false,
        supportsStreamJson: false,
        supportsModel: false,
        supportsSkipPermissions: false,
        hasSessionFiles: false,
        requiresTTY: false,
      },
    };
  } catch { return null; }
}
