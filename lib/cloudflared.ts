/**
 * Cloudflare Tunnel (cloudflared) integration.
 * Zero-config mode: no account needed, gives a temporary public URL.
 */

import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, chmodSync, createWriteStream, unlinkSync, writeFileSync, readFileSync } from 'node:fs';
import { platform, arch } from 'node:os';
import { join } from 'node:path';
import https from 'node:https';
import http from 'node:http';
import { getConfigDir, getDataDir } from './dirs';

const BIN_DIR = join(getConfigDir(), 'bin');
const BIN_NAME = platform() === 'win32' ? 'cloudflared.exe' : 'cloudflared';
const BIN_PATH = join(BIN_DIR, BIN_NAME);

// ─── Download URL resolution ────────────────────────────────────

function getDownloadUrl(): string {
  const os = platform();
  const cpu = arch();
  const base = 'https://github.com/cloudflare/cloudflared/releases/latest/download';

  if (os === 'darwin') {
    return cpu === 'arm64'
      ? `${base}/cloudflared-darwin-arm64.tgz`
      : `${base}/cloudflared-darwin-amd64.tgz`;
  }
  if (os === 'linux') {
    if (cpu === 'arm64') return `${base}/cloudflared-linux-arm64`;
    if (cpu === 'arm') return `${base}/cloudflared-linux-arm`;
    return `${base}/cloudflared-linux-amd64`;
  }
  if (os === 'win32') {
    return `${base}/cloudflared-windows-amd64.exe`;
  }
  throw new Error(`Unsupported platform: ${os}/${cpu}`);
}

// ─── Download helper ────────────────────────────────────────────

const DOWNLOAD_TIMEOUT_MS = 120_000; // 2 minutes total per redirect hop

function followRedirects(url: string, dest: string, redirectsLeft = 10): Promise<void> {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, { headers: { 'User-Agent': 'forge/1.0' } }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume(); // drain redirect response
        if (redirectsLeft <= 0) {
          reject(new Error('Too many redirects'));
          return;
        }
        followRedirects(res.headers.location, dest, redirectsLeft - 1).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`Download failed: HTTP ${res.statusCode}`));
        return;
      }
      const file = createWriteStream(dest);
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve()));
      file.on('error', (err) => { try { unlinkSync(dest); } catch {} reject(err); });
      res.on('error', (err) => { try { unlinkSync(dest); } catch {} reject(err); });
    });
    req.setTimeout(DOWNLOAD_TIMEOUT_MS, () => {
      req.destroy(new Error(`Download timed out after ${DOWNLOAD_TIMEOUT_MS / 1000}s`));
    });
    req.on('error', reject);
  });
}

// Guard against concurrent downloads
let downloadPromise: Promise<string> | null = null;

export async function downloadCloudflared(): Promise<string> {
  if (existsSync(BIN_PATH)) return BIN_PATH;
  if (downloadPromise) return downloadPromise;

  downloadPromise = (async () => {
    mkdirSync(BIN_DIR, { recursive: true });
    const url = getDownloadUrl();
    const isTgz = url.endsWith('.tgz');
    const tmpPath = isTgz ? `${BIN_PATH}.tgz` : `${BIN_PATH}.tmp`;

    // Clean up any leftover partial files from a previous failed attempt
    try { unlinkSync(tmpPath); } catch {}

    console.log(`[cloudflared] Downloading from ${url}...`);
    try {
      await followRedirects(url, tmpPath);
    } catch (e) {
      try { unlinkSync(tmpPath); } catch {}
      throw e;
    }

    if (isTgz) {
      // Extract tgz (macOS)
      try {
        execSync(`tar -xzf "${tmpPath}" -C "${BIN_DIR}"`, { encoding: 'utf-8' });
      } finally {
        try { unlinkSync(tmpPath); } catch {}
      }
    } else {
      // Rename .tmp to final name atomically
      const { renameSync } = require('node:fs');
      renameSync(tmpPath, BIN_PATH);
    }

    if (platform() !== 'win32') {
      chmodSync(BIN_PATH, 0o755);
    }

    console.log(`[cloudflared] Installed to ${BIN_PATH}`);
    return BIN_PATH;
  })().finally(() => {
    downloadPromise = null;
  });

  return downloadPromise;
}

export function isInstalled(): boolean {
  return existsSync(BIN_PATH);
}

