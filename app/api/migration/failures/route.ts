import { NextResponse } from 'next/server';
import { loadFailures } from '@/lib/migration/store';
import type { Failure, FailureCluster } from '@/lib/migration/types';

function cluster(failures: Failure[]): FailureCluster[] {
  const byType = new Map<string, Map<string, Failure[]>>();
  for (const f of failures) {
    let m = byType.get(f.errorType);
    if (!m) { m = new Map(); byType.set(f.errorType, m); }
    let arr = m.get(f.controller);
    if (!arr) { arr = []; m.set(f.controller, arr); }
    arr.push(f);
  }
  const out: FailureCluster[] = [];
  for (const [errorType, ctrlMap] of byType) {
    const controllers = [...ctrlMap.entries()].map(([controller, failures]) => ({ controller, failures }));
    controllers.sort((a, b) => b.failures.length - a.failures.length);
    out.push({
      errorType,
      count: controllers.reduce((sum, c) => sum + c.failures.length, 0),
      controllers,
    });
  }
  out.sort((a, b) => b.count - a.count);
  return out;
}

// GET /api/migration/failures?projectPath=...
export async function GET(req: Request) {
  const url = new URL(req.url);
  const projectPath = url.searchParams.get('projectPath');
  if (!projectPath) return NextResponse.json({ error: 'projectPath required' }, { status: 400 });
  const failures = loadFailures(projectPath);
  return NextResponse.json({ failures, clusters: cluster(failures) });
}
