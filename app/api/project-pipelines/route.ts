import { NextResponse } from 'next/server';
import {
  getBindings,
  addBinding,
  removeBinding,
  updateBinding,
  getRuns,
  deleteRun,
  triggerPipeline,
  getNextRunTime,
} from '@/lib/pipeline-scheduler';
import { listWorkflows } from '@/lib/pipeline';

// GET /api/project-pipelines?project=PATH
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const projectPath = searchParams.get('project');
  if (!projectPath) return NextResponse.json({ error: 'project required' }, { status: 400 });

  const bindings = getBindings(projectPath).map(b => ({
    ...b,
    nextRunAt: getNextRunTime(b),
  }));
  const runs = getRuns(projectPath);
  const workflows = listWorkflows().map(w => ({ name: w.name, description: w.description, builtin: w.builtin }));

  return NextResponse.json({ bindings, runs, workflows });
}

// POST /api/project-pipelines
export async function POST(req: Request) {
  const body = await req.json();

  if (body.action === 'add') {
    const { projectPath, projectName, workflowName, config } = body;
    if (!projectPath || !workflowName) return NextResponse.json({ error: 'projectPath and workflowName required' }, { status: 400 });
    addBinding(projectPath, projectName || projectPath.split('/').pop(), workflowName, config);
    return NextResponse.json({ ok: true });
  }

  if (body.action === 'remove') {
    removeBinding(body.projectPath, body.workflowName);
    return NextResponse.json({ ok: true });
  }

  if (body.action === 'update') {
    updateBinding(body.projectPath, body.workflowName, { enabled: body.enabled, config: body.config });
    return NextResponse.json({ ok: true });
  }

  if (body.action === 'trigger') {
    const { projectPath, projectName, workflowName, input } = body;
    if (!projectPath || !workflowName) return NextResponse.json({ error: 'projectPath and workflowName required' }, { status: 400 });
    try {
      const result = triggerPipeline(projectPath, projectName || projectPath.split('/').pop(), workflowName, input);
      return NextResponse.json({ ok: true, ...result });
    } catch (e: any) {
      return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
    }
  }

  if (body.action === 'delete-run') {
    deleteRun(body.id);
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
}
