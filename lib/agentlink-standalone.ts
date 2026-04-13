#!/usr/bin/env npx tsx
/**
 * Standalone AgentLink bot process.
 * Runs as a single process — no duplication from Next.js workers.
 */

import { loadSettings } from './settings';
import { verifyAgentlinkAgent, registerAgentlinkCommands, pollAgentlinkUpdates } from './agentlink-bot';

const settings = loadSettings();
if (!settings.agentlinkEnabled) {
  console.log('[agentlink] Disabled, exiting');
  process.exit(0);
}
if (!settings.agentlinkAgentToken) {
  console.log('[agentlink] No agent token configured, exiting');
  process.exit(0);
}

async function start() {
  console.log('[agentlink] Verifying agent token...');
  const me = await verifyAgentlinkAgent();
  if (!me.ok) {
    console.error(`[agentlink] Token verification failed: ${me.error}`);
    process.exit(1);
  }
  console.log(`[agentlink] Bot '${me.name}' (bot_id=${me.bot_id}) online`);

  try {
    await registerAgentlinkCommands();
    console.log('[agentlink] Commands registered');
  } catch (err: any) {
    console.error('[agentlink] Failed to register commands:', err.message);
  }

  await pollAgentlinkUpdates();
}

process.on('SIGTERM', () => {
  console.log('[agentlink] Received SIGTERM, exiting');
  process.exit(0);
});
process.on('SIGINT', () => {
  console.log('[agentlink] Received SIGINT, exiting');
  process.exit(0);
});

start().catch(err => {
  console.error('[agentlink] Fatal error:', err);
  process.exit(1);
});
