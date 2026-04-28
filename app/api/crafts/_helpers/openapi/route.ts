import { NextResponse } from 'next/server';
import { existsSync, readFileSync } from 'node:fs';
import { join, normalize } from 'node:path';

// GET /api/crafts/_helpers/openapi?projectPath=...&path=docs/openapi.json
export async function GET(req: Request) {
  const u = new URL(req.url);
  const projectPath = u.searchParams.get('projectPath');
  const path = u.searchParams.get('path');
  if (!projectPath || !path) return NextResponse.json({ error: 'projectPath + path required' }, { status: 400 });

  // Path traversal guard
  const full = normalize(join(projectPath, path));
  if (!full.startsWith(projectPath)) return NextResponse.json({ error: 'invalid path' }, { status: 400 });
  if (!existsSync(full)) return NextResponse.json({ spec: null, paths: [], schemas: {} });

  try {
    const spec = JSON.parse(readFileSync(full, 'utf8'));
    return NextResponse.json({
      spec,
      paths: Object.keys(spec.paths || {}),
      schemas: spec.components?.schemas || {},
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 });
  }
}
