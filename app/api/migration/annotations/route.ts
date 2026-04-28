import { NextResponse } from 'next/server';
import { loadAnnotations, upsertAnnotation, removeAnnotation } from '@/lib/migration/annotations';
import type { Annotation } from '@/lib/migration/types';

// GET /api/migration/annotations?projectPath=...  → all annotations
export async function GET(req: Request) {
  const url = new URL(req.url);
  const projectPath = url.searchParams.get('projectPath');
  if (!projectPath) return NextResponse.json({ error: 'projectPath required' }, { status: 400 });
  return NextResponse.json(loadAnnotations(projectPath));
}

// POST /api/migration/annotations — body: { projectPath, annotation }
export async function POST(req: Request) {
  const { projectPath, annotation } = await req.json() as { projectPath: string; annotation: Annotation };
  if (!projectPath || !annotation?.endpointId) return NextResponse.json({ error: 'projectPath + annotation.endpointId required' }, { status: 400 });
  upsertAnnotation(projectPath, annotation);
  return NextResponse.json({ ok: true });
}

// DELETE /api/migration/annotations?projectPath=...&endpointId=...
export async function DELETE(req: Request) {
  const url = new URL(req.url);
  const projectPath = url.searchParams.get('projectPath');
  const endpointId = url.searchParams.get('endpointId');
  if (!projectPath || !endpointId) return NextResponse.json({ error: 'projectPath + endpointId required' }, { status: 400 });
  removeAnnotation(projectPath, endpointId);
  return NextResponse.json({ ok: true });
}
