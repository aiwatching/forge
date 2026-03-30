import { NextResponse } from 'next/server';
import { listWorkspaces, findWorkspaceByProject, loadWorkspace, saveWorkspace, deleteWorkspace } from '@/lib/workspace';
import type { WorkspaceState } from '@/lib/workspace';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/** Auto-bind fixedSessionId for primary agent if missing */
function ensureSessionBound(ws: WorkspaceState): boolean {
  const primary = ws.agents.find((a: any) => a.primary && a.persistentSession && !a.fixedSessionId);
  if (!primary) return false;
  try {
    const workDir = primary.workDir && primary.workDir !== './' && primary.workDir !== '.' ? `${ws.projectPath}/${primary.workDir}` : ws.projectPath;
    const dir = join(homedir(), '.claude', 'projects', workDir.replace(/\//g, '-'));
    if (!existsSync(dir)) return false;
    const files = readdirSync(dir).filter(f => f.endsWith('.jsonl'));
    if (files.length === 0) return false;
    // Exclude sessions already bound to other agents
    const boundIds = new Set(ws.agents.filter((a: any) => a.fixedSessionId).map((a: any) => a.fixedSessionId));
    const available = files.filter(f => !boundIds.has(f.replace('.jsonl', '')));
    if (available.length === 0) return false;
    // Pick latest by mtime
    const sorted = available.map(f => ({ name: f, mtime: statSync(join(dir, f)).mtimeMs })).sort((a, b) => b.mtime - a.mtime);
    (primary as any).fixedSessionId = sorted[0].name.replace('.jsonl', '');
    return true;
  } catch { return false; }
}

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
    if (ws && ensureSessionBound(ws)) {
      saveWorkspace(ws); // persist the binding
    }
    return NextResponse.json(ws || null);
  }

  return NextResponse.json(listWorkspaces());
}

// Create workspace or import template
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

  const state: WorkspaceState = {
    id: existing?.id || randomUUID(),
    projectPath,
    projectName,
    agents: [],
    agentStates: {},
    nodePositions: {},
    busLog: [],
    createdAt: existing?.createdAt || Date.now(),
    updatedAt: Date.now(),
  };

  // Import template: create agents from template with new IDs
  if (template?.agents) {
    const idMap = new Map<string, string>(); // old ID → new ID
    const ts = Date.now();
    for (const agent of template.agents) {
      const newId = `${agent.label.toLowerCase().replace(/\s+/g, '-')}-${ts}-${Math.random().toString(36).slice(2, 5)}`;
      idMap.set(agent.id, newId);
    }
    for (const agent of template.agents) {
      state.agents.push({
        ...agent,
        id: idMap.get(agent.id) || agent.id,
        dependsOn: agent.dependsOn.map((d: string) => idMap.get(d) || d),
        entries: agent.type === 'input' ? [] : undefined,
      });
      state.agentStates[idMap.get(agent.id) || agent.id] = { smithStatus: 'down', taskStatus: 'idle', history: [], artifacts: [] };
    }
    if (template.nodePositions) {
      for (const [oldId, pos] of Object.entries(template.nodePositions)) {
        const newId = idMap.get(oldId);
        if (newId) state.nodePositions[newId] = pos as { x: number; y: number };
      }
    }
  }

  await saveWorkspace(state);
  return NextResponse.json(state, { status: 201 });
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
