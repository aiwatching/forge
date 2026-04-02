import { NextResponse } from 'next/server';
import { listWorkspaces, findWorkspaceByProject, loadWorkspace, deleteWorkspace } from '@/lib/workspace';
import { randomUUID } from 'node:crypto';

// List workspaces, find by projectPath, or export template
export async function GET(req: Request) {
  const url = new URL(req.url);
  const projectPath = url.searchParams.get('projectPath');
  const exportId = url.searchParams.get('export');

  if (exportId) {
    // Export workspace as template (agents + positions, no state/logs)
    const ws = loadWorkspace(exportId);
    if (!ws) return NextResponse.json({ error: 'not found' }, { status: 404 });
    const template = {
      name: ws.projectName + ' template',
      agents: ws.agents.map(a => ({ ...a, entries: undefined })),  // strip Input entries
      nodePositions: ws.nodePositions,
      exportedAt: Date.now(),
    };
    return NextResponse.json(template);
  }

  if (projectPath) {
    const ws = findWorkspaceByProject(projectPath);
    return NextResponse.json(ws || null);
  }

  return NextResponse.json(listWorkspaces());
}

// Create workspace or import template — proxied through the workspace daemon
// so the daemon remains the exclusive writer of state.json (prevents race conditions).
export async function POST(req: Request) {
  const body = await req.json();
  const { projectPath, projectName, template } = body;

  if (!projectPath || !projectName) {
    return NextResponse.json({ error: 'projectPath and projectName are required' }, { status: 400 });
  }

  const existing = findWorkspaceByProject(projectPath);
  if (existing && !template) {
    return NextResponse.json(existing);
  }

  const daemonUrl = `http://localhost:${Number(process.env.WORKSPACE_PORT) || 8405}`;
  try {
    const daemonRes = await fetch(`${daemonUrl}/workspace/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: existing?.id || randomUUID(),
        projectPath,
        projectName,
        template,
        createdAt: existing?.createdAt,
      }),
    });
    const data = await daemonRes.json();
    return NextResponse.json(data, { status: daemonRes.status });
  } catch (err: any) {
    return NextResponse.json({ error: `Workspace daemon unreachable: ${err.message}` }, { status: 503 });
  }
}

// Delete a workspace
export async function DELETE(req: Request) {
  const url = new URL(req.url);
  const id = url.searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });

  // Unload from daemon if active
  const daemonUrl = `http://localhost:${Number(process.env.WORKSPACE_PORT) || 8405}`;
  try { await fetch(`${daemonUrl}/workspace/${id}/unload`, { method: 'POST' }); } catch {}

  deleteWorkspace(id);
  return NextResponse.json({ ok: true });
}
