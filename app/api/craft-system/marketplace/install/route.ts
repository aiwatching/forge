import { NextResponse } from 'next/server';
import { installCraft, invalidateRegistry } from '@/lib/crafts/registry';

// POST /api/craft-system/marketplace/install   body: { projectPath, name }
export async function POST(req: Request) {
  const { projectPath, name } = await req.json() as { projectPath: string; name: string };
  if (!projectPath || !name) return NextResponse.json({ error: 'projectPath + name required' }, { status: 400 });
  invalidateRegistry();           // bust cache so the next listMarketplace sees fresh state
  const r = await installCraft(name, projectPath);
  return NextResponse.json(r, { status: r.ok ? 200 : 400 });
}
