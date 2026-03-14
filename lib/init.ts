/**
 * Server-side initialization — called once on first API request.
 * Starts background services: task runner, Telegram bot.
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

  // Ensure AUTH_SECRET is set (NextAuth requires it)
  if (!process.env.AUTH_SECRET) {
    const { randomBytes } = require('node:crypto');
    process.env.AUTH_SECRET = randomBytes(32).toString('hex');
  }

  // Display login password (auto-generated, rotates daily)
  const password = getPassword();
  console.log(`[init] Login password: ${password} (valid today)`);
  console.log('[init] Forgot? Run: mw password');

  // Start background task runner
  ensureRunnerStarted();

  // Start Telegram bot if configured
  startTelegramBot();

  // Start terminal WebSocket server as separate process (node-pty needs native module)
  startTerminalProcess();

  // Start session watcher loop
  startWatcherLoop();

  // Auto-start tunnel if configured
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

let terminalChild: ReturnType<typeof spawn> | null = null;

function startTerminalProcess() {
  if (terminalChild) return;

  // Check if port 3001 is already in use
  const net = require('node:net');
  const tester = net.createServer();
  tester.once('error', () => {
    // Port in use — terminal server already running
    console.log('[terminal] Port 3001 already in use, skipping');
  });
  tester.once('listening', () => {
    tester.close();
    // Port free — start terminal server
    const script = join(process.cwd(), 'lib', 'terminal-standalone.ts');
    terminalChild = spawn('npx', ['tsx', script], {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'CLAUDECODE')) } as NodeJS.ProcessEnv,
      detached: false,
    });
    terminalChild.on('exit', () => { terminalChild = null; });
    console.log('[terminal] Started standalone server (pid:', terminalChild.pid, ')');
  });
  tester.listen(3001);
}
