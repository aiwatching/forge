/**
 * Agent Registry — manages available agents and provides adapters.
 * Agents coexist (not mutually exclusive). Each entry point can select any agent.
 */

import { loadSettings } from '../settings';
import type { AgentAdapter, AgentConfig, AgentId } from './types';
import { createClaudeAdapter, detectClaude } from './claude-adapter';
import { createGenericAdapter, detectAgent } from './generic-adapter';

export type { AgentAdapter, AgentConfig, AgentId } from './types';

// Module-level cache
const adapterCache = new Map<AgentId, AgentAdapter>();

/** Get all configured agents */
export function listAgents(): AgentConfig[] {
  const settings = loadSettings();
  const agents: AgentConfig[] = [];

  // Claude (always check — primary agent)
  const claudeConfig = settings.agents?.claude;
  const claude = detectClaude(claudeConfig?.path || settings.claudePath);
  if (claude) {
    agents.push({ ...claude, enabled: claudeConfig?.enabled !== false, detected: true, skipPermissionsFlag: claudeConfig?.skipPermissionsFlag || '--dangerously-skip-permissions', cliType: 'claude-code' } as any);
  }

  // Codex
  const codexConfig = settings.agents?.codex;
  const codex = detectAgent('codex', 'OpenAI Codex', codexConfig?.path || 'codex');
  if (codex) {
    codex.capabilities.requiresTTY = true;
    agents.push({ ...codex, enabled: codexConfig?.enabled !== false, detected: true, skipPermissionsFlag: codexConfig?.skipPermissionsFlag || '--dangerously-bypass-approvals-and-sandbox', cliType: 'codex' } as any);
  }

  // Aider
  const aiderConfig = settings.agents?.aider;
  const aider = detectAgent('aider', 'Aider', aiderConfig?.path || 'aider', ['--message']);
  if (aider) {
    agents.push({ ...aider, enabled: aiderConfig?.enabled !== false, detected: true, skipPermissionsFlag: aiderConfig?.skipPermissionsFlag || '--yes', cliType: 'aider' } as any);
  }

  // Custom agents + profiles from settings
  if (settings.agents) {
    for (const [id, cfg] of Object.entries(settings.agents)) {
      if (['claude', 'codex', 'aider'].includes(id)) continue;

      // API profile — no CLI detection needed
      if (cfg.type === 'api') {
        agents.push({
          id,
          name: cfg.name || id,
          path: '',
          enabled: cfg.enabled !== false,
          type: 'generic' as const,
          capabilities: { supportsResume: false, supportsStreamJson: false, supportsModel: false, supportsSkipPermissions: false, hasSessionFiles: false, requiresTTY: false },
          isProfile: true,
          backendType: 'api',
          provider: cfg.provider,
          model: cfg.model,
          apiKey: cfg.apiKey,
        } as any);
        continue;
      }

      // CLI profile (has base) — inherit from base agent
      if (cfg.base) {
        const baseAgent = agents.find(a => a.id === cfg.base);
        agents.push({
          ...(baseAgent || { type: 'generic' as const, capabilities: { supportsResume: false, supportsStreamJson: false, supportsModel: false, supportsSkipPermissions: false, hasSessionFiles: false, requiresTTY: false } }),
          id,
          name: cfg.name || id,
          path: baseAgent?.path || '',
          enabled: cfg.enabled !== false,
          base: cfg.base,
          isProfile: true,
          backendType: 'cli',
          model: cfg.model || cfg.models?.task,
          skipPermissionsFlag: cfg.skipPermissionsFlag || baseAgent?.skipPermissionsFlag,
          env: cfg.env,
          cliType: cfg.cliType || (baseAgent as any)?.cliType || 'generic',
        } as any);
        continue;
      }

      // Custom agent (not a profile) — detect binary
      if (!cfg.path) continue;
      const flags = cfg.taskFlags ? cfg.taskFlags.split(/\s+/).filter(Boolean) : cfg.flags;
      const detected = detectAgent(id, cfg.name || id, cfg.path, flags);
      agents.push({
        ...(detected || {
          id, name: cfg.name || id, path: cfg.path, type: 'generic' as const, flags,
          capabilities: { supportsResume: false, supportsStreamJson: false, supportsModel: false, supportsSkipPermissions: false, hasSessionFiles: false, requiresTTY: !!cfg.requiresTTY },
        }),
        flags,
        enabled: cfg.enabled !== false,
        detected: !!detected,
      } as any);
    }
  }

  return agents;
}

/** Get the default agent ID */
export function getDefaultAgentId(): AgentId {
  const settings = loadSettings();
  return settings.defaultAgent || 'claude';
}

