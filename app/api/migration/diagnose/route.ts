import { NextResponse } from 'next/server';
import { buildDiagnosisContext, renderDiagnosisMarkdown, renderBatchDiagnosis } from '@/lib/migration/diagnose';
import { createTask } from '@/lib/task-manager';

// GET /api/migration/diagnose?projectPath=...&endpointId=... → return diagnosis context + markdown
export async function GET(req: Request) {
  const url = new URL(req.url);
  const projectPath = url.searchParams.get('projectPath');
  const endpointId = url.searchParams.get('endpointId');
  if (!projectPath || !endpointId) return NextResponse.json({ error: 'projectPath + endpointId required' }, { status: 400 });

  const ctx = buildDiagnosisContext(projectPath, endpointId);
  if (!ctx) return NextResponse.json({ error: 'endpoint not found' }, { status: 404 });
  return NextResponse.json({ context: ctx, markdown: renderDiagnosisMarkdown(ctx) });
}

// POST /api/migration/diagnose — body: { projectPath, projectName, endpointIds, mode: 'task'|'preview' }
// Spawns a Forge task seeded with the rendered diagnosis markdown.
export async function POST(req: Request) {
  const { projectPath, projectName, endpointIds, mode = 'task' } = await req.json() as {
    projectPath: string; projectName?: string; endpointIds: string[]; mode?: 'task' | 'preview';
  };
  if (!projectPath || !endpointIds || endpointIds.length === 0) {
    return NextResponse.json({ error: 'projectPath + endpointIds required' }, { status: 400 });
  }

  const ctxs = endpointIds
    .map(id => buildDiagnosisContext(projectPath, id))
    .filter((x): x is NonNullable<typeof x> => !!x);

  if (ctxs.length === 0) return NextResponse.json({ error: 'no endpoints found' }, { status: 404 });

  const prompt = ctxs.length === 1 ? renderDiagnosisMarkdown(ctxs[0]) : renderBatchDiagnosis(ctxs);

  if (mode === 'preview') return NextResponse.json({ prompt, count: ctxs.length });

  const name = projectName || projectPath.split('/').filter(Boolean).pop() || 'project';
  const task = createTask({ projectName: name, projectPath, prompt });
  return NextResponse.json({ ok: true, taskId: task.id, count: ctxs.length });
}
