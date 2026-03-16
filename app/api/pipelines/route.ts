import { NextResponse } from 'next/server';
import { listPipelines, listWorkflows, startPipeline } from '@/lib/pipeline';

// GET /api/pipelines — list all pipelines + available workflows
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const type = searchParams.get('type');

  if (type === 'workflows') {
    return NextResponse.json(listWorkflows());
  }

  return NextResponse.json(listPipelines().sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
}

// POST /api/pipelines — start a new pipeline
export async function POST(req: Request) {
  const { workflow, input } = await req.json();

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
