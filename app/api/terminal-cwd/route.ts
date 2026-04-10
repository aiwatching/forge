import { NextResponse } from 'next/server';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const session = searchParams.get('session');
  if (!session || !session.startsWith('mw-')) {
    return NextResponse.json({ path: null });
  }
  try {
    const { stdout } = await execAsync(`tmux display-message -p -t ${session} '#{pane_current_path}'`, {
      encoding: 'utf-8',
      timeout: 3000,
    });
    return NextResponse.json({ path: stdout.trim() || null });
  } catch {
    return NextResponse.json({ path: null });
  }
}
