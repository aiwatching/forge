import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/src/core/db/database';
import { getDbPath } from '@/src/config';

function db() { return getDb(getDbPath()); }

export async function GET(req: NextRequest) {
  const type = req.nextUrl.searchParams.get('type') || 'projects';
  try {
    const row = db().prepare('SELECT data FROM tab_state WHERE type = ?').get(type) as any;
    if (row?.data) return NextResponse.json(JSON.parse(row.data));
  } catch {}
  return NextResponse.json({ tabs: [], activeTabId: 0 });
}

export async function POST(req: NextRequest) {
  const type = req.nextUrl.searchParams.get('type') || 'projects';
  try {
    const body = await req.json();
    db().prepare('INSERT OR REPLACE INTO tab_state (type, data) VALUES (?, ?)').run(type, JSON.stringify(body));
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}
