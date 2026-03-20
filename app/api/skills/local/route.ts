import { NextResponse } from 'next/server';
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';

const SKILLS_DIR = join(homedir(), '.claude', 'skills');
const COMMANDS_DIR = join(homedir(), '.claude', 'commands');

function md5(content: string): string {
  return createHash('md5').update(content).digest('hex');
}

/** Recursively list files in a directory */
function listFiles(dir: string, prefix = ''): { path: string; size: number }[] {
  const files: { path: string; size: number }[] = [];
  if (!existsSync(dir)) return files;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const fullPath = join(dir, entry.name);
    if (entry.isFile()) {
      files.push({ path: relPath, size: statSync(fullPath).size });
    } else if (entry.isDirectory()) {
      files.push(...listFiles(fullPath, relPath));
    }
  }
  return files;
}

function resolveDir(name: string, type: string, projectPath?: string): string {
  if (type === 'skill') {
    return projectPath
      ? join(projectPath, '.claude', 'skills', name)
      : join(SKILLS_DIR, name);
  }
  // Command: could be single file or directory
  const base = projectPath ? join(projectPath, '.claude', 'commands') : COMMANDS_DIR;
  const dirPath = join(base, name);
  if (existsSync(dirPath) && statSync(dirPath).isDirectory()) return dirPath;
  // Single file — return parent dir
  return base;
}

/** Scan a directory for all installed skills/commands */
function scanLocalItems(projectPath?: string): { name: string; type: 'skill' | 'command'; scope: 'global' | 'project'; fileCount: number }[] {
  const items: { name: string; type: 'skill' | 'command'; scope: 'global' | 'project'; fileCount: number }[] = [];

  // Scan skills directories
  const skillsDirs = [
    { dir: SKILLS_DIR, scope: 'global' as const },
    ...(projectPath ? [{ dir: join(projectPath, '.claude', 'skills'), scope: 'project' as const }] : []),
  ];
  for (const { dir, scope } of skillsDirs) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.startsWith('.')) {
        const files = listFiles(join(dir, entry.name));
        items.push({ name: entry.name, type: 'skill', scope, fileCount: files.length });
      }
    }
  }

  // Scan commands directories
  const cmdDirs = [
    { dir: COMMANDS_DIR, scope: 'global' as const },
    ...(projectPath ? [{ dir: join(projectPath, '.claude', 'commands'), scope: 'project' as const }] : []),
  ];
  for (const { dir, scope } of cmdDirs) {
    if (!existsSync(dir)) continue;
    // Collect names, merge file + dir with same name
    const seen = new Map<string, { name: string; type: 'command'; scope: typeof scope; fileCount: number }>();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const cmdName = entry.isFile() ? entry.name.replace(/\.md$/, '') : entry.name;
      if (entry.isFile() && !entry.name.endsWith('.md')) continue;
      const existing = seen.get(cmdName);
      if (entry.isDirectory()) {
        const files = listFiles(join(dir, entry.name));
        const count = files.length + (existing?.fileCount || 0);
        seen.set(cmdName, { name: cmdName, type: 'command', scope, fileCount: count });
      } else if (entry.isFile()) {
        if (existing) {
          existing.fileCount += 1;
        } else {
          seen.set(cmdName, { name: cmdName, type: 'command', scope, fileCount: 1 });
        }
      }
    }
    items.push(...seen.values());
  }

  return items;
}

// GET /api/skills/local?name=X&type=skill|command&project=PATH
//   action=scan → list ALL locally installed skills/commands
//   action=files → list installed files for a specific item
//   action=read&path=FILE → read file content + hash
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const action = searchParams.get('action') || 'files';
  const name = searchParams.get('name') || '';
  const type = searchParams.get('type') || 'command';
  const projectPath = searchParams.get('project') || '';

  if (action === 'scan') {
    const items = scanLocalItems(projectPath || undefined);
    return NextResponse.json({ items });
  }

  if (action === 'files') {
    if (type === 'skill') {
      const dir = resolveDir(name, type, projectPath || undefined);
      return NextResponse.json({ files: listFiles(dir) });
    } else {
      // Command: collect both single .md file and directory contents
      const base = projectPath ? join(projectPath, '.claude', 'commands') : COMMANDS_DIR;
      const singleFile = join(base, `${name}.md`);
      const dirPath = join(base, name);
      const files: { path: string; size: number }[] = [];
      // Single .md file at root
      if (existsSync(singleFile)) {
        files.push({ path: `${name}.md`, size: statSync(singleFile).size });
      }
      // Directory contents
      if (existsSync(dirPath) && statSync(dirPath).isDirectory()) {
        files.push(...listFiles(dirPath).map(f => ({ path: `${name}/${f.path}`, size: f.size })));
      }
      return NextResponse.json({ files });
    }
  }

  if (action === 'read') {
    const filePath = searchParams.get('path') || '';
    let fullPath: string;
    if (type === 'skill') {
      const dir = resolveDir(name, type, projectPath || undefined);
      fullPath = join(dir, filePath);
    } else {
      // filePath from files action is like "name.md" or "name/sub/file.md"
      // Resolve relative to commands base directory
      const base = projectPath ? join(projectPath, '.claude', 'commands') : COMMANDS_DIR;
      fullPath = join(base, filePath);
    }

    if (!existsSync(fullPath)) return NextResponse.json({ content: '', hash: '' });
    const content = readFileSync(fullPath, 'utf-8');
    return NextResponse.json({ content, hash: md5(content) });
  }

  return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
}

// POST /api/skills/local — save edited file
export async function POST(req: Request) {
  const body = await req.json();
  const { name, type, project, path: filePath, content, expectedHash } = body;

  let fullPath: string;
  if (type === 'skill') {
    const dir = project
      ? join(project, '.claude', 'skills', name)
      : join(SKILLS_DIR, name);
    fullPath = join(dir, filePath);
  } else {
    const base = project ? join(project, '.claude', 'commands') : COMMANDS_DIR;
    const dirPath = join(base, name);
    if (existsSync(dirPath) && statSync(dirPath).isDirectory()) {
      fullPath = join(dirPath, filePath);
    } else {
      fullPath = join(base, filePath);
    }
  }

  // Check for concurrent modification
  if (expectedHash && existsSync(fullPath)) {
    const current = readFileSync(fullPath, 'utf-8');
    if (md5(current) !== expectedHash) {
      return NextResponse.json({ ok: false, error: 'File was modified externally. Reload and try again.' }, { status: 409 });
    }
  }

  writeFileSync(fullPath, content, 'utf-8');
  return NextResponse.json({ ok: true, hash: md5(content) });
}