/** Get an agent adapter by ID (falls back to default). For profiles, returns base agent's adapter. */
export function getAgent(id?: AgentId): AgentAdapter {
  const agentId = id || getDefaultAgentId();

  // Return cached adapter
  if (adapterCache.has(agentId)) return adapterCache.get(agentId)!;

  const agents = listAgents();
  const config = agents.find(a => a.id === agentId && a.enabled);

  // Profile with base → get base agent's adapter
  if (config?.base) {
    const baseAdapter = getAgent(config.base);
    // Wrap adapter with profile's model override
    const profileAdapter: AgentAdapter = {
      ...baseAdapter,
      id: agentId,
      config: { ...baseAdapter.config, ...config, id: agentId },
    };
    adapterCache.set(agentId, profileAdapter);
    return profileAdapter;
  }

  if (!config) {
    // If specifically requested agent not found, only fallback for 'claude' (default)
    if (agentId === 'claude' || agentId === getDefaultAgentId()) {
      const fallback = detectClaude() || {
        id: 'claude', name: 'Claude Code', path: 'claude', enabled: true,
        type: 'claude-code' as const,
        capabilities: { supportsResume: true, supportsStreamJson: true, supportsModel: true, supportsSkipPermissions: true, hasSessionFiles: true, requiresTTY: false },
      };
      const adapter = createClaudeAdapter(fallback);
      adapterCache.set(agentId, adapter);
      return adapter;
    }
    // Non-default agent not found — create generic with the ID as path (will fail if not installed)
    const notFound: AgentConfig = {
      id: agentId, name: agentId, path: agentId, enabled: true, type: 'generic',
      capabilities: { supportsResume: false, supportsStreamJson: false, supportsModel: false, supportsSkipPermissions: false, hasSessionFiles: false, requiresTTY: false },
    };
    const adapter = createGenericAdapter(notFound);
    adapterCache.set(agentId, adapter);
    return adapter;
  }

  const adapter = config.type === 'claude-code'
    ? createClaudeAdapter(config)
    : createGenericAdapter(config);

  adapterCache.set(agentId, adapter);
  return adapter;
}

/** Clear adapter cache (call after settings change) */
export function clearAgentCache(): void {
  adapterCache.clear();
}

/** Auto-detect all available agents (called on startup) */
export function autoDetectAgents(): AgentConfig[] {
  const detected: AgentConfig[] = [];

  const claude = detectClaude();
  if (claude) detected.push(claude);

  const codex = detectAgent('codex', 'OpenAI Codex', 'codex');
  if (codex) detected.push(codex);

  const aider = detectAgent('aider', 'Aider', 'aider', ['--message']);
  if (aider) detected.push(aider);

  if (detected.length > 0) {
    console.log(`[agents] Detected: ${detected.map(a => a.name).join(', ')}`);
  }

  return detected;
}

/** Resolve terminal launch info for an agent — used by both VibeCoding and Workspace */
export interface TerminalLaunchInfo {
  cliCmd: string;              // actual binary: claude, codex, aider
  cliType: string;             // claude-code, codex, aider, generic
  supportsSession: boolean;    // has session files to resume
  resumeFlag: string;          // -c, --resume, etc.
  env?: Record<string, string>; // profile env vars to export
  model?: string;              // profile model override (--model flag)
}

export function resolveTerminalLaunch(agentId?: string): TerminalLaunchInfo {
  const settings = loadSettings();
  const agentCfg = settings.agents?.[agentId || 'claude'] || {};
  // Resolve cliType: own cliType → base agent's cliType → base agent name guessing → agentId name guessing
  const baseId = agentCfg.base;
  const baseCfg = baseId ? (settings.agents?.[baseId] || {}) : {};
  const cliType = agentCfg.cliType || baseCfg.cliType
    || (baseId === 'codex' ? 'codex' : baseId === 'aider' ? 'aider' : undefined)
    || (agentId === 'codex' ? 'codex' : agentId === 'aider' ? 'aider' : 'claude-code');

  // Determine CLI command and capabilities from cliType
  const cliMap: Record<string, { cmd: string; session: boolean; resume: string }> = {
    'claude-code': { cmd: 'claude', session: true, resume: '-c' },
    'codex': { cmd: 'codex', session: false, resume: '' },
    'aider': { cmd: 'aider', session: false, resume: '' },
    'generic': { cmd: agentCfg.path || agentId || 'claude', session: false, resume: '' },
  };
  const cli = cliMap[cliType] || cliMap['claude-code'];

  // Resolve env/model: either from this agent's own profile fields, or from linked profile
  let env: Record<string, string> | undefined;
  let model: string | undefined;
  if (agentCfg.base || agentCfg.env || agentCfg.model) {
    // This agent IS a profile — read env/model directly
    if (agentCfg.env) env = { ...agentCfg.env };
    if (agentCfg.model) model = agentCfg.model;
  } else if (agentCfg.profile) {
    // Agent links to a separate profile — read from that
    const profileCfg = settings.agents?.[agentCfg.profile];
    if (profileCfg) {
      if (profileCfg.env) env = { ...profileCfg.env };
      if (profileCfg.model) model = profileCfg.model;
    }
  }

  return {
    cliCmd: cli.cmd,
    cliType,
    supportsSession: cli.session,
    resumeFlag: agentCfg.resumeFlag || cli.resume,
    env,
    model,
  };
}
