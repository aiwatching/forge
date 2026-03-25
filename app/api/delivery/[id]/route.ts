import { NextResponse } from 'next/server';
import {
  getDelivery, cancelDelivery, deleteDelivery,
  approveDeliveryPhase, rejectDeliveryPhase,
  sendToAgent, retryPhase,
} from '@/lib/delivery';
import { listArtifacts, getArtifact } from '@/lib/artifacts';
import type { PhaseName } from '@/lib/delivery';

// GET /api/delivery/:id — get delivery state + artifacts
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const delivery = getDelivery(id);
  if (!delivery) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const artifacts = listArtifacts(id);
  return NextResponse.json({ ...delivery, artifacts });
}

// POST /api/delivery/:id — actions
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json();
  const { action } = body;

  if (action === 'cancel') {
    return NextResponse.json({ ok: cancelDelivery(id) });
  }

  if (action === 'delete') {
    return NextResponse.json({ ok: deleteDelivery(id) });
  }

  if (action === 'approve') {
    return NextResponse.json({ ok: approveDeliveryPhase(id, body.feedback) });
  }

  if (action === 'reject') {
    if (!body.feedback) return NextResponse.json({ error: 'feedback required' }, { status: 400 });
    return NextResponse.json({ ok: rejectDeliveryPhase(id, body.feedback) });
  }

  if (action === 'send') {
    const { phase, message } = body;
    if (!phase || !message) return NextResponse.json({ error: 'phase and message required' }, { status: 400 });
    return NextResponse.json({ ok: sendToAgent(id, phase as PhaseName, message) });
  }

  if (action === 'retry') {
    const { phase } = body;
    if (!phase) return NextResponse.json({ error: 'phase required' }, { status: 400 });
    return NextResponse.json({ ok: retryPhase(id, phase as PhaseName) });
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
}

// DELETE /api/delivery/:id
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return NextResponse.json({ ok: deleteDelivery(id) });
}
