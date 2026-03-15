import { NextResponse } from 'next/server';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { spawn, execSync, type ChildProcess } from 'node:child_process';

const CONFIG_FILE = join(homedir(), '.forge', 'preview.json');

// Persist tunnel state across hot-reloads
const stateKey = Symbol.for('mw-preview-state');
const g = globalThis as any;
if (!g[stateKey]) g[stateKey] = { process: null, port: 0, url: null, status: 'stopped' };
const state: { process: ChildProcess | null; port: number; url: string | null; status: string } = g[stateKey];

function getConfig(): { port: number } {
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
  } catch {
    return { port: 0 };
  }
}

function saveConfig(config: { port: number }) {
  const dir = dirname(CONFIG_FILE);
  mkdirSync(dir, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

function getCloudflaredPath(): string | null {
  const binPath = join(homedir(), '.forge', 'bin', 'cloudflared');
  if (existsSync(binPath)) return binPath;
  try {
    return execSync('which cloudflared', { encoding: 'utf-8' }).trim();
  } catch {
    return null;
  }
}

// GET — get current preview status
export async function GET() {
  return NextResponse.json({
    port: state.port,
    url: state.url,
    status: state.status,
  });
}

// POST — start/stop preview tunnel
export async function POST(req: Request) {
  const { port, action } = await req.json();

  if (action === 'stop' || port === 0) {
    if (state.process) {
      state.process.kill('SIGTERM');
      state.process = null;
    }
    state.port = 0;
    state.url = null;
    state.status = 'stopped';
    saveConfig({ port: 0 });
    return NextResponse.json({ port: 0, url: null, status: 'stopped' });
  }

  const p = parseInt(port) || 0;
  if (!p || p < 1 || p > 65535) {
    return NextResponse.json({ error: 'Invalid port' }, { status: 400 });
  }

  // Kill existing tunnel if any
  if (state.process) {
    state.process.kill('SIGTERM');
    state.process = null;
  }

  const binPath = getCloudflaredPath();
  if (!binPath) {
    return NextResponse.json({ error: 'cloudflared not installed. Start the main tunnel first to auto-download it.' }, { status: 500 });
  }

  state.port = p;
  state.status = 'starting';
  state.url = null;
  saveConfig({ port: p });

  // Start tunnel
  return new Promise<NextResponse>((resolve) => {
    let resolved = false;

    const child = spawn(binPath, ['tunnel', '--url', `http://localhost:${p}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    state.process = child;

    const handleOutput = (data: Buffer) => {
      const text = data.toString();
      const urlMatch = text.match(/(https:\/\/[a-z0-9-]+\.trycloudflare\.com)/);
      if (urlMatch && !state.url) {
        state.url = urlMatch[1];
        state.status = 'running';
        if (!resolved) {
          resolved = true;
          resolve(NextResponse.json({ port: p, url: state.url, status: 'running' }));
        }
      }
    };

    child.stdout?.on('data', handleOutput);
    child.stderr?.on('data', handleOutput);

    child.on('exit', () => {
      state.process = null;
      state.status = 'stopped';
      state.url = null;
      if (!resolved) {
        resolved = true;
        resolve(NextResponse.json({ port: p, url: null, status: 'stopped', error: 'Tunnel exited' }));
      }
    });

    child.on('error', (err) => {
      state.status = 'error';
      if (!resolved) {
        resolved = true;
        resolve(NextResponse.json({ error: err.message }, { status: 500 }));
      }
    });

    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        resolve(NextResponse.json({ port: p, url: null, status: state.status, error: 'Timeout waiting for tunnel URL' }));
      }
    }, 30000);
  });
}
