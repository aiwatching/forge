import { NextResponse } from 'next/server';
import { getTaskLogSlice, getTaskBody } from '@/lib/task-manager';

// GET /api/tasks/[id]/log?offset=N&limit=M&body=1
// Returns { entries, total, body? } — entries is the requested slice of the log.
// Default: returns the LAST `limit` entries (offset omitted).
// `body=1` also returns result_summary / git_diff / error so the client can
// populate Result / Diff tabs without a second fetch.
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const url = new URL(req.url);
  const offsetParam = url.searchParams.get('offset');
  const limitParam = url.searchParams.get('limit');
  const includeBody = url.searchParams.get('body') === '1';

  const slice = getTaskLogSlice(id, {
    offset: offsetParam !== null ? Number(offsetParam) : undefined,
    limit: limitParam !== null ? Number(limitParam) : undefined,
  });

  const body = includeBody ? getTaskBody(id) : null;
  return NextResponse.json({ ...slice, body });
}
