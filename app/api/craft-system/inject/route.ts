import { NextResponse } from 'next/server';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

// POST /api/craft-system/inject  body: { projectPath, text, sessionName? }
// Pastes text into a tmux session and presses Enter. Used by the SDK
// useInject() hook so crafts can hand prompts to the project's bound terminal.

function findBoundSession(projectPath: string): string | null {
  try {
    const sessions = execSync(`tmux list-sessions -F '#{session_name}'`, { encoding: 'utf8', timeout: 2000 })
      .trim().split('\n').filter(Boolean).filter(n => /^mw[a-z0-9]*-/.test(n));
    for (const s of sessions) {
      try {
        const cwd = execSync(`tmux display-message -p -t '${s}' '#{pane_current_path}'`, { encoding: 'utf8', timeout: 2000 }).trim();
        if (cwd === projectPath || cwd.startsWith(projectPath + '/')) return s;
      } catch {}
    }
  } catch {}
  return null;
}

export async function POST(req: Request) {
  const { projectPath, text, sessionName } = await req.json() as { projectPath: string; text: string; sessionName?: string };
  if (!projectPath || !text) return NextResponse.json({ error: 'projectPath + text required' }, { status: 400 });

  const target = sessionName || findBoundSession(projectPath);
  if (!target) return NextResponse.json({ ok: false, error: 'no bound session' }, { status: 404 });

  try {
    const buf = join(tmpdir(), `forge-craft-inject-${Date.now()}.txt`);
    writeFileSync(buf, text);
    execSync(`tmux load-buffer -t "${target}" "${buf}" && tmux paste-buffer -t "${target}" && sleep 0.2 && tmux send-keys -t "${target}" Enter`, { timeout: 5000 });
    try { unlinkSync(buf); } catch {}
    return NextResponse.json({ ok: true, sessionName: target });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}
