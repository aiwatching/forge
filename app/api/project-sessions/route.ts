import { NextResponse } from 'next/server';
import { getFixedSession, setFixedSession, clearFixedSession, getAllFixedSessions } from '@/lib/project-sessions';

// GET: get fixed session for a project, or all bindings
export async function GET(req: Request) {
  const url = new URL(req.url);
  const projectPath = url.searchParams.get('projectPath');
  if (projectPath) {
    return NextResponse.json({ projectPath, fixedSessionId: getFixedSession(projectPath) || null });
  }
  return NextResponse.json(getAllFixedSessions());
}

// POST: set fixed session for a project
export async function POST(req: Request) {
  const { projectPath, fixedSessionId } = await req.json();
  if (!projectPath) return NextResponse.json({ error: 'projectPath required' }, { status: 400 });
  if (!fixedSessionId) {
    clearFixedSession(projectPath);
    return NextResponse.json({ ok: true, cleared: true });
  }
  setFixedSession(projectPath, fixedSessionId);
  return NextResponse.json({ ok: true, projectPath, fixedSessionId });
}
