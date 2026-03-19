import { NextResponse } from 'next/server';
import {
  syncSkills,
  listSkills,
  installGlobal,
  installProject,
  uninstallGlobal,
  uninstallProject,
  refreshInstallState,
} from '@/lib/skills';
import { loadSettings } from '@/lib/settings';
import { homedir } from 'node:os';

function getProjectPaths(): string[] {
  const settings = loadSettings();
  const roots = (settings.projectRoots || []).map(r => r.replace(/^~/, homedir()));
  const paths: string[] = [];
  for (const root of roots) {
    try {
      const { readdirSync, statSync } = require('node:fs');
      const { join } = require('node:path');
      for (const name of readdirSync(root)) {
        const p = join(root, name);
        try { if (statSync(p).isDirectory() && !name.startsWith('.')) paths.push(p); } catch {}
      }
    } catch {}
  }
  return paths;
}

// GET /api/skills — list skills, get file list, or get file content
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const action = searchParams.get('action');
  const name = searchParams.get('name');

  // List files in a skill directory
  if (action === 'files' && name) {
    try {
      const settings = loadSettings();
      const repoUrl = settings.skillsRepoUrl || 'https://raw.githubusercontent.com/aiwatching/forge-skills/main';
      // Extract owner/repo from raw URL
      const match = repoUrl.match(/github\.com\/([^/]+\/[^/]+)/);
      const repo = match ? match[1] : 'aiwatching/forge-skills';

      const res = await fetch(`https://api.github.com/repos/${repo}/contents/skills/${name}`, {
        headers: { 'Accept': 'application/vnd.github.v3+json' },
      });
      if (!res.ok) return NextResponse.json({ files: [] });

      const items = await res.json();
      const files: { name: string; path: string; type: string }[] = [];

      const flatten = (list: any[], prefix = '') => {
        for (const item of list) {
          if (item.type === 'file') {
            files.push({ name: item.name, path: prefix + item.name, type: 'file' });
          } else if (item.type === 'dir') {
            files.push({ name: item.name, path: prefix + item.name, type: 'dir' });
          }
        }
      };
      flatten(Array.isArray(items) ? items : []);

      // Sort: dirs first, then files
      files.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

      return NextResponse.json({ files });
    } catch {
      return NextResponse.json({ files: [] });
    }
  }

  // Get content of a specific file
  if (action === 'file' && name) {
    const filePath = searchParams.get('path') || 'skill.md';
    try {
      const settings = loadSettings();
      const baseUrl = settings.skillsRepoUrl || 'https://raw.githubusercontent.com/aiwatching/forge-skills/main';
      const res = await fetch(`${baseUrl}/skills/${name}/${filePath}`);
      if (!res.ok) return NextResponse.json({ content: '(Not found)' });
      const content = await res.text();
      return NextResponse.json({ content });
    } catch {
      return NextResponse.json({ content: '(Failed to load)' });
    }
  }
  // Refresh install state from filesystem
  refreshInstallState(getProjectPaths());
  const skills = listSkills();
  const projects = getProjectPaths().map(p => ({ path: p, name: p.split('/').pop() || p }));
  return NextResponse.json({ skills, projects });
}

// POST /api/skills — sync, install, uninstall
export async function POST(req: Request) {
  const body = await req.json();

  if (body.action === 'sync') {
    const result = await syncSkills();
    if (result.synced > 0) {
      refreshInstallState(getProjectPaths());
    }
    return NextResponse.json(result);
  }

  if (body.action === 'install') {
    const { name, target } = body; // target: 'global' | projectPath
    try {
      if (target === 'global') {
        await installGlobal(name);
      } else {
        await installProject(name, target);
      }
      return NextResponse.json({ ok: true });
    } catch (e) {
      return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
    }
  }

  if (body.action === 'uninstall') {
    const { name, target } = body;
    if (target === 'global') {
      uninstallGlobal(name);
    } else {
      uninstallProject(name, target);
    }
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
}
