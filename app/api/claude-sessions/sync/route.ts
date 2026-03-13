import { NextResponse } from 'next/server';
import { ensureInitialized } from '@/lib/init';
import { syncSessionsToDb, getAllCachedSessions } from '@/lib/session-watcher';

export async function GET() {
  ensureInitialized();
  const all = getAllCachedSessions();
  return NextResponse.json(all);
}

export async function POST(req: Request) {
  ensureInitialized();
  const body = await req.json().catch(() => ({}));
  const count = syncSessionsToDb(body.projectName);
  const all = getAllCachedSessions();
  return NextResponse.json({ synced: count, sessions: all });
}
