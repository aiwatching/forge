import { NextResponse } from 'next/server';
import { createHash } from 'node:crypto';
import { listProjectCrafts, shouldShow } from '@/lib/crafts/loader';

function tmuxSessionName(projectPath: string, craftName: string): string {
  const projHash = createHash('md5').update(projectPath).digest('hex').slice(0, 6);
  return `mw-craft-${projHash}-${craftName}`;
}

// GET /api/crafts?projectPath=...
export async function GET(req: Request) {
  const url = new URL(req.url);
  const projectPath = url.searchParams.get('projectPath');
  if (!projectPath) return NextResponse.json({ error: 'projectPath required' }, { status: 400 });
  const all = listProjectCrafts(projectPath);
  const visible = all.filter(c => shouldShow(c, projectPath));
  return NextResponse.json({ crafts: visible.map(c => ({
    name: c.name,
    displayName: c.displayName || c.name,
    icon: c.icon,
    description: c.description,
    version: c.version,
    scope: c.__scope,
    hasUi: c.hasUi,
    hasServer: c.hasServer,
    dir: c.__dir,
    preferredSessionName: tmuxSessionName(projectPath, c.name),
  })) });
}