// ─── Tunnel process management ──────────────────────────────────
// Use globalThis to persist state across hot-reloads

interface TunnelState {
  process: ChildProcess | null;
  url: string | null;
  status: 'stopped' | 'starting' | 'running' | 'error';
  error: string | null;
  log: string[];
}

const stateKey = Symbol.for('mw-tunnel-state');
const gAny = globalThis as any;
if (!gAny[stateKey]) {
  gAny[stateKey] = { process: null, url: null, status: 'stopped', error: null, log: [] } as TunnelState;
}
const state: TunnelState = gAny[stateKey];

const MAX_LOG_LINES = 100;
const TUNNEL_STATE_FILE = join(getDataDir(), 'tunnel-state.json');

function saveTunnelState() {
  try {
    writeFileSync(TUNNEL_STATE_FILE, JSON.stringify({
      url: state.url, status: state.status, error: state.error, pid: state.process?.pid || null,
    }));
  } catch {}
}

function loadTunnelState(): { url: string | null; status: string; error: string | null; pid: number | null } {
  try {
    return JSON.parse(readFileSync(TUNNEL_STATE_FILE, 'utf-8'));
  } catch {
    return { url: null, status: 'stopped', error: null, pid: null };
  }
}

function pushLog(line: string) {
  state.log.push(line);
  if (state.log.length > MAX_LOG_LINES) state.log.shift();
}

