import { NextResponse } from 'next/server';
import { loadConfig, saveConfig } from '@/lib/migration/store';
import type { MigrationConfig } from '@/lib/migration/types';

// GET /api/migration/config?projectPath=...
export async function GET(req: Request) {
  const url = new URL(req.url);
  const projectPath = url.searchParams.get('projectPath');
  if (!projectPath) return NextResponse.json({ error: 'projectPath required' }, { status: 400 });
  return NextResponse.json(loadConfig(projectPath));
}

// POST /api/migration/config — body: { projectPath, config }
export async function POST(req: Request) {
  const { projectPath, config } = await req.json() as { projectPath: string; config: MigrationConfig };
  if (!projectPath || !config) return NextResponse.json({ error: 'projectPath + config required' }, { status: 400 });
  saveConfig(projectPath, config);
  return NextResponse.json({ ok: true });
}
