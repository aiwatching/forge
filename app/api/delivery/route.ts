import { NextResponse } from 'next/server';
import { createDelivery, listDeliveries } from '@/lib/delivery';
import { listArtifacts } from '@/lib/artifacts';

// GET /api/delivery — list all deliveries
export async function GET() {
  const deliveries = listDeliveries();
  return NextResponse.json(deliveries);
}

// POST /api/delivery — create new delivery
export async function POST(req: Request) {
  const body = await req.json();
  const { title, project, projectPath, prUrl, description, agentId } = body;

  if (!project || !projectPath) {
    return NextResponse.json({ error: 'project and projectPath required' }, { status: 400 });
  }

  try {
    const delivery = createDelivery({
      title: title || description?.slice(0, 50) || 'Delivery',
      project,
      projectPath,
      prUrl,
      description,
      agentId,
    });

    return NextResponse.json(delivery);
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
