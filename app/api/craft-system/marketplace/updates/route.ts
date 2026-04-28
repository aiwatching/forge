import { NextResponse } from 'next/server';
import { listAvailableUpdates } from '@/lib/crafts/registry';

// GET /api/craft-system/marketplace/updates?projectPath=...
// Returns the (potentially empty) list of installed crafts with newer versions.
// Cheap — used by the Crafts dropdown badge.
export async function GET(req: Request) {
  const u = new URL(req.url);
  const projectPath = u.searchParams.get('projectPath');
  if (!projectPath) return NextResponse.json({ updates: [] });
  try {
    const updates = await listAvailableUpdates(projectPath);
    return NextResponse.json({ updates });
  } catch (e: any) {
    return NextResponse.json({ updates: [], error: e?.message || String(e) });
  }
}
