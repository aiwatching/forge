/**
 * Server-side initialization — called once on first API request per worker.
 * When FORGE_EXTERNAL_SERVICES=1 (set by forge-server), telegram/terminal/tunnel
 * are managed externally — only task runner starts here.
 */

import { ensureRunnerStarted } from './task-manager';
import { startTelegramBot, stopTelegramBot } from './telegram-bot';
import { startWatcherLoop } from './session-watcher';
import { getPassword } from './password';
import { loadSettings } from './settings';
import { startTunnel } from './cloudflared';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

const initKey = Symbol.for('mw-initialized');
const gInit = globalThis as any;

export function ensureInitialized() {
  if (gInit[initKey]) return;
  gInit[initKey] = true;

  // Task runner is safe in every worker (DB-level coordination)
  ensureRunnerStarted();

  // Session watcher is safe (file-based, idempotent)
  startWatcherLoop();

  // If services are managed externally (forge-server), skip
  if (process.env.FORGE_EXTERNAL_SERVICES === '1') {
    // Password display only once
    const password = getPassword();
    console.log(`[init] Login password: ${password} (valid today)`);
    console.log('[init] Forgot? Run: forge password');
    return;
  }

  // Standalone mode (pnpm dev without forge-server) — start everything here
  const password = getPassword();
  console.log(`[init] Login password: ${password} (valid today)`);
  console.log('[init] Forgot? Run: forge password');

  startTelegramBot(); // registers task event listener only
  startTerminalProcess();
  startTelegramProcess(); // spawns telegram-standalone

  const settings = loadSettings();
  if (settings.tunnelAutoStart) {
    startTunnel().then(result => {
      if (result.url) console.log(`[init] Tunnel started: ${result.url}`);
      else if (result.error) console.log(`[init] Tunnel failed: ${result.error}`);
    });
  }

  console.log('[init] Background services started');
}

/** Restart Telegram bot (e.g. after settings change) */
export function restartTelegramBot() {
  stopTelegramBot();
  startTelegramBot();
}

let telegramChild: ReturnType<typeof spawn> | null = null;

function startTelegramProcess() {
  if (telegramChild) return;
  const settings = loadSettings();
  if (!settings.telegramBotToken || !settings.telegramChatId) return;

  const script = join(process.cwd(), 'lib', 'telegram-standalone.ts');
  telegramChild = spawn('npx', ['tsx', script], {
    stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env, PORT: String(process.env.PORT || 3000) },
    detached: false,
  });
  telegramChild.on('exit', () => { telegramChild = null; });
  console.log('[telegram] Started standalone (pid:', telegramChild.pid, ')');
}

let terminalChild: ReturnType<typeof spawn> | null = null;

function startTerminalProcess() {
  if (terminalChild) return;

  const termPort = Number(process.env.TERMINAL_PORT) || 3001;

  const net = require('node:net');
  const tester = net.createServer();
  tester.once('error', () => {
    console.log(`[terminal] Port ${termPort} already in use, reusing existing`);
  });
  tester.once('listening', () => {
    tester.close();
    const script = join(process.cwd(), 'lib', 'terminal-standalone.ts');
    terminalChild = spawn('npx', ['tsx', script], {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'CLAUDECODE')) } as NodeJS.ProcessEnv,
      detached: false,
    });
    terminalChild.on('exit', () => { terminalChild = null; });
    console.log('[terminal] Started standalone server (pid:', terminalChild.pid, ')');
  });
  tester.listen(termPort);
}
