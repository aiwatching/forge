import { NextResponse } from 'next/server';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { getDataDir } from '@/lib/dirs';

function getTemplatesDir(): string {
  const dir = join(getDataDir(), 'smith-templates');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export interface SmithTemplate {
  id: string;
  name: string;
  icon: string;
  description?: string;
  config: Record<string, any>; // agent config without id/dependsOn/boundSessionId
  createdAt: number;
  updatedAt: number;
}

// List all smith templates
export async function GET() {
  const dir = getTemplatesDir();
  const files = readdirSync(dir).filter(f => f.endsWith('.json'));
  const templates: SmithTemplate[] = [];
  for (const f of files) {
    try {
      const data = JSON.parse(readFileSync(join(dir, f), 'utf-8'));
      templates.push(data);
    } catch {}
  }
  templates.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return NextResponse.json({ templates });
}

// Save or delete a smith template
export async function POST(req: Request) {
  const body = await req.json();
  const { action } = body;

  if (action === 'delete') {
    const { id } = body;
    if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });
    const fp = join(getTemplatesDir(), `${id}.json`);
    if (existsSync(fp)) unlinkSync(fp);
    return NextResponse.json({ ok: true });
  }

  // Save (create or update)
  const { config, name, icon, description } = body;
  if (!config || !name) {
    return NextResponse.json({ error: 'config and name required' }, { status: 400 });
  }

  // Strip runtime/instance-specific fields
  const cleanConfig = { ...config };
  delete cleanConfig.id;
  delete cleanConfig.dependsOn;
  delete cleanConfig.boundSessionId;
  delete cleanConfig.tmuxSession;
  delete cleanConfig.content;
  delete cleanConfig.entries;
  delete cleanConfig.type;

  const id = body.id || `smith-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`;
  const now = Date.now();

  const template: SmithTemplate = {
    id,
    name: name.trim(),
    icon: icon || cleanConfig.icon || '🤖',
    description: description?.trim() || '',
    config: cleanConfig,
    createdAt: body.id ? (body.createdAt || now) : now,
    updatedAt: now,
  };

  writeFileSync(join(getTemplatesDir(), `${id}.json`), JSON.stringify(template, null, 2));
  return NextResponse.json({ ok: true, template });
}
