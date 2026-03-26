import { NextResponse } from 'next/server';
import { loadMemory, formatMemoryForDisplay, getMemoryStats } from '@/lib/workspace/smith-memory';

// GET /api/workspace/{id}/memory?agentId=xxx
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: workspaceId } = await params;
  const url = new URL(req.url);
  const agentId = url.searchParams.get('agentId');

  if (!agentId) {
    return NextResponse.json({ error: 'agentId required' }, { status: 400 });
  }

  const memory = loadMemory(workspaceId, agentId);
  const stats = getMemoryStats(memory);
  const display = formatMemoryForDisplay(memory);

  return NextResponse.json({ memory, stats, display });
}
