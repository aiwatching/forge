#!/usr/bin/env node
/**
 * forge-server — Start the Forge web platform.
 *
 * Usage:
 *   forge-server                          Start in foreground (production)
 *   forge-server --dev                    Start in foreground (development)
 *   forge-server --background             Start in background
 *   forge-server --stop                   Stop background server
 *   forge-server --restart                Stop + start (safe for remote)
 *   forge-server --rebuild                Force rebuild
 *   forge-server --port 4000              Custom web port (default: 3000)
 *   forge-server --terminal-port 4001     Custom terminal port (default: 3001)
 *   forge-server --dir ~/.forge-test      Custom data directory (default: ~/.forge)
 *   forge-server --reset-terminal         Kill terminal server before start (loses tmux sessions)
 *
 * Examples:
 *   forge-server --background --port 4000 --terminal-port 4001 --dir ~/.forge-staging
 *   forge-server --restart
 */

import { execSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, openSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

/** Build Next.js — install devDependencies first if missing */
function buildNext() {
  // Check if devDependencies are installed (e.g. @tailwindcss/postcss)
  if (!existsSync(join(ROOT, 'node_modules', '@tailwindcss', 'postcss'))) {
    console.log('[forge] Installing dependencies...');
    execSync('npm install --include=dev', { cwd: ROOT, stdio: 'inherit' });
  }
  execSync('npx next build', { cwd: ROOT, stdio: 'inherit', env: { ...process.env } });
}

// ── Parse arguments ──

function getArg(name) {
  const idx = process.argv.indexOf(name);
  if (idx === -1 || idx + 1 >= process.argv.length) return null;
  return process.argv[idx + 1];
}

// ── Version ──
if (process.argv.includes('--version') || process.argv.includes('-v')) {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
  console.log(`@aion0/forge v${pkg.version}`);
  process.exit(0);
}

const isDev = process.argv.includes('--dev');
const isForeground = process.argv.includes('--foreground');
const isBackground = !isForeground && !isDev; // default background unless --foreground or --dev
const isStop = process.argv.includes('--stop');
const isRestart = process.argv.includes('--restart');
const isRebuild = process.argv.includes('--rebuild');
const resetTerminal = process.argv.includes('--reset-terminal');
const resetPassword = process.argv.includes('--reset-password');

const webPort = parseInt(getArg('--port')) || 3000;
const terminalPort = parseInt(getArg('--terminal-port')) || (webPort + 1);
const DATA_DIR = getArg('--dir')?.replace(/^~/, homedir()) || join(homedir(), '.forge', 'data');

const PID_FILE = join(DATA_DIR, 'forge.pid');
const LOG_FILE = join(DATA_DIR, 'forge.log');

process.chdir(ROOT);
mkdirSync(DATA_DIR, { recursive: true });

// ── Load <data-dir>/.env.local ──
const envFile = join(DATA_DIR, '.env.local');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
}

// Set env vars for Next.js and terminal server
process.env.PORT = String(webPort);
process.env.TERMINAL_PORT = String(terminalPort);
process.env.FORGE_DATA_DIR = DATA_DIR;