export async function startTunnel(localPort: number = parseInt(process.env.PORT || '3000')): Promise<{ url?: string; error?: string }> {
  console.log(`[tunnel] Starting tunnel on port ${localPort}...`);
  // Prevent concurrent starts: state.process is already spawned, or another call is
  // mid-flight between the guard and spawn (the async download window).
  if (state.process || state.status === 'starting') {
    return state.url ? { url: state.url } : { error: 'Tunnel is starting...' };
  }

  // Check if another process already has a tunnel running
  const saved = loadTunnelState();
  if (saved.pid && saved.status === 'running' && saved.url) {
    try { process.kill(saved.pid, 0); return { url: saved.url }; } catch {}
  }

  // Claim 'starting' before any async work so concurrent callers are blocked
  // from this point onward (pgrep kill + download can take seconds).
  state.status = 'starting';
  state.url = null;
  state.error = null;
  state.log = [];

  // Kill ALL existing cloudflared processes to prevent duplicates
  try {
    const { execSync } = require('node:child_process');
    const pids = execSync("pgrep -f 'cloudflared tunnel'", { encoding: 'utf-8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    for (const pid of pids.split('\n').filter(Boolean)) {
      try { process.kill(parseInt(pid), 'SIGTERM'); } catch {}
    }
  } catch {}

  // Generate new session code for remote login 2FA
  try {
    const { rotateSessionCode } = require('./password');
    rotateSessionCode();
  } catch {}

  let binPath: string;
  try {
    binPath = await downloadCloudflared();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    state.status = 'error';
    state.error = msg;
    return { error: msg };
  }

  return new Promise((resolve) => {
    let resolved = false;

    state.process = spawn(binPath, ['tunnel', '--url', `http://localhost:${localPort}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    const handleOutput = (data: Buffer) => {
      const text = data.toString();
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        pushLog(line);

        const urlMatch = line.match(/(https:\/\/[a-z0-9-]+\.trycloudflare\.com)/);
        if (urlMatch && !state.url) {
          state.url = urlMatch[1];
          state.status = 'running';
          saveTunnelState();
          console.log(`[cloudflared] Tunnel URL: ${state.url}`);
          startHealthCheck();
          if (!resolved) {
            resolved = true;
            resolve({ url: state.url });
          }
        }
      }
    };

    state.process.stdout?.on('data', handleOutput);
    state.process.stderr?.on('data', handleOutput);

    state.process.on('error', (err) => {
      state.status = 'error';
      state.error = err.message;
      pushLog(`[error] ${err.message}`);
      console.error(`[tunnel] Error: ${err.message}`);
      if (!resolved) {
        resolved = true;
        resolve({ error: err.message });
      }
    });

    state.process.on('exit', (code) => {
      const recentLog = state.log.slice(-5).join(' ').slice(0, 200);
      const reason = code !== 0 ? `cloudflared failed (exit ${code}): ${recentLog || 'no output'}` : 'cloudflared stopped';
      console.log(`[tunnel] ${reason}`);
      state.process = null;
      if (state.status !== 'error') {
        state.status = 'stopped';
      }
      state.url = null;
      saveTunnelState();
      pushLog(`[exit] ${reason}`);
      if (!resolved) {
        resolved = true;
        resolve({ error: reason });
      }
    });

    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        if (!state.url) {
          state.status = 'error';
          state.error = 'Timeout waiting for tunnel URL';
          resolve({ error: 'Timeout waiting for tunnel URL (30s)' });
        }
      }
    }, 30000);
  });
}

export function stopTunnel() {
  console.log('[tunnel] Stopping tunnel');
  stopHealthCheck();
  if (state.process) {
    state.process.kill('SIGTERM');
    state.process = null;
  }
  // Also kill by saved PID in case another worker started it
  const saved = loadTunnelState();
  if (saved.pid) {
    try { process.kill(saved.pid, 'SIGTERM'); } catch {}
  }
  state.url = null;
  state.status = 'stopped';
  state.error = null;
  saveTunnelState();
}

export function getTunnelStatus() {
  // If this worker has the process, use in-memory state
  if (state.process) {
    return {
      status: state.status,
      url: state.url,
      error: state.error,
      installed: isInstalled(),
      log: state.log.slice(-20),
    };
  }
  // Otherwise read from file (another worker may have started it)
  const saved = loadTunnelState();
  if (saved.pid && saved.status === 'running') {
    try { process.kill(saved.pid, 0); } catch {
      // Process dead — clear stale state
      return { status: 'stopped' as const, url: null, error: null, installed: isInstalled(), log: [] };
    }
  }
  return {
    status: (saved.status || 'stopped') as TunnelState['status'],
    url: saved.url,
    error: saved.error,
    installed: isInstalled(),
    log: state.log.slice(-20),
  };
}

// ─── Tunnel health check ──────────────────────────────────────

let healthCheckTimer: ReturnType<typeof setInterval> | null = null;
let consecutiveFailures = 0;
const MAX_FAILURES = 3;
const HEALTH_CHECK_INTERVAL = 60_000; // 60s

async function checkTunnelHealth() {
  if (state.status !== 'running' || !state.url) return;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    const res = await fetch(state.url, {
      method: 'HEAD',
      signal: controller.signal,
      redirect: 'manual',
    });
    clearTimeout(timeout);

    // Any response (including 302 to login) means tunnel is alive
    if (res.status > 0) {
      if (consecutiveFailures > 0) {
        pushLog(`[health] Tunnel recovered after ${consecutiveFailures} failures`);
      }
      consecutiveFailures = 0;
      return;
    }
  } catch {
    // fetch failed — tunnel likely down
  }

  consecutiveFailures++;
  pushLog(`[health] Tunnel unreachable (${consecutiveFailures}/${MAX_FAILURES})`);

  if (consecutiveFailures >= MAX_FAILURES) {
    pushLog('[health] Tunnel appears dead — restarting...');
    state.status = 'error';
    state.error = 'Tunnel unreachable — restarting';

    // Kill old process and restart
    if (state.process) {
      state.process.kill('SIGTERM');
      state.process = null;
    }
    state.url = null;
    consecutiveFailures = 0;

    // Restart after a short delay
    setTimeout(async () => {
      const result = await startTunnel();
      if (result.url) {
        pushLog(`[health] Tunnel restarted: ${result.url}`);
        // Notify via Telegram if configured
        try {
          const { loadSettings } = await import('./settings');
          const settings = loadSettings();
          if (settings.telegramBotToken && settings.telegramChatId) {
            await fetch(`https://api.telegram.org/bot${settings.telegramBotToken}/sendMessage`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                chat_id: settings.telegramChatId,
                text: `🔄 Tunnel restarted\n\nNew URL: ${result.url}`,
                disable_web_page_preview: true,
              }),
            });
          }
        } catch {}
      } else {
        pushLog(`[health] Tunnel restart failed: ${result.error}`);
      }
    }, 3000);
  }
}

export function startHealthCheck() {
  if (healthCheckTimer) return;
  healthCheckTimer = setInterval(checkTunnelHealth, HEALTH_CHECK_INTERVAL);
}

export function stopHealthCheck() {
  if (healthCheckTimer) {
    clearInterval(healthCheckTimer);
    healthCheckTimer = null;
  }
  consecutiveFailures = 0;
}
