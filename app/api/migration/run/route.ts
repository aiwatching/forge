import { NextResponse } from 'next/server';
import { loadConfig, loadEndpoints, saveRun } from '@/lib/migration/store';
import { runEndpoint } from '@/lib/migration/runner';

// POST /api/migration/run — body: { projectPath, endpointId }
export async function POST(req: Request) {
  const { projectPath, endpointId } = await req.json() as { projectPath: string; endpointId: string };
  if (!projectPath || !endpointId) return NextResponse.json({ error: 'projectPath + endpointId required' }, { status: 400 });

  const eps = loadEndpoints(projectPath);
  const ep = eps.find(e => e.id === endpointId);
  if (!ep) return NextResponse.json({ error: 'endpoint not found' }, { status: 404 });

  const config = loadConfig(projectPath);
  const result = await runEndpoint(ep, config);
  saveRun(projectPath, [result]);
  return NextResponse.json(result);
}