// ── Password setup (first run or --reset-password) ──
if (!isStop) {
  const YAML = await import('yaml');
  const settingsFile = join(DATA_DIR, 'settings.yaml');
  let settings = {};
  try { settings = YAML.parse(readFileSync(settingsFile, 'utf-8')) || {}; } catch {}

  const hasPassword = !!settings.telegramTunnelPassword;

  if (resetPassword || !hasPassword) {
    if (resetPassword) {
      console.log('[forge] Password reset requested');
    } else {
      console.log('[forge] First run — please set an admin password');
    }

    const readline = await import('node:readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ask = (q) => new Promise((resolve, reject) => {
      rl.question(q, resolve);
      rl.once('close', () => reject(new Error('cancelled')));
    });

    let pw = '';
    try {
      while (true) {
        pw = await ask('  Enter admin password: ');
        if (!pw || pw.length < 4) {
          console.log('  Password must be at least 4 characters');
          continue;
        }
        const confirm = await ask('  Confirm password: ');
        if (pw !== confirm) {
          console.log('  Passwords do not match, try again');
          continue;
        }
        break;
      }
    } catch {
      console.log('\n[forge] Cancelled');
      process.exit(0);
    }
    rl.close();

    // Encrypt and save
    const crypto = await import('node:crypto');
    const KEY_FILE = join(DATA_DIR, '.encrypt-key');
    let encKey;
    if (existsSync(KEY_FILE)) {
      encKey = Buffer.from(readFileSync(KEY_FILE, 'utf-8').trim(), 'hex');
    } else {
      encKey = crypto.randomBytes(32);
      writeFileSync(KEY_FILE, encKey.toString('hex'), { mode: 0o600 });
    }
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', encKey, iv);
    const encrypted = Buffer.concat([cipher.update(pw, 'utf-8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    settings.telegramTunnelPassword = `enc:${iv.toString('base64')}.${tag.toString('base64')}.${encrypted.toString('base64')}`;
    if (!existsSync(dirname(settingsFile))) mkdirSync(dirname(settingsFile), { recursive: true });
    writeFileSync(settingsFile, YAML.stringify(settings), 'utf-8');
    console.log('[forge] Admin password saved');

    if (resetPassword && !isDev && !isBackground && !isRestart) {
      process.exit(0);
    }
  }
}

// ── Reset terminal server (kill port + tmux sessions) ──
if (resetTerminal) {
  console.log(`[forge] Resetting terminal server (port ${terminalPort})...`);
  try {
    const pids = execSync(`lsof -ti:${terminalPort}`, { encoding: 'utf-8' }).trim();
    for (const pid of pids.split('\n').filter(Boolean)) {
      try { execSync(`kill ${pid.trim()}`); } catch {}
    }
    console.log(`[forge] Killed terminal server on port ${terminalPort}`);
  } catch {
    console.log(`[forge] No process on port ${terminalPort}`);
  }
}

// ── Kill orphan standalone processes ──
const protectedPids = new Set();

function cleanupOrphans() {
  try {
    // Only kill processes on OUR ports, not other instances
    for (const port of [webPort, terminalPort]) {
      try {
        const pids = execSync(`lsof -ti:${port}`, { encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
        const myPid = String(process.pid);
        for (const pid of pids.split('\n').filter(Boolean)) {
          const p = pid.trim();
          if (p === myPid || protectedPids.has(p)) continue;
          try { process.kill(parseInt(p), 'SIGTERM'); } catch {}
        }
      } catch {}
    }
    // Kill standalone processes that belong to this instance (match by FORGE_DATA_DIR)
    try {
      const out = execSync(`ps aux | grep -E 'telegram-standalone|terminal-standalone' | grep -v grep`, {
        encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      if (out) {
        const myPid = String(process.pid);
        for (const line of out.split('\n').filter(Boolean)) {
          // Only kill if it matches our DATA_DIR or port
          if (!line.includes(DATA_DIR) && !line.includes(`PORT=${webPort}`) && !line.includes(`TERMINAL_PORT=${terminalPort}`)) continue;
          const pid = line.trim().split(/\s+/)[1];
          if (pid === myPid || protectedPids.has(pid)) continue;
          try { process.kill(parseInt(pid), 'SIGTERM'); } catch {}
        }
      }
    } catch {}
  } catch {}
}

// ── Start standalone services (single instance each) ──
const services = [];

function startServices() {
  cleanupOrphans();

  // Terminal server
  const termScript = join(ROOT, 'lib', 'terminal-standalone.ts');
  const termChild = spawn('npx', ['tsx', termScript], {
    cwd: ROOT,
    stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env },
  });
  services.push(termChild);
  console.log(`[forge] Terminal server started (pid: ${termChild.pid})`);

  // Telegram bot
  const telegramScript = join(ROOT, 'lib', 'telegram-standalone.ts');
  const telegramChild = spawn('npx', ['tsx', telegramScript], {
    cwd: ROOT,
    stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env },
  });
  services.push(telegramChild);
  console.log(`[forge] Telegram bot started (pid: ${telegramChild.pid})`);
}

function stopServices() {
  for (const child of services) {
    try { child.kill('SIGTERM'); } catch {}
  }
  services.length = 0;
  cleanupOrphans();
}

// ── Helper: stop running instance ──
function stopServer() {
  stopServices();
  try { unlinkSync(join(DATA_DIR, 'tunnel-state.json')); } catch {}

  try {
    const pid = parseInt(readFileSync(PID_FILE, 'utf-8').trim());
    process.kill(pid, 'SIGTERM');
    unlinkSync(PID_FILE);
    console.log(`[forge] Stopped (pid ${pid})`);
    return true;
  } catch {
    console.log('[forge] No running server found');
    return false;
  }
}

// ── Helper: start background server ──
function startBackground() {
  if (!existsSync(join(ROOT, '.next', 'BUILD_ID'))) {
    console.log('[forge] Building...');
    buildNext();
  }

  const logFd = openSync(LOG_FILE, 'a');
  const nextBin = join(ROOT, 'node_modules', '.bin', 'next');
  const child = spawn(nextBin, ['start', '-p', String(webPort)], {
    cwd: ROOT,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env, FORGE_EXTERNAL_SERVICES: '1' },
    detached: true,
  });

  writeFileSync(PID_FILE, String(child.pid));
  protectedPids.add(String(child.pid));
  child.unref();

  // Start services in background too (cleanupOrphans will skip protectedPids)
  startServices();

  console.log(`[forge] Started in background (pid ${child.pid})`);
  console.log(`[forge] Web: http://localhost:${webPort}`);
  console.log(`[forge] Terminal: ws://localhost:${terminalPort}`);
  console.log(`[forge] Data: ${DATA_DIR}`);
  console.log(`[forge] Log: ${LOG_FILE}`);
  console.log(`[forge] Stop: forge server stop`);
}

// ── Stop ──
if (isStop) {
  stopServer();
  process.exit(0);
}

// ── Restart ──
if (isRestart) {
  stopServer();
  // Wait for port to fully release
  const net = await import('node:net');
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 500));
    const free = await new Promise(resolve => {
      const s = net.createServer();
      s.once('error', () => resolve(false));
      s.once('listening', () => { s.close(); resolve(true); });
      s.listen(webPort);
    });
    if (free) break;
  }
  startBackground();
  process.exit(0);
}

