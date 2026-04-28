import { NextResponse } from 'next/server';
import { listMarketplace, fetchRegistry } from '@/lib/crafts/registry';

// GET /api/craft-system/marketplace?projectPath=...
// Returns the registry entries with per-project install + compatibility info.
export async function GET(req: Request) {
  const u = new URL(req.url);
  const projectPath = u.searchParams.get('projectPath');
  const refresh = u.searchParams.get('refresh') === '1';
  if (!projectPath) return NextResponse.json({ error: 'projectPath required' }, { status: 400 });
  if (refresh) await fetchRegistry(true);
  try {
    const items = await listMarketplace(projectPath);
    return NextResponse.json({ items });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || String(e), items: [] }, { status: 500 });
  }
}
