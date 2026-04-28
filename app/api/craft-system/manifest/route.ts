import { NextResponse } from 'next/server';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as YAML from 'yaml';
import { getCraft } from '@/lib/crafts/loader';

// GET /api/craft-system/manifest?projectPath=...&name=...
// Returns the raw craft.yaml + parsed object so the editor can show both.
export async function GET(req: Request) {
  const u = new URL(req.url);
  const projectPath = u.searchParams.get('projectPath');
  const name = u.searchParams.get('name');
  if (!projectPath || !name) return NextResponse.json({ error: 'projectPath + name required' }, { status: 400 });

  const c = getCraft(projectPath, name);
  if (!c || c.__scope !== 'project') return NextResponse.json({ error: 'craft not found in this project' }, { status: 404 });

  const file = join(c.__dir, 'craft.yaml');
  if (!existsSync(file)) return NextResponse.json({ error: 'craft.yaml missing' }, { status: 404 });

  const raw = readFileSync(file, 'utf8');
  let parsed: any = null;
  try { parsed = YAML.parse(raw); } catch (e: any) {
    return NextResponse.json({ raw, parsed: null, parseError: e?.message });
  }
  return NextResponse.json({ raw, parsed });
}

// PUT /api/craft-system/manifest   body: { projectPath, name, raw } OR { projectPath, name, patch: {...} }
// `raw` overwrites the whole file. `patch` shallow-merges fields into the parsed manifest
// then re-serializes (preserves any unknown keys in the existing yaml).
export async function PUT(req: Request) {
  const body = await req.json() as { projectPath: string; name: string; raw?: string; patch?: any };
  const { projectPath, name, raw, patch } = body;
  if (!projectPath || !name) return NextResponse.json({ error: 'projectPath + name required' }, { status: 400 });
  if (!raw && !patch) return NextResponse.json({ error: 'raw or patch required' }, { status: 400 });

  const c = getCraft(projectPath, name);
  if (!c || c.__scope !== 'project') return NextResponse.json({ error: 'craft not found in this project' }, { status: 404 });

  const file = join(c.__dir, 'craft.yaml');

  let nextRaw: string;
  if (raw) {
    // Validate the raw YAML still parses + has a name field
    try {
      const m = YAML.parse(raw);
      if (!m || typeof m !== 'object' || m.name !== name) {
        return NextResponse.json({ error: 'craft.yaml must keep the same name field' }, { status: 400 });
      }
    } catch (e: any) {
      return NextResponse.json({ error: `YAML parse error: ${e?.message}` }, { status: 400 });
    }
    nextRaw = raw;
  } else {
    // Patch mode — read current, merge, re-serialize
    const current = existsSync(file) ? (YAML.parse(readFileSync(file, 'utf8')) || {}) : {};
    if (patch.name && patch.name !== name) {
      return NextResponse.json({ error: 'cannot rename a craft via patch (delete + recreate instead)' }, { status: 400 });
    }
    const merged = { ...current, ...patch, name };  // name pinned
    // Drop empty arrays/strings that user explicitly cleared so yaml stays clean
    for (const k of Object.keys(merged)) {
      if (merged[k] === '' || (Array.isArray(merged[k]) && merged[k].length === 0)) delete merged[k];
    }
    nextRaw = YAML.stringify(merged);
  }

  writeFileSync(file, nextRaw, 'utf8');
  return NextResponse.json({ ok: true, raw: nextRaw });
}
