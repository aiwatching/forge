import { NextResponse } from 'next/server';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getClaudeDir } from '@/lib/dirs';

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const dir = searchParams.get('dir');
  if (!dir) return NextResponse.json({ sessions: [] });

  // Claude stores sessions at <claudeDir>/projects/<path-with-dashes>/
  const hash = dir.replace(/\//g, '-');
  const claudeDir = join(getClaudeDir(), 'projects', hash);

  if (!existsSync(claudeDir)) {
    return NextResponse.json({ sessions: [] });
  }

  try {
    const files = readdirSync(claudeDir).filter(f => f.endsWith('.jsonl'));
    const sessions = files.map(f => {
      const sessionId = f.replace('.jsonl', '');
      const filePath = join(claudeDir, f);
      const stat = statSync(filePath);

      // Read first line to get first prompt
      let firstPrompt = '';
      try {
        const content = readFileSync(filePath, 'utf-8');
        const lines = content.split('\n').filter(Boolean);
        for (const line of lines) {
          try {
            const entry = JSON.parse(line);
            if (entry.type === 'human' || entry.role === 'user') {
              const text = typeof entry.message === 'string' ? entry.message
                : entry.message?.content?.[0]?.text || '';
              if (text) { firstPrompt = text.slice(0, 80); break; }
            }
          } catch {}
        }
      } catch {}

      return {
        sessionId,
        firstPrompt,
        modified: stat.mtime.toISOString(),
      };
    }).sort((a, b) => b.modified.localeCompare(a.modified));

    return NextResponse.json({ sessions });
  } catch {
    return NextResponse.json({ sessions: [] });
  }
}
