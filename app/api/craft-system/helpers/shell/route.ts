import { NextResponse } from 'next/server';
import { execSync } from 'node:child_process';

// POST /api/crafts/_helpers/shell?projectPath=...   body: { cmd, timeout? }
export async function POST(req: Request) {
  const u = new URL(req.url);
  const projectPath = u.searchParams.get('projectPath');
  if (!projectPath) return NextResponse.json({ error: 'projectPath required' }, { status: 400 });
  const { cmd, timeout } = await req.json() as { cmd: string; timeout?: number };
  if (!cmd) return NextResponse.json({ error: 'cmd required' }, { status: 400 });
  try {
    const stdout = execSync(cmd, {
      cwd: projectPath,
      timeout: timeout ?? 30000,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    }).toString();
    return NextResponse.json({ stdout, stderr: '', code: 0 });
  } catch (e: any) {
    return NextResponse.json({
      stdout: (e?.stdout || '').toString(),
      stderr: (e?.stderr || e?.message || '').toString(),
      code: e?.status ?? 1,
    });
  }
}
