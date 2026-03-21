import { NextResponse } from 'next/server';
import { existsSync, statSync, openSync, readSync, closeSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { getDataDir } from '@/lib/dirs';
import { execSync } from 'node:child_process';

const LOG_FILE = join(getDataDir(), 'forge.log');
const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5MB — auto-rotate above this

/** Read last N bytes from file (efficient tail) */
function tailFile(filePath: string, maxBytes: number): string {
  const stat = statSync(filePath);
  const size = stat.size;
  const readSize = Math.min(size, maxBytes);
  const buf = Buffer.alloc(readSize);
  const fd = openSync(filePath, 'r');
  readSync(fd, buf, 0, readSize, size - readSize);
  closeSync(fd);
  // Skip partial first line
  const str = buf.toString('utf-8');
  const firstNewline = str.indexOf('\n');
  return firstNewline > 0 ? str.slice(firstNewline + 1) : str;
}

/** Rotate log if too large: forge.log → forge.log.old, start fresh */
function rotateIfNeeded() {
  if (!existsSync(LOG_FILE)) return;
  const stat = statSync(LOG_FILE);
  if (stat.size > MAX_LOG_SIZE) {
    const oldFile = LOG_FILE + '.old';
    try { renameSync(LOG_FILE, oldFile); } catch {}
    writeFileSync(LOG_FILE, `[forge] Log rotated at ${new Date().toISOString()} (previous: ${(stat.size / 1024 / 1024).toFixed(1)}MB)\n`, 'utf-8');
  }
}

// GET /api/logs?lines=200&search=keyword
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const lines = Math.min(parseInt(searchParams.get('lines') || '200'), 1000);
  const search = searchParams.get('search') || '';

  rotateIfNeeded();

  if (!existsSync(LOG_FILE)) {
    return NextResponse.json({ lines: [], total: 0, size: 0 });
  }

  try {
    const stat = statSync(LOG_FILE);
    // Read last 512KB max (enough for ~5000 lines)
    const raw = tailFile(LOG_FILE, 512 * 1024);
    let allLines = raw.split('\n').filter(Boolean);

    if (search) {
      allLines = allLines.filter(l => l.toLowerCase().includes(search.toLowerCase()));
    }

    const result = allLines.slice(-lines);

    return NextResponse.json({
      lines: result,
      total: allLines.length,
      size: stat.size,
      file: LOG_FILE,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

// POST /api/logs — actions
export async function POST(req: Request) {
  const body = await req.json();

  if (body.action === 'clear') {
    try {
      writeFileSync(LOG_FILE, `[forge] Log cleared at ${new Date().toISOString()}\n`, 'utf-8');
      return NextResponse.json({ ok: true });
    } catch (e: any) {
      return NextResponse.json({ error: e.message }, { status: 500 });
    }
  }

  if (body.action === 'processes') {
    try {
      const out = execSync("ps aux | grep -E 'next-server|telegram-standalone|terminal-standalone|cloudflared' | grep -v grep", {
        encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      const processes = out.split('\n').filter(Boolean).map(line => {
        const parts = line.trim().split(/\s+/);
        return { pid: parts[1], cpu: parts[2], mem: parts[3], cmd: parts.slice(10).join(' ').slice(0, 80) };
      });
      return NextResponse.json({ processes });
    } catch {
      return NextResponse.json({ processes: [] });
    }
  }

  return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
}
