import { NextResponse } from 'next/server';
import { createDelivery, listDeliveries, ROLE_PRESETS } from '@/lib/delivery';

// GET /api/delivery — list deliveries, or get role presets
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);

  if (searchParams.get('type') === 'presets') {
    return NextResponse.json(ROLE_PRESETS);
  }

  const deliveries = listDeliveries();
  return NextResponse.json(deliveries);
}

// POST /api/delivery — create new delivery
export async function POST(req: Request) {
  const body = await req.json();
  const { title, project, projectPath, prUrl, description, agentId, phases } = body;

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
      customPhases: phases,  // user-defined phases
    });

    return NextResponse.json(delivery);
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
