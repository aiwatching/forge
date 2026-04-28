import { NextResponse } from 'next/server';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function storageDir(projectPath: string, craft: string): string {
  return join(projectPath, '.forge', 'crafts', craft, 'data');
}

function safeFile(name: string): string | null {
  // Block path traversal; allow alphanumeric + dashes + underscores + .json suffix
  if (!/^[\w.\-]+$/.test(name)) return null;
  return name;
}

// GET /api/crafts/_storage?projectPath=...&craft=...&file=...
export async function GET(req: Request) {
  const u = new URL(req.url);
  const projectPath = u.searchParams.get('projectPath');
  const craft = u.searchParams.get('craft');
  const file = u.searchParams.get('file');
  if (!projectPath || !craft || !file) return NextResponse.json({ error: 'missing args' }, { status: 400 });
  const safe = safeFile(file);
  if (!safe) return NextResponse.json({ error: 'invalid file name' }, { status: 400 });
  const f = join(storageDir(projectPath, craft), safe);
  if (!existsSync(f)) return NextResponse.json({ value: null });
  try { return NextResponse.json({ value: JSON.parse(readFileSync(f, 'utf8')) }); }
  catch { return NextResponse.json({ value: null }); }
}

// POST /api/crafts/_storage?projectPath=...&craft=...&file=...  body: { value }
export async function POST(req: Request) {
  const u = new URL(req.url);
  const projectPath = u.searchParams.get('projectPath');
  const craft = u.searchParams.get('craft');
  const file = u.searchParams.get('file');
  if (!projectPath || !craft || !file) return NextResponse.json({ error: 'missing args' }, { status: 400 });
  const safe = safeFile(file);
  if (!safe) return NextResponse.json({ error: 'invalid file name' }, { status: 400 });
  const dir = storageDir(projectPath, craft);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const { value } = await req.json();
  writeFileSync(join(dir, safe), JSON.stringify(value, null, 2), 'utf8');
  return NextResponse.json({ ok: true });
}
