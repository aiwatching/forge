import { NextResponse } from 'next/server';
import { rmSync, existsSync } from 'node:fs';
import { join, normalize } from 'node:path';
import { getCraft } from '@/lib/crafts/loader';

// DELETE /api/craft-system/delete?projectPath=...&name=...
// Deletes <project>/.forge/crafts/<name>/. Cannot delete builtin crafts.
export async function DELETE(req: Request) {
  const u = new URL(req.url);
  const projectPath = u.searchParams.get('projectPath');
  const name = u.searchParams.get('name');
  if (!projectPath || !name) return NextResponse.json({ error: 'projectPath + name required' }, { status: 400 });

  const c = getCraft(projectPath, name);
  if (!c) return NextResponse.json({ error: 'craft not found' }, { status: 404 });
  if (c.__scope === 'builtin') return NextResponse.json({ error: 'builtin crafts cannot be deleted (only project-local ones)' }, { status: 400 });

  const target = join(projectPath, '.forge', 'crafts', name);
  // Path-traversal guard
  const normalized = normalize(target);
  if (!normalized.startsWith(join(projectPath, '.forge', 'crafts'))) {
    return NextResponse.json({ error: 'invalid path' }, { status: 400 });
  }
  if (!existsSync(normalized)) return NextResponse.json({ ok: true, alreadyMissing: true });

  rmSync(normalized, { recursive: true, force: true });
  return NextResponse.json({ ok: true });
}
