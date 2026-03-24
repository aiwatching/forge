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
    agents.push({ ...claude, enabled: claudeConfig?.enabled !== false, detected: true } as any);
  }

  // Codex
  const codexConfig = settings.agents?.codex;
  const codex = detectAgent('codex', 'OpenAI Codex', codexConfig?.path || 'codex');
  if (codex) {
    agents.push({ ...codex, enabled: codexConfig?.enabled !== false, detected: true } as any);
  }

  // Aider
  const aiderConfig = settings.agents?.aider;
  const aider = detectAgent('aider', 'Aider', aiderConfig?.path || 'aider', ['--message']);
  if (aider) {
    agents.push({ ...aider, enabled: aiderConfig?.enabled !== false, detected: true } as any);
  }

  // Custom agents from settings — always include, mark detected/not
  if (settings.agents) {
    for (const [id, cfg] of Object.entries(settings.agents)) {
      if (['claude', 'codex', 'aider'].includes(id)) continue;
      if (!cfg.path) continue;
      const flags = cfg.taskFlags ? cfg.taskFlags.split(/\s+/).filter(Boolean) : cfg.flags;
      const detected = detectAgent(id, cfg.name || id, cfg.path, flags);
      agents.push({
        ...(detected || {
          id, name: cfg.name || id, path: cfg.path, type: 'generic' as const, flags,
          capabilities: { supportsResume: false, supportsStreamJson: false, supportsModel: false, supportsSkipPermissions: false, hasSessionFiles: false },
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

/** Get an agent adapter by ID (falls back to default) */
export function getAgent(id?: AgentId): AgentAdapter {
  const agentId = id || getDefaultAgentId();

  // Return cached adapter
  if (adapterCache.has(agentId)) return adapterCache.get(agentId)!;

  const agents = listAgents();
  const config = agents.find(a => a.id === agentId && a.enabled);

  if (!config) {
    // If specifically requested agent not found, only fallback for 'claude' (default)
    if (agentId === 'claude' || agentId === getDefaultAgentId()) {
      const fallback = detectClaude() || {
        id: 'claude', name: 'Claude Code', path: 'claude', enabled: true,
        type: 'claude-code' as const,
        capabilities: { supportsResume: true, supportsStreamJson: true, supportsModel: true, supportsSkipPermissions: true, hasSessionFiles: true },
      };
      const adapter = createClaudeAdapter(fallback);
      adapterCache.set(agentId, adapter);
      return adapter;
    }
    // Non-default agent not found — create generic with the ID as path (will fail if not installed)
    const notFound: AgentConfig = {
      id: agentId, name: agentId, path: agentId, enabled: true, type: 'generic',
      capabilities: { supportsResume: false, supportsStreamJson: false, supportsModel: false, supportsSkipPermissions: false, hasSessionFiles: false },
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
