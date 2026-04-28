import { NextResponse } from 'next/server';
import { listProjectCrafts, shouldShow } from '@/lib/crafts/loader';

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
  })) });
}
