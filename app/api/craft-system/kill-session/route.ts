import { NextResponse } from 'next/server';
import { execSync } from 'node:child_process';

// POST /api/craft-system/kill-session  body: { sessionName }
// Used when the user re-picks an agent/session for a craft and wants the
// existing tmux session torn down so CraftTerminal can recreate it with
// the new --resume flag.
export async function POST(req: Request) {
  const { sessionName } = await req.json() as { sessionName?: string };
  if (!sessionName) return NextResponse.json({ error: 'sessionName required' }, { status: 400 });
  // Safety: only craft sessions can be killed via this route.
  if (!sessionName.startsWith('mw-craft-')) {
    return NextResponse.json({ error: 'refusing to kill non-craft session' }, { status: 400 });
  }
  try {
    execSync(`tmux kill-session -t "${sessionName}" 2>/dev/null`, { timeout: 3000 });
  } catch {}
  return NextResponse.json({ ok: true });
}