// ── Rebuild ──
if (isRebuild || existsSync(join(ROOT, '.next', 'BUILD_ID'))) {
  const pkgVersion = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8')).version;
  const versionFile = join(ROOT, '.next', '.forge-version');
  const lastBuiltVersion = existsSync(versionFile) ? readFileSync(versionFile, 'utf-8').trim() : '';
  if (isRebuild || lastBuiltVersion !== pkgVersion) {
    console.log(`[forge] Rebuilding (v${pkgVersion})...`);
    execSync('rm -rf .next', { cwd: ROOT });
    buildNext();
    writeFileSync(versionFile, pkgVersion);
    if (isRebuild) {
      console.log('[forge] Rebuild complete');
      process.exit(0);
    }
  }
}

// ── Background ──
if (isBackground) {
  startBackground();
  process.exit(0);
}

// ── Foreground ──

// Clean up services on exit
process.on('SIGINT', () => { stopServices(); process.exit(0); });
process.on('SIGTERM', () => { stopServices(); process.exit(0); });

if (isDev) {
  console.log(`[forge] Starting dev mode (port ${webPort}, terminal ${terminalPort}, data ${DATA_DIR})`);
  startServices();
  const child = spawn('npx', ['next', 'dev', '--turbopack', '-p', String(webPort)], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, FORGE_EXTERNAL_SERVICES: '1' },
  });
  child.on('exit', (code) => { stopServices(); process.exit(code || 0); });
} else {
  if (!existsSync(join(ROOT, '.next', 'BUILD_ID'))) {
    console.log('[forge] Building...');
    buildNext();
  }
  console.log(`[forge] Starting server (port ${webPort}, terminal ${terminalPort}, data ${DATA_DIR})`);
  startServices();
  const child = spawn('npx', ['next', 'start', '-p', String(webPort)], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, FORGE_EXTERNAL_SERVICES: '1' },
  });
  child.on('exit', (code) => { stopServices(); process.exit(code || 0); });
}
