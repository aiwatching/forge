import { NextResponse } from 'next/server';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { getDataDir, getConfigDir } from '@/lib/dirs';

const CONFIG_FILE = join(getDataDir(), 'preview.json');

interface PreviewEntry {
  port: number;
  url: string | null;
  status: string;
  label?: string;
}

// Persist state across hot-reloads
const stateKey = Symbol.for('mw-preview-state');
const g = globalThis as any;
if (!g[stateKey]) g[stateKey] = { entries: new Map<number, { process: ChildProcess | null; url: string | null; status: string; label: string }>() };
const state: { entries: Map<number, { process: ChildProcess | null; url: string | null; status: string; label: string }> } = g[stateKey];

function getConfig(): PreviewEntry[] {
  try {
    const data = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
    return Array.isArray(data) ? data : data.port ? [data] : [];
  } catch {
    return [];
  }
}

function saveConfig(entries: PreviewEntry[]) {
  const dir = dirname(CONFIG_FILE);
  mkdirSync(dir, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(entries, null, 2));
}

function getCloudflaredPath(): string | null {
  const binPath = join(getConfigDir(), 'bin', 'cloudflared');
  if (existsSync(binPath)) return binPath;
  try {
    return execSync('which cloudflared', { encoding: 'utf-8' }).trim();
  } catch {
    return null;
  }
}

// GET — list all previews
export async function GET() {
  const entries: PreviewEntry[] = [];
  for (const [port, s] of state.entries) {
    entries.push({ port, url: s.url, status: s.status, label: s.label });
  }
  return NextResponse.json(entries);
}

// POST — start/stop/manage previews
export async function POST(req: Request) {
  const body = await req.json();

  // Stop a preview
  if (body.action === 'stop' && body.port) {
    const entry = state.entries.get(body.port);
    if (entry?.process) {
      entry.process.kill('SIGTERM');
    }
    state.entries.delete(body.port);
    syncConfig();
    return NextResponse.json({ ok: true });
  }

  // Start a new preview
  if (body.action === 'start' && body.port) {
    const port = parseInt(body.port);
    if (!port || port < 1 || port > 65535) {
      return NextResponse.json({ error: 'Invalid port' }, { status: 400 });
    }

    // Already running?
    const existing = state.entries.get(port);
    if (existing && existing.status === 'running') {
      return NextResponse.json({ port, url: existing.url, status: 'running', label: existing.label });
    }

    const binPath = getCloudflaredPath();
    if (!binPath) {
      return NextResponse.json({ error: 'cloudflared not installed. Start the main tunnel first.' }, { status: 500 });
    }

    const label = body.label || `localhost:${port}`;
    state.entries.set(port, { process: null, url: null, status: 'starting', label });
    syncConfig();

    // Start tunnel
    return new Promise<NextResponse>((resolve) => {
      let resolved = false;
      const child = spawn(binPath, ['tunnel', '--url', `http://localhost:${port}`], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const entry = state.entries.get(port)!;
      entry.process = child;

      const handleOutput = (data: Buffer) => {
        const urlMatch = data.toString().match(/(https:\/\/[a-z0-9-]+\.trycloudflare\.com)/);
        if (urlMatch && !entry.url) {
          entry.url = urlMatch[1];
          entry.status = 'running';
          syncConfig();
          if (!resolved) {
            resolved = true;
            resolve(NextResponse.json({ port, url: entry.url, status: 'running', label }));
          }
        }
      };

      child.stdout?.on('data', handleOutput);
      child.stderr?.on('data', handleOutput);

      child.on('exit', () => {
        entry.process = null;
        entry.status = 'stopped';
        entry.url = null;
        syncConfig();
        if (!resolved) {
          resolved = true;
          resolve(NextResponse.json({ port, url: null, status: 'stopped', error: 'Tunnel exited' }));
        }
      });

      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          resolve(NextResponse.json({ port, url: null, status: entry.status, error: 'Timeout' }));
        }
      }, 30000);
    });
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
}

function syncConfig() {
  const entries: PreviewEntry[] = [];
  for (const [port, s] of state.entries) {
    entries.push({ port, url: s.url, status: s.status, label: s.label });
  }
  saveConfig(entries);
}
