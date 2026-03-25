import { NextResponse } from 'next/server';
import { getPipeline, cancelPipeline, deletePipeline, injectConversationMessage } from '@/lib/pipeline';

// GET /api/pipelines/:id
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const pipeline = getPipeline(id);
  if (!pipeline) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json(pipeline);
}

// POST /api/pipelines/:id — actions (cancel, delete, inject)
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json();
  const { action } = body;

  if (action === 'cancel') {
    const ok = cancelPipeline(id);
    return NextResponse.json({ ok });
  }

  if (action === 'delete') {
    const ok = deletePipeline(id);
    return NextResponse.json({ ok });
  }

  // Inject a message into a running conversation
  if (action === 'inject') {
    const { agentId, message } = body;
    if (!agentId || !message) return NextResponse.json({ error: 'agentId and message required' }, { status: 400 });
    try {
      const ok = injectConversationMessage(id, agentId, message);
      return NextResponse.json({ ok });
    } catch (e: any) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
}
