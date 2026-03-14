#!/usr/bin/env node
/**
 * forge-server — Start the Forge web platform.
 *
 * Usage:
 *   forge-server                Start in foreground (production mode)
 *   forge-server --dev          Start in foreground (development mode)
 *   forge-server --background   Start in background (production mode), logs to ~/.forge/forge.log
 *   forge-server --stop         Stop background server
 */

import { execSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, openSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DATA_DIR = join(homedir(), '.forge');
const PID_FILE = join(DATA_DIR, 'forge.pid');
const LOG_FILE = join(DATA_DIR, 'forge.log');

const isDev = process.argv.includes('--dev');
const isBackground = process.argv.includes('--background');
const isStop = process.argv.includes('--stop');
const isRebuild = process.argv.includes('--rebuild');

process.chdir(ROOT);
mkdirSync(DATA_DIR, { recursive: true });

// ── Load ~/.forge/.env.local ──
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

// ── Stop ──
if (isStop) {
  try {
    const pid = parseInt(readFileSync(PID_FILE, 'utf-8').trim());
    process.kill(pid, 'SIGTERM');
    unlinkSync(PID_FILE);
    console.log(`[forge] Stopped (pid ${pid})`);
  } catch {
    console.log('[forge] No running server found');
  }
  process.exit(0);
}

// ── Rebuild ──
if (isRebuild || existsSync(join(ROOT, '.next', 'BUILD_ID'))) {
  // Always rebuild after npm install (new version)
  const buildIdFile = join(ROOT, '.next', 'BUILD_ID');
  const pkgVersion = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8')).version;
  const versionFile = join(ROOT, '.next', '.forge-version');
  const lastBuiltVersion = existsSync(versionFile) ? readFileSync(versionFile, 'utf-8').trim() : '';
  if (isRebuild || lastBuiltVersion !== pkgVersion) {
    console.log(`[forge] Rebuilding (v${pkgVersion})...`);
    execSync('rm -rf .next', { cwd: ROOT });
    execSync('npx next build', { cwd: ROOT, stdio: 'inherit' });
    writeFileSync(versionFile, pkgVersion);
    if (isRebuild) {
      console.log('[forge] Rebuild complete');
      process.exit(0);
    }
  }
}

// ── Background ──
if (isBackground) {
  // Build if needed
  if (!existsSync(join(ROOT, '.next'))) {
    console.log('[forge] Building...');
    execSync('npx next build', { cwd: ROOT, stdio: 'inherit' });
  }

  const logFd = openSync(LOG_FILE, 'a');
  const child = spawn('npx', ['next', 'start'], {
    cwd: ROOT,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env },
    detached: true,
  });

  writeFileSync(PID_FILE, String(child.pid));
  child.unref();
  console.log(`[forge] Started in background (pid ${child.pid})`);
  console.log(`[forge] Log: ${LOG_FILE}`);
  console.log(`[forge] Stop: forge-server --stop`);
  process.exit(0);
}

// ── Foreground ──
if (isDev) {
  console.log('[forge] Starting in development mode...');
  const child = spawn('npx', ['next', 'dev', '--turbopack'], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env },
  });
  child.on('exit', (code) => process.exit(code || 0));
} else {
  if (!existsSync(join(ROOT, '.next'))) {
    console.log('[forge] Building...');
    execSync('npx next build', { cwd: ROOT, stdio: 'inherit' });
  }
  console.log('[forge] Starting server...');
  const child = spawn('npx', ['next', 'start'], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env },
  });
  child.on('exit', (code) => process.exit(code || 0));
}
