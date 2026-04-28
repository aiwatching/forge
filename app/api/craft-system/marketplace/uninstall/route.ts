import { NextResponse } from 'next/server';
import { uninstallCraft } from '@/lib/crafts/registry';

// POST /api/craft-system/marketplace/uninstall   body: { projectPath, name }
export async function POST(req: Request) {
  const { projectPath, name } = await req.json() as { projectPath: string; name: string };
  if (!projectPath || !name) return NextResponse.json({ error: 'projectPath + name required' }, { status: 400 });
  const r = uninstallCraft(name, projectPath);
  return NextResponse.json(r, { status: r.ok ? 200 : 400 });
}
