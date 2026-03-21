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
const PIDS_FILE = join(DATA_DIR, 'forge.pids'); // all child process PIDs
const LOG_FILE = join(DATA_DIR, 'forge.log');

process.chdir(ROOT);

// ── Migrate old layout (~/.forge/*) to new (~/.forge/data/*) ──
if (!getArg('--dir')) {
  const oldSettings = join(homedir(), '.forge', 'settings.yaml');
  const newSettings = join(DATA_DIR, 'settings.yaml');
  if (existsSync(oldSettings) && !existsSync(newSettings)) {
    console.log('[forge] Migrating data from ~/.forge/ to ~/.forge/data/...');
    mkdirSync(DATA_DIR, { recursive: true });
    const migrateFiles = ['settings.yaml', '.encrypt-key', '.env.local', 'session-code.json', 'terminal-state.json', 'tunnel-state.json', 'preview.json', 'forge.pid', 'forge.log'];
    for (const f of migrateFiles) {
      const src = join(homedir(), '.forge', f);
      const dest = join(DATA_DIR, f);
      if (existsSync(src) && !existsSync(dest)) {
        try { const { copyFileSync } = await import('node:fs'); copyFileSync(src, dest); console.log(`  ${f}`); } catch {}
      }
    }
    // data.db → workflow.db
    const oldDb = join(homedir(), '.forge', 'data.db');
    const newDb = join(DATA_DIR, 'workflow.db');
    if (existsSync(oldDb) && !existsSync(newDb)) {
      try { const { copyFileSync } = await import('node:fs'); copyFileSync(oldDb, newDb); console.log('  data.db → workflow.db'); } catch {}
    }
    // Migrate directories
    for (const d of ['flows', 'pipelines']) {
      const src = join(homedir(), '.forge', d);
      const dest = join(DATA_DIR, d);
      if (existsSync(src) && !existsSync(dest)) {
        try { const { renameSync } = await import('node:fs'); renameSync(src, dest); console.log(`  ${d}/`); } catch {}
      }
    }
    console.log('[forge] Migration complete.');
  }
}

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

    if (resetPassword) {
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

// ── PID tracking for clean shutdown ──

function savePids(pids) {
  writeFileSync(PIDS_FILE, JSON.stringify(pids), 'utf-8');
}

function loadPids() {
  try { return JSON.parse(readFileSync(PIDS_FILE, 'utf-8')); } catch { return []; }
}

function killTrackedPids() {
  const pids = loadPids();
  for (const pid of pids) {
    try { process.kill(pid, 'SIGTERM'); } catch {}
  }
  // Give them a moment, then force kill
  if (pids.length > 0) {
    setTimeout(() => {
      for (const pid of pids) {
        try { process.kill(pid, 'SIGKILL'); } catch {}
      }
    }, 2000);
  }
  try { unlinkSync(PIDS_FILE); } catch {}
}

// ── Kill orphan standalone processes ──
const protectedPids = new Set();

function cleanupOrphans() {
  const myPid = String(process.pid);
  const instanceTag = `--forge-port=${webPort}`;
  try {
    // Kill processes on our ports
    for (const port of [webPort, terminalPort]) {
      try {
        const pids = execSync(`lsof -ti:${port}`, { encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
        for (const pid of pids.split('\n').filter(Boolean)) {
          const p = pid.trim();
          if (p === myPid || protectedPids.has(p)) continue;
          try { process.kill(parseInt(p), 'SIGTERM'); } catch {}
        }
      } catch {}
    }
    // Kill standalone processes: our instance's + orphans without any tag
    try {
      const out = execSync(`ps aux | grep -E 'telegram-standalone|terminal-standalone' | grep -v grep`, {
        encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      for (const line of out.split('\n').filter(Boolean)) {
        const isOurs = line.includes(instanceTag);
        const isOrphan = !line.includes('--forge-port='); // no tag = legacy orphan
        if (!isOurs && !isOrphan) continue; // belongs to another instance, skip
        const pid = line.trim().split(/\s+/)[1];
        if (pid === myPid || protectedPids.has(pid)) continue;
        try { process.kill(parseInt(pid), 'SIGTERM'); } catch {}
      }
    } catch {}
  } catch {}
}

// ── Start standalone services (single instance each) ──
const services = [];

function startServices() {
  cleanupOrphans();

  const instanceTag = `--forge-port=${webPort}`;

  // Terminal server
  const termScript = join(ROOT, 'lib', 'terminal-standalone.ts');
  const termChild = spawn('npx', ['tsx', termScript, instanceTag], {
    cwd: ROOT,
    stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env },
  });
  services.push(termChild);
  console.log(`[forge] Terminal server started (pid: ${termChild.pid})`);

  // Telegram bot
  const telegramScript = join(ROOT, 'lib', 'telegram-standalone.ts');
  const telegramChild = spawn('npx', ['tsx', telegramScript, instanceTag], {
    cwd: ROOT,
    stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env },
  });
  services.push(telegramChild);
  console.log(`[forge] Telegram bot started (pid: ${telegramChild.pid})`);

  // Track all child PIDs for clean shutdown
  const childPids = services.map(c => c.pid).filter(Boolean);
  savePids(childPids);
}

function stopServices() {
  for (const child of services) {
    try { child.kill('SIGTERM'); } catch {}
  }
  services.length = 0;
  cleanupOrphans();
}

// ── Helper: stop running instance ──
async function stopServer() {
  stopServices();
  try { unlinkSync(join(DATA_DIR, 'tunnel-state.json')); } catch {}

  // Kill all tracked child PIDs first
  killTrackedPids();

  let stopped = false;

  // Try PID file first
  try {
    const pid = parseInt(readFileSync(PID_FILE, 'utf-8').trim());
    process.kill(pid, 'SIGTERM');
    console.log(`[forge] Stopped (pid ${pid})`);
    stopped = true;
  } catch {}
  try { unlinkSync(PID_FILE); } catch {}

  // Also kill by port (in case PID file is stale)
  const portPids = [];
  try {
    const pids = execSync(`lsof -ti:${webPort}`, { encoding: 'utf-8', timeout: 3000 }).trim();
    for (const p of pids.split('\n').filter(Boolean)) {
      const pid = parseInt(p.trim());
      try { process.kill(pid, 'SIGTERM'); stopped = true; portPids.push(pid); } catch {}
    }
    if (pids) console.log(`[forge] Killed processes on port ${webPort}`);
  } catch {}

  // Force kill after 2 seconds if SIGTERM didn't work
  if (portPids.length > 0) {
    await new Promise(r => setTimeout(r, 2000));
    for (const pid of portPids) {
      try { process.kill(pid, 'SIGKILL'); } catch {}
    }
  }

  if (!stopped) {
    console.log('[forge] No running server found');
  }
  return stopped;
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
  await stopServer();
  process.exit(0);
}

// ── Restart ──
if (isRestart) {
  await stopServer();
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
