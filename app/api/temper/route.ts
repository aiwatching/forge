import { NextResponse } from 'next/server';
import {
  getTemperStatus, initTemper, installTemper, isTemperInstalled,
  readTemperGraph, readTemperModuleGraph, readTemperModules, readTemperModuleIndex,
  readTemperKnowledge, readTemperCausalRelations, readTemperExperiences,
  readTemperInterface,
} from '@/lib/temper';
import { loadSettings, saveSettings } from '@/lib/settings';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const projectPath = url.searchParams.get('project');
  const action = url.searchParams.get('action') || 'status';

  if (action === 'installed') {
    return NextResponse.json({ installed: await isTemperInstalled() });
  }

  if (!projectPath) {
    return NextResponse.json({ error: 'project required' }, { status: 400 });
  }

  if (action === 'status') {
    return NextResponse.json(await getTemperStatus(projectPath));
  }

  // Data reading endpoints
  if (action === 'graph') {
    return NextResponse.json(readTemperGraph(projectPath) || { error: 'no graph' });
  }

  if (action === 'modules') {
    const modules = readTemperModules(projectPath);
    const index = readTemperModuleIndex(projectPath);
    return NextResponse.json({ modules, index });
  }

  if (action === 'knowledge') {
    const module = url.searchParams.get('module') || undefined;
    const type = url.searchParams.get('type') || undefined;
    const limit = url.searchParams.get('limit');
    return NextResponse.json(readTemperKnowledge(projectPath, {
      module, type, limit: limit ? Number(limit) : 100,
    }));
  }

  if (action === 'experiences') {
    return NextResponse.json(readTemperExperiences(projectPath));
  }

  if (action === 'causal') {
    return NextResponse.json(readTemperCausalRelations(projectPath));
  }

  if (action === 'interface') {
    const moduleName = url.searchParams.get('module');
    if (!moduleName) return NextResponse.json({ error: 'module required' }, { status: 400 });
    return NextResponse.json(readTemperInterface(projectPath, moduleName) || { error: 'no interface' });
  }

  // Combined data for the tab view
  if (action === 'data') {
    const graph = readTemperGraph(projectPath);
    const moduleGraph = readTemperModuleGraph(projectPath);
    const modules = readTemperModules(projectPath);
    const knowledge = readTemperKnowledge(projectPath, { limit: 50 });
    const experiences = readTemperExperiences(projectPath);
    const causal = readTemperCausalRelations(projectPath);
    return NextResponse.json({ graph, moduleGraph, modules, knowledge, experiences, causal });
  }

  return NextResponse.json({ error: 'unknown action' }, { status: 400 });
}

export async function POST(req: Request) {
  const body = await req.json();
  const { projectPath, action } = body;

  if (action === 'install') {
    const result = await installTemper();
    return NextResponse.json(result);
  }

  if (!projectPath) {
    return NextResponse.json({ error: 'projectPath required' }, { status: 400 });
  }

  if (action === 'enable' || action === 'disable') {
    const settings = loadSettings() as any;
    if (!settings.temper || typeof settings.temper !== 'object') {
      settings.temper = { projects: [] };
    }
    const projects: string[] = settings.temper.projects || [];
    if (action === 'enable' && !projects.includes(projectPath)) {
      projects.push(projectPath);
    } else if (action === 'disable') {
      const idx = projects.indexOf(projectPath);
      if (idx >= 0) projects.splice(idx, 1);
    }
    settings.temper = { projects };
    saveSettings(settings);
    return NextResponse.json({ ok: true, enabled: action === 'enable' });
  }

  if (action === 'init') {
    return NextResponse.json(await initTemper(projectPath));
  }

  return NextResponse.json({ error: 'unknown action' }, { status: 400 });
}
