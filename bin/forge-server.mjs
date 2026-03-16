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

// ── Parse arguments ──

function getArg(name) {
  const idx = process.argv.indexOf(name);
  if (idx === -1 || idx + 1 >= process.argv.length) return null;
  return process.argv[idx + 1];
}

const isDev = process.argv.includes('--dev');
const isBackground = process.argv.includes('--background');
const isStop = process.argv.includes('--stop');
const isRestart = process.argv.includes('--restart');
const isRebuild = process.argv.includes('--rebuild');

const webPort = parseInt(getArg('--port')) || 3000;
const terminalPort = parseInt(getArg('--terminal-port')) || 3001;
const DATA_DIR = getArg('--dir')?.replace(/^~/, homedir()) || join(homedir(), '.forge');

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

// ── Helper: stop running instance ──
function stopServer() {
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
  if (!existsSync(join(ROOT, '.next'))) {
    console.log('[forge] Building...');
    execSync('npx next build', { cwd: ROOT, stdio: 'inherit', env: { ...process.env } });
  }

  const logFd = openSync(LOG_FILE, 'a');
  const child = spawn('npx', ['next', 'start', '-p', String(webPort)], {
    cwd: ROOT,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env },
    detached: true,
  });

  writeFileSync(PID_FILE, String(child.pid));
  child.unref();
  console.log(`[forge] Started in background (pid ${child.pid})`);
  console.log(`[forge] Web: http://localhost:${webPort}`);
  console.log(`[forge] Terminal: ws://localhost:${terminalPort}`);
  console.log(`[forge] Data: ${DATA_DIR}`);
  console.log(`[forge] Log: ${LOG_FILE}`);
  console.log(`[forge] Stop: forge-server --stop${DATA_DIR !== join(homedir(), '.forge') ? ` --dir ${DATA_DIR}` : ''}`);
}

// ── Stop ──
if (isStop) {
  stopServer();
  process.exit(0);
}

// ── Restart ──
if (isRestart) {
  stopServer();
  // Brief delay to let port release
  await new Promise(r => setTimeout(r, 1500));
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
    execSync('npx next build', { cwd: ROOT, stdio: 'inherit', env: { ...process.env } });
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
if (isDev) {
  console.log(`[forge] Starting dev mode (port ${webPort}, terminal ${terminalPort}, data ${DATA_DIR})`);
  const child = spawn('npx', ['next', 'dev', '--turbopack', '-p', String(webPort)], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env },
  });
  child.on('exit', (code) => process.exit(code || 0));
} else {
  if (!existsSync(join(ROOT, '.next'))) {
    console.log('[forge] Building...');
    execSync('npx next build', { cwd: ROOT, stdio: 'inherit', env: { ...process.env } });
  }
  console.log(`[forge] Starting server (port ${webPort}, terminal ${terminalPort}, data ${DATA_DIR})`);
  const child = spawn('npx', ['next', 'start', '-p', String(webPort)], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env },
  });
  child.on('exit', (code) => process.exit(code || 0));
}
