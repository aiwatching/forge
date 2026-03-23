import { NextResponse } from 'next/server';
import { getSessionFilePath, readSessionEntries } from '@/lib/claude-sessions';
import { statSync } from 'node:fs';

export async function GET(req: Request, { params }: { params: Promise<{ projectName: string }> }) {
  const { projectName } = await params;
  const url = new URL(req.url);
  const sessionId = url.searchParams.get('sessionId');

  if (!sessionId) {
    return NextResponse.json({ error: 'sessionId required' }, { status: 400 });
  }

  const filePath = getSessionFilePath(decodeURIComponent(projectName), sessionId);
  if (!filePath) {
    return NextResponse.json({ entries: [], count: 0, fileSize: 0 });
  }

  const entries = readSessionEntries(filePath);
  let fileSize = 0;
  try { fileSize = statSync(filePath).size; } catch {}
  return NextResponse.json({ entries, count: entries.length, fileSize });
}
