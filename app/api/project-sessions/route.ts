import { NextResponse } from 'next/server';
import { getFixedSession, setFixedSession, clearFixedSession, getAllFixedSessions } from '@/lib/project-sessions';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// GET: get fixed session for a project, or all bindings
export async function GET(req: Request) {
  const url = new URL(req.url);
  const projectPath = url.searchParams.get('projectPath');
  if (projectPath) {
    // Also ensure mcp.json exists when querying
    ensureMcpConfig(projectPath);
    return NextResponse.json({ projectPath, fixedSessionId: getFixedSession(projectPath) || null });
  }
  return NextResponse.json(getAllFixedSessions());
}

// POST: set fixed session or ensure MCP config
export async function POST(req: Request) {
  const body = await req.json();
  const { projectPath, fixedSessionId, action } = body;
  if (!projectPath) return NextResponse.json({ error: 'projectPath required' }, { status: 400 });

  // Ensure MCP config action
  if (action === 'ensure_mcp') {
    ensureMcpConfig(projectPath);
    return NextResponse.json({ ok: true });
  }

  if (!fixedSessionId) {
    clearFixedSession(projectPath);
    return NextResponse.json({ ok: true, cleared: true });
  }
  setFixedSession(projectPath, fixedSessionId);
  return NextResponse.json({ ok: true, projectPath, fixedSessionId });
}

/** Generate .forge/mcp.json in the project directory with workspace context baked in */
function ensureMcpConfig(projectPath: string): void {
  try {
    const forgeDir = join(projectPath, '.forge');
    const configPath = join(forgeDir, 'mcp.json');
    const mcpPort = Number(process.env.MCP_PORT) || 7830;

    // Resolve workspace + primary agent for this project
    let wsParam = '';
    try {
      const { findWorkspaceByProject } = require('@/lib/workspace');
      const ws = findWorkspaceByProject(projectPath);
      if (ws) {
        wsParam = `?workspaceId=${ws.id}`;
      }
    } catch {}

    const config = { mcpServers: { forge: { url: `http://localhost:${mcpPort}/sse${wsParam}` } } };

    // Always rewrite (workspace context may have changed)
    mkdirSync(forgeDir, { recursive: true });
    writeFileSync(configPath, JSON.stringify(config, null, 2));
  } catch {}
}
