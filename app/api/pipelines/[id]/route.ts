import { NextResponse } from 'next/server';
import { getPipeline, cancelPipeline, deletePipeline } from '@/lib/pipeline';

// GET /api/pipelines/:id
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const pipeline = getPipeline(id);
  if (!pipeline) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json(pipeline);
}

// POST /api/pipelines/:id — actions (cancel)
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { action } = await req.json();

  if (action === 'cancel') {
    const ok = cancelPipeline(id);
    return NextResponse.json({ ok });
  }

  if (action === 'delete') {
    const ok = deletePipeline(id);
    return NextResponse.json({ ok });
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
}
