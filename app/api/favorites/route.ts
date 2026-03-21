import { NextResponse } from 'next/server';
import { getDb } from '@/src/core/db/database';
import { getDbPath } from '@/src/config';

function db() { return getDb(getDbPath()); }

// GET /api/favorites — list all favorites
export async function GET() {
  const rows = db().prepare('SELECT project_path FROM project_favorites ORDER BY created_at ASC').all() as any[];
  return NextResponse.json(rows.map(r => r.project_path));
}

// POST /api/favorites — add or remove
export async function POST(req: Request) {
  const { action, projectPath } = await req.json();
  if (!projectPath) return NextResponse.json({ error: 'projectPath required' }, { status: 400 });

  if (action === 'add') {
    db().prepare('INSERT OR IGNORE INTO project_favorites (project_path) VALUES (?)').run(projectPath);
  } else if (action === 'remove') {
    db().prepare('DELETE FROM project_favorites WHERE project_path = ?').run(projectPath);
  }

  const rows = db().prepare('SELECT project_path FROM project_favorites ORDER BY created_at ASC').all() as any[];
  return NextResponse.json(rows.map(r => r.project_path));
}
