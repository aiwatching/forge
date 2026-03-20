/**
 * Centralized directory paths for Forge.
 *
 * Shared (configDir):  ~/.forge/          — only bin/ (cloudflared)
 * Instance (dataDir):  ~/.forge/data/     — settings, db, state, flows, etc.
 *                      or --dir / FORGE_DATA_DIR
 * Claude (claudeDir):  ~/.claude/         — or configured in settings
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

/** Shared config directory — only binaries, fixed at ~/.forge/ */
export function getConfigDir(): string {
  return join(homedir(), '.forge');
}

/** Instance data directory — all instance-specific data */
export function getDataDir(): string {
  return process.env.FORGE_DATA_DIR || join(getConfigDir(), 'data');
}

/** Claude Code home directory — skills, commands, sessions */
export function getClaudeDir(): string {
  // Env var takes precedence
  if (process.env.CLAUDE_HOME) return process.env.CLAUDE_HOME;
  // Try to read from settings (lazy require to avoid circular dependency)
  try {
    const { loadSettings } = require('./settings');
    const settings = loadSettings();
    if (settings.claudeHome) return settings.claudeHome.replace(/^~/, homedir());
  } catch {}
  return join(homedir(), '.claude');
}
