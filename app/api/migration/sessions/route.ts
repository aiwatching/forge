import { NextResponse } from 'next/server';
import { execSync } from 'node:child_process';
import { realpathSync } from 'node:fs';

// GET /api/migration/sessions?projectPath=...
// Returns active tmux sessions whose first pane's cwd is at or under projectPath.
// Used by the cockpit to default-inject to the project's bound terminal.

interface SessionInfo {
  name: string;
  cwd: string;
  windows: number;
  attached: boolean;
}

function listMwSessions(): { name: string; windows: number; attached: boolean }[] {
  try {
    const out = execSync(
      `tmux list-sessions -F '#{session_name}|#{session_windows}|#{session_attached}'`,
      { timeout: 2000, encoding: 'utf8' }
    );
    return out.trim().split('\n').filter(Boolean).map(line => {
      const [name, w, att] = line.split('|');
      return { name, windows: Number(w) || 1, attached: att === '1' };
    }).filter(s => /^mw[a-z0-9]*-/.test(s.name));
  } catch {
    return [];
  }
}

function paneCwd(name: string): string | null {
  try {
    const out = execSync(`tmux display-message -p -t '${name}' '#{pane_current_path}'`, {
      timeout: 2000, encoding: 'utf8',
    });
    return out.trim();
  } catch {
    return null;
  }
}

function normalize(p: string): string {
  try { return realpathSync(p); } catch { return p; }
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const projectPath = url.searchParams.get('projectPath');
  if (!projectPath) return NextResponse.json({ error: 'projectPath required' }, { status: 400 });

  const target = normalize(projectPath).replace(/\/+$/, '');
  const all = listMwSessions();
  const matches: SessionInfo[] = [];
  const others: SessionInfo[] = [];

  for (const s of all) {
    const cwd = paneCwd(s.name);
    if (!cwd) continue;
    const real = normalize(cwd);
    const info: SessionInfo = { name: s.name, cwd: real, windows: s.windows, attached: s.attached };
    if (real === target || real.startsWith(target + '/')) matches.push(info);
    else others.push(info);
  }

  // Prefer attached sessions first, then by name (newest mw-* tend to sort later)
  matches.sort((a, b) => Number(b.attached) - Number(a.attached) || a.name.localeCompare(b.name));
  return NextResponse.json({ matches, others });
}
