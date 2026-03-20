import { NextResponse } from 'next/server';
import {
  listTemplates,
  getTemplate,
  saveTemplate,
  deleteTemplate,
  isInjected,
  getInjectedTemplates,
  injectTemplate,
  removeTemplate,
  setTemplateDefault,
  applyDefaultTemplates,
} from '@/lib/claude-templates';
import { loadSettings } from '@/lib/settings';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

function getProjectPaths(): { name: string; path: string }[] {
  const settings = loadSettings();
  const roots = (settings.projectRoots || []).map((r: string) => r.replace(/^~/, homedir()));
  const projects: { name: string; path: string }[] = [];
  for (const root of roots) {
    try {
      const { readdirSync, statSync } = require('node:fs');
      for (const name of readdirSync(root)) {
        const p = join(root, name);
        try { if (statSync(p).isDirectory() && !name.startsWith('.')) projects.push({ name, path: p }); } catch {}
      }
    } catch {}
  }
  return projects.sort((a, b) => a.name.localeCompare(b.name));
}

// GET /api/claude-templates
//   ?action=list — list all templates
//   ?action=status&project=PATH — get injection status for a project
//   ?action=read-claude-md&project=PATH — read project's CLAUDE.md content
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const action = searchParams.get('action') || 'list';

  if (action === 'list') {
    const templates = listTemplates();
    const projects = getProjectPaths();
    return NextResponse.json({ templates, projects });
  }

  if (action === 'status') {
    const projectPath = searchParams.get('project');
    if (!projectPath) return NextResponse.json({ error: 'project required' }, { status: 400 });
    const claudeMd = join(projectPath, 'CLAUDE.md');
    const injected = getInjectedTemplates(claudeMd);
    const templates = listTemplates();
    const status = templates.map(t => ({
      id: t.id,
      name: t.name,
      injected: injected.includes(t.id),
    }));
    return NextResponse.json({ status, hasClaudeMd: existsSync(claudeMd) });
  }

  if (action === 'read-claude-md') {
    const projectPath = searchParams.get('project');
    if (!projectPath) return NextResponse.json({ error: 'project required' }, { status: 400 });
    const claudeMd = join(projectPath, 'CLAUDE.md');
    if (!existsSync(claudeMd)) return NextResponse.json({ content: '', exists: false });
    return NextResponse.json({ content: readFileSync(claudeMd, 'utf-8'), exists: true });
  }

  return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
}

// POST /api/claude-templates
export async function POST(req: Request) {
  const body = await req.json();

  // Save/create template
  if (body.action === 'save') {
    const { id, name, description, tags, content, isDefault } = body;
    if (!id || !name || !content) return NextResponse.json({ error: 'id, name, content required' }, { status: 400 });
    saveTemplate(id, name, description || '', tags || [], content, isDefault);
    return NextResponse.json({ ok: true });
  }

  // Toggle default flag
  if (body.action === 'set-default') {
    const { id, isDefault } = body;
    if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });
    const ok = setTemplateDefault(id, !!isDefault);
    return NextResponse.json({ ok });
  }

  // Apply default templates to a project
  if (body.action === 'apply-defaults') {
    const { project } = body;
    if (!project) return NextResponse.json({ error: 'project required' }, { status: 400 });
    const injected = applyDefaultTemplates(project);
    return NextResponse.json({ ok: true, injected });
  }

  // Delete template
  if (body.action === 'delete') {
    const ok = deleteTemplate(body.id);
    if (!ok) return NextResponse.json({ error: 'Cannot delete (builtin or not found)' }, { status: 400 });
    return NextResponse.json({ ok: true });
  }

  // Inject template into project(s)
  if (body.action === 'inject') {
    const { templateId, projects } = body; // projects: string[] of paths
    if (!templateId || !projects?.length) return NextResponse.json({ error: 'templateId and projects required' }, { status: 400 });
    const results: { project: string; injected: boolean; reason?: string }[] = [];
    for (const projectPath of projects) {
      const claudeMd = join(projectPath, 'CLAUDE.md');
      if (isInjected(claudeMd, templateId)) {
        results.push({ project: projectPath, injected: false, reason: 'already exists' });
      } else {
        const ok = injectTemplate(claudeMd, templateId);
        results.push({ project: projectPath, injected: ok });
      }
    }
    return NextResponse.json({ ok: true, results });
  }

  // Remove template from project
  if (body.action === 'remove') {
    const { templateId, project } = body;
    if (!templateId || !project) return NextResponse.json({ error: 'templateId and project required' }, { status: 400 });
    const claudeMd = join(project, 'CLAUDE.md');
    const ok = removeTemplate(claudeMd, templateId);
    return NextResponse.json({ ok });
  }

  // Save CLAUDE.md content directly
  if (body.action === 'save-claude-md') {
    const { project, content } = body;
    if (!project) return NextResponse.json({ error: 'project required' }, { status: 400 });
    const { writeFileSync: wf } = require('node:fs');
    wf(join(project, 'CLAUDE.md'), content, 'utf-8');
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
}
