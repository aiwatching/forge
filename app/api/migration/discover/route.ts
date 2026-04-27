import { NextResponse } from 'next/server';
import { discoverEndpoints } from '@/lib/migration/discoverer';
import { loadConfig, saveEndpoints, loadEndpoints } from '@/lib/migration/store';

// GET /api/migration/discover?projectPath=...  → return cached endpoints
export async function GET(req: Request) {
  const url = new URL(req.url);
  const projectPath = url.searchParams.get('projectPath');
  if (!projectPath) return NextResponse.json({ error: 'projectPath required' }, { status: 400 });
  return NextResponse.json({ endpoints: loadEndpoints(projectPath) });
}

// POST /api/migration/discover — body: { projectPath } → re-scan docs
export async function POST(req: Request) {
  const { projectPath } = await req.json() as { projectPath: string };
  if (!projectPath) return NextResponse.json({ error: 'projectPath required' }, { status: 400 });
  const config = loadConfig(projectPath);
  const result = discoverEndpoints(projectPath, config);
  saveEndpoints(projectPath, result.endpoints);
  return NextResponse.json({
    endpoints: result.endpoints,
    warnings: result.warnings,
    sources: result.sources,
    total: result.endpoints.length,
  });
}
