import { NextResponse } from 'next/server';
import { loadConfig, loadEndpoints, saveRun } from '@/lib/migration/store';
import { runEndpoint } from '@/lib/migration/runner';
import { loadOpenApi } from '@/lib/migration/openapi';

// POST /api/migration/run — body: { projectPath, endpointId }
export async function POST(req: Request) {
  const { projectPath, endpointId } = await req.json() as { projectPath: string; endpointId: string };
  if (!projectPath || !endpointId) return NextResponse.json({ error: 'projectPath + endpointId required' }, { status: 400 });

  const eps = loadEndpoints(projectPath);
  const ep = eps.find(e => e.id === endpointId);
  if (!ep) return NextResponse.json({ error: 'endpoint not found' }, { status: 404 });

  const config = loadConfig(projectPath);
  const openApi = config.endpointSource.openApiSpec
    ? loadOpenApi(projectPath, config.endpointSource.openApiSpec)
    : null;
  const result = await runEndpoint(ep, config, openApi);
  saveRun(projectPath, [result]);
  return NextResponse.json(result);
}
