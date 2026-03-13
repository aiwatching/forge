import { NextResponse } from 'next/server';
import { ensureInitialized } from '@/lib/init';
import { listWatchers, createWatcher, deleteWatcher, toggleWatcher } from '@/lib/session-watcher';

export async function GET() {
  ensureInitialized();
  return NextResponse.json(listWatchers());
}

export async function POST(req: Request) {
  ensureInitialized();
  const body = await req.json();

  if (body.action === 'delete') {
    deleteWatcher(body.id);
    return NextResponse.json({ ok: true });
  }

  if (body.action === 'toggle') {
    toggleWatcher(body.id, body.active);
    return NextResponse.json({ ok: true });
  }

  // Create new watcher
  const watcher = createWatcher({
    projectName: body.projectName,
    sessionId: body.sessionId,
    label: body.label,
    checkInterval: body.checkInterval || 60,
  });

  return NextResponse.json(watcher);
}
