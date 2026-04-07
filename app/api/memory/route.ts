import { NextResponse } from 'next/server';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const projectPath = url.searchParams.get('project');
  const action = url.searchParams.get('action') || 'stats';
  const query = url.searchParams.get('q') || '';
  const filePath = url.searchParams.get('file') || '';

  if (!projectPath) return NextResponse.json({ error: 'project required' }, { status: 400 });

  try {
    const { buildCodeGraph, findAffectedBy } = await import('@/lib/memory/code-graph');
    const { existsSync, readFileSync } = await import('node:fs');
    const { join } = await import('node:path');

    // Build or cache graph
    const graphCacheKey = `graph_${projectPath}`;
    if (!(globalThis as any)[graphCacheKey]) {
      (globalThis as any)[graphCacheKey] = buildCodeGraph(projectPath);
    }
    const graph = (globalThis as any)[graphCacheKey];

    if (action === 'stats') {
      return NextResponse.json({
        files: graph.nodes.filter((n: any) => n.type === 'file').length,
        functions: graph.nodes.filter((n: any) => n.type === 'function').length,
        classes: graph.nodes.filter((n: any) => n.type === 'class').length,
        totalNodes: graph.nodes.length,
        totalEdges: graph.edges.length,
      });
    }

    if (action === 'query' && query) {
      const result = findAffectedBy(graph, query);
      return NextResponse.json(result);
    }

    if (action === 'graph') {
      return NextResponse.json(graph);
    }

    if (action === 'file' && filePath) {
      const fullPath = join(projectPath, filePath);
      if (!existsSync(fullPath)) return NextResponse.json({ error: 'not found' }, { status: 404 });
      return new NextResponse(readFileSync(fullPath, 'utf-8'), { headers: { 'Content-Type': 'text/plain' } });
    }

    if (action === 'knowledge') {
      const fp = join(projectPath, '.forge', 'memory', 'knowledge.json');
      if (!existsSync(fp)) return NextResponse.json({ entries: [] });
      return NextResponse.json({ entries: JSON.parse(readFileSync(fp, 'utf-8')) });
    }

    if (action === 'rescan') {
      delete (globalThis as any)[graphCacheKey];
      (globalThis as any)[graphCacheKey] = buildCodeGraph(projectPath);
      const g = (globalThis as any)[graphCacheKey];
      return NextResponse.json({ nodes: g.nodes.length, edges: g.edges.length });
    }

    return NextResponse.json({ error: 'unknown action' }, { status: 400 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
