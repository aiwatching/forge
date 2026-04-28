import { NextResponse } from 'next/server';
import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { projectPathToClaudeDir } from '@/lib/claude-sessions';

// GET /api/craft-system/sessions?cwd=<absolute path>
// Returns the Claude sessions stored under that cwd's project encoding.
// Used by CraftTerminalPicker so the user picks among sessions valid in
// the craft's cwd (not the project root's, which are scoped differently).
export async function GET(req: Request) {
  const u = new URL(req.url);
  const cwd = u.searchParams.get('cwd');
  if (!cwd) return NextResponse.json([], { status: 400 });

  const dir = projectPathToClaudeDir(cwd);
  if (!existsSync(dir)) return NextResponse.json([]);

  try {
    const files = readdirSync(dir).filter(f => f.endsWith('.jsonl'));
    const sessions = files.map(f => {
      const sessionId = f.replace('.jsonl', '');
      const fp = join(dir, f);
      const stat = statSync(fp);
      return { id: sessionId, modified: stat.mtime.toISOString(), size: stat.size };
    }).sort((a, b) => b.modified.localeCompare(a.modified));

    // Optional: enrich with sessions-index.json metadata if present
    const idx = join(dir, 'sessions-index.json');
    if (existsSync(idx)) {
      try {
        const data = JSON.parse(readFileSync(idx, 'utf-8'));
        const map = new Map<string, any>();
        for (const e of (data.entries || [])) if (e.sessionId) map.set(e.sessionId, e);
        for (const s of sessions) {
          const m = map.get(s.id);
          if (m?.firstPrompt) (s as any).firstPrompt = m.firstPrompt;
          if (m?.summary) (s as any).summary = m.summary;
        }
      } catch {}
    }
    return NextResponse.json(sessions);
  } catch {
    return NextResponse.json([]);
  }
}
