import { NextResponse } from 'next/server';
import { listPipelines, listWorkflows, startPipeline } from '@/lib/pipeline';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { getDataDir } from '@/lib/dirs';

const FLOWS_DIR = join(getDataDir(), 'flows');

// GET /api/pipelines — list all pipelines + available workflows
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const type = searchParams.get('type');

  if (type === 'workflows') {
    return NextResponse.json(listWorkflows());
  }

  if (type === 'workflow-yaml') {
    const name = searchParams.get('name');
    if (!name) return NextResponse.json({ error: 'name required' }, { status: 400 });
    try {
      const { readFileSync, existsSync } = await import('node:fs');
      const filePath = join(FLOWS_DIR, `${name}.yaml`);
      const altPath = join(FLOWS_DIR, `${name}.yml`);
      const path = existsSync(filePath) ? filePath : existsSync(altPath) ? altPath : null;
      if (path) {
        return NextResponse.json({ yaml: readFileSync(path, 'utf-8') });
      }
      // Check built-in workflows
      const workflow = listWorkflows().find(w => w.name === name);
      if (workflow?.builtin) {
        const { BUILTIN_WORKFLOWS } = await import('@/lib/pipeline');
        const yaml = BUILTIN_WORKFLOWS[name];
        if (yaml) return NextResponse.json({ yaml: yaml.trim(), builtin: true });
      }
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    } catch {
      return NextResponse.json({ error: 'Failed to read' }, { status: 500 });
    }
  }

  return NextResponse.json(listPipelines().sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
}

// POST /api/pipelines — start a pipeline or save a workflow
export async function POST(req: Request) {
  const body = await req.json();

  // Save workflow YAML from visual editor
  if (body.action === 'save-workflow' && body.yaml) {
    try {
      mkdirSync(FLOWS_DIR, { recursive: true });
      const parsed = YAML.parse(body.yaml);
      const name = parsed.name || 'unnamed';
      const filePath = join(FLOWS_DIR, `${name}.yaml`);
      writeFileSync(filePath, body.yaml, 'utf-8');
      return NextResponse.json({ ok: true, name, path: filePath });
    } catch (e: any) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
  }

  // Start pipeline
  const { workflow, input } = body;
  if (!workflow) {
    return NextResponse.json({ error: 'workflow name required' }, { status: 400 });
  }

  try {
    const pipeline = startPipeline(workflow, input || {});
    return NextResponse.json(pipeline);
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 400 });
  }
}
