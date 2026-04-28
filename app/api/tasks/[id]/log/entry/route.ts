import { NextResponse } from 'next/server';
import { getTaskLogEntry } from '@/lib/task-manager';

// GET /api/tasks/[id]/log/entry?i=N — fetch one full log entry, untruncated.
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const url = new URL(req.url);
  const i = Number(url.searchParams.get('i'));
  if (!Number.isFinite(i)) return NextResponse.json({ error: 'i required' }, { status: 400 });
  const entry = getTaskLogEntry(id, i);
  if (!entry) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json(entry);
}
