import { NextResponse } from 'next/server';
import { fetchRegistry } from '@/lib/crafts/registry';

// GET /api/craft-system/registry?refresh=1
// Project-agnostic — returns the raw registry. Used by the global Marketplace
// browser where there's no single project context.
export async function GET(req: Request) {
  const u = new URL(req.url);
  const refresh = u.searchParams.get('refresh') === '1';
  try {
    const items = await fetchRegistry(refresh);
    return NextResponse.json({ items });
  } catch (e: any) {
    return NextResponse.json({ items: [], error: e?.message || String(e) });
  }
}
