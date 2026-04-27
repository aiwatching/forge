import { loadConfig, loadEndpoints, saveRun, saveFailures } from '@/lib/migration/store';
import { runEndpoints } from '@/lib/migration/runner';
import type { Endpoint, RunResult, Failure } from '@/lib/migration/types';

export const dynamic = 'force-dynamic';

// POST /api/migration/run-batch — body: { projectPath, endpointIds?, onlyStatus?, concurrency? }
// Returns SSE stream with progress and final result.
export async function POST(req: Request) {
  const { projectPath, endpointIds, onlyStatus, concurrency } = await req.json() as {
    projectPath: string;
    endpointIds?: string[];
    onlyStatus?: string[];
    concurrency?: number;
  };
  if (!projectPath) return new Response(JSON.stringify({ error: 'projectPath required' }), { status: 400 });

  const config = loadConfig(projectPath);
  const all = loadEndpoints(projectPath);
  let toRun: Endpoint[] = all;
  if (endpointIds && endpointIds.length > 0) {
    const ids = new Set(endpointIds);
    toRun = all.filter(e => ids.has(e.id));
  } else if (onlyStatus && onlyStatus.length > 0) {
    const s = new Set(onlyStatus);
    toRun = all.filter(e => s.has(e.status));
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: any) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      send('start', { total: toRun.length });

      try {
        const results = await runEndpoints(toRun, config, {
          concurrency: concurrency ?? 4,
          projectPath,
          onProgress: (done, total, last) => {
            send('progress', { done, total, result: last });
          },
        });
        saveRun(projectPath, results);

        const failures: Failure[] = results
          .filter(r => r.match === 'fail' || r.match === 'error')
          .map(r => {
            const ep = toRun.find(e => e.id === r.endpointId)!;
            return {
              endpointId: r.endpointId,
              controller: ep.controller,
              method: ep.method,
              path: ep.path,
              errorType: r.errorType || 'unknown',
              errorMessage: r.errorMessage || '',
              lastSeenAt: r.startedAt,
            };
          });
        saveFailures(projectPath, failures);

        send('done', {
          total: results.length,
          pass: results.filter(r => r.match === 'pass').length,
          fail: results.filter(r => r.match === 'fail').length,
          stubOk: results.filter(r => r.match === 'stub-ok').length,
          error: results.filter(r => r.match === 'error').length,
          failures: failures.length,
        });
      } catch (e: any) {
        send('error', { message: e?.message || String(e) });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}
