/**
 * Server-side initialization — called once on first API request per worker.
 * When FORGE_EXTERNAL_SERVICES=1 (set by forge-server), telegram/terminal/tunnel
 * are managed externally — only task runner starts here.
 */

import { ensureRunnerStarted } from './task-manager';
import { startTelegramBot, stopTelegramBot } from './telegram-bot';
import { startWatcherLoop } from './session-watcher';
import { getAdminPassword } from './password';
import { loadSettings, saveSettings } from './settings';
import { startTunnel } from './cloudflared';
import { isEncrypted, SECRET_FIELDS } from './crypto';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

const initKey = Symbol.for('mw-initialized');
const gInit = globalThis as any;

/** Migrate plaintext secrets to encrypted on first run */
function migrateSecrets() {
  try {
    const { existsSync, readFileSync } = require('node:fs');
    const { homedir } = require('node:os');
    const YAML = require('yaml');
    const dataDir = process.env.FORGE_DATA_DIR || join(homedir(), '.forge');
    const file = join(dataDir, 'settings.yaml');
    if (!existsSync(file)) return;
    const raw = YAML.parse(readFileSync(file, 'utf-8')) || {};
    let needsSave = false;
    for (const field of SECRET_FIELDS) {
      if (raw[field] && typeof raw[field] === 'string' && !isEncrypted(raw[field])) {
        needsSave = true;
        break;
      }
    }
    if (needsSave) {
      // loadSettings returns decrypted, saveSettings encrypts
      const settings = loadSettings();
      saveSettings(settings);
      console.log('[init] Migrated plaintext secrets to encrypted storage');
    }
  } catch (e) {
    console.error('[init] Secret migration error:', e);
  }
}

/** Auto-detect claude binary path if not configured */
function autoDetectClaude() {
  try {
    const settings = loadSettings();
    if (settings.claudePath) return; // already configured
    const { execSync } = require('node:child_process');
    const path = execSync('which claude', { encoding: 'utf-8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    if (path) {
      settings.claudePath = path;
      saveSettings(settings);
      console.log(`[init] Auto-detected claude: ${path}`);
    }
  } catch {}
}

export function ensureInitialized() {
  if (gInit[initKey]) return;
  gInit[initKey] = true;

  // Migrate plaintext secrets on startup
  migrateSecrets();

  // Cleanup old notifications
  try {
    const { cleanupNotifications } = require('./notifications');
    cleanupNotifications();
  } catch {}

  // Auto-detect claude path if not configured
  autoDetectClaude();

  // Sync skills registry (async, non-blocking) — on startup + every 30 min
  try {
    const { syncSkills } = require('./skills');
    syncSkills().catch(() => {});
    setInterval(() => { syncSkills().catch(() => {}); }, 30 * 60 * 1000);
  } catch {}

  // Task runner is safe in every worker (DB-level coordination)
  ensureRunnerStarted();

  // Session watcher is safe (file-based, idempotent)
  startWatcherLoop();

  // If services are managed externally (forge-server), skip
  if (process.env.FORGE_EXTERNAL_SERVICES === '1') {
    // Password display
    const admin = getAdminPassword();
    if (admin) {
      console.log(`[init] Admin password: configured`);
    } else {
      console.log('[init] No admin password set — configure in Settings');
    };
    return;
  }

  // Standalone mode (pnpm dev without forge-server) — start everything here
  const admin2 = getAdminPassword();
  if (admin2) {
    console.log(`[init] Admin password: configured`);
  } else {
    console.log('[init] No admin password set — configure in Settings');
  }

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
