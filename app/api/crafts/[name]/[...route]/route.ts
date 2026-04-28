import { NextResponse } from 'next/server';
import { getCraft } from '@/lib/crafts/loader';
import { loadServer, findHandler, buildForgeApi } from '@/lib/crafts/runtime';

// /api/crafts/<name>/<...route>  — dispatches to craft.server's matching handler.
// projectPath comes from query param (so the same URL works across multiple projects).

async function handle(req: Request, ctx: { params: Promise<{ name: string; route: string[] }> }, method: string) {
  const { name, route } = await ctx.params;
  const url = new URL(req.url);
  const projectPath = url.searchParams.get('projectPath');
  if (!projectPath) return NextResponse.json({ error: 'projectPath query param required' }, { status: 400 });

  const craft = getCraft(projectPath, name);
  if (!craft) return NextResponse.json({ error: `craft "${name}" not found` }, { status: 404 });
  if (!craft.hasServer) return NextResponse.json({ error: `craft "${name}" has no server` }, { status: 404 });

  const def = await loadServer(craft);
  if (!def) return NextResponse.json({ error: 'failed to load craft server' }, { status: 500 });

  const path = '/' + (route || []).join('/');
  const m = findHandler(def, method, path);
  if (!m) return NextResponse.json({ error: `no handler for ${method} ${path}` }, { status: 404 });

  let body: any;
  if (method !== 'GET' && method !== 'HEAD') {
    try { body = await req.json(); } catch { body = undefined; }
  }
  const query: Record<string, string> = {};
  url.searchParams.forEach((v, k) => { if (k !== 'projectPath') query[k] = v; });
  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => { headers[k] = v; });

  try {
    const forge = buildForgeApi(craft, projectPath);
    const result = await m.handler({ projectPath, query, params: m.params, body, headers, forge });
    if (result instanceof Response) return result;
    return NextResponse.json(result ?? {});
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || String(e), stack: e?.stack }, { status: 500 });
  }
}

export async function GET(req: Request, ctx: any) { return handle(req, ctx, 'GET'); }
export async function POST(req: Request, ctx: any) { return handle(req, ctx, 'POST'); }
export async function PUT(req: Request, ctx: any) { return handle(req, ctx, 'PUT'); }
export async function DELETE(req: Request, ctx: any) { return handle(req, ctx, 'DELETE'); }
export async function PATCH(req: Request, ctx: any) { return handle(req, ctx, 'PATCH'); }
