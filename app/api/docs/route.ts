import { NextResponse } from 'next/server';
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import { homedir } from 'node:os';
import { loadSettings } from '@/lib/settings';

interface FileNode {
  name: string;
  path: string;      // relative to docRoot
  type: 'file' | 'dir';
  children?: FileNode[];
}

function scanDir(dir: string, base: string, depth: number = 0): FileNode[] {
  if (depth > 6) return [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    const nodes: FileNode[] = [];

    // Sort: dirs first, then files, alphabetical
    const sorted = entries
      .filter(e => !e.name.startsWith('.') && e.name !== 'node_modules')
      .sort((a, b) => {
        if (a.isDirectory() && !b.isDirectory()) return -1;
        if (!a.isDirectory() && b.isDirectory()) return 1;
        return a.name.localeCompare(b.name);
      });

    for (const entry of sorted) {
      const fullPath = join(dir, entry.name);
      const relPath = relative(base, fullPath);

      if (entry.isDirectory()) {
        const children = scanDir(fullPath, base, depth + 1);
        if (children.length > 0) {
          nodes.push({ name: entry.name, path: relPath, type: 'dir', children });
        }
      } else if (extname(entry.name) === '.md') {
        nodes.push({ name: entry.name, path: relPath, type: 'file' });
      }
    }
    return nodes;
  } catch {
    return [];
  }
}

// GET /api/docs — list doc roots and their file trees
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const filePath = searchParams.get('file');
  const rootIdx = parseInt(searchParams.get('root') || '0');

  const settings = loadSettings();
  const docRoots = (settings.docRoots || []).map(r => r.replace(/^~/, homedir()));

  if (docRoots.length === 0) {
    return NextResponse.json({ roots: [], tree: [], content: null });
  }

  const rootNames = docRoots.map(r => r.split('/').pop() || r);

  // Read file content
  if (filePath && rootIdx < docRoots.length) {
    const root = docRoots[rootIdx];
    const fullPath = join(root, filePath);
    if (!fullPath.startsWith(root)) {
      return NextResponse.json({ error: 'Invalid path' }, { status: 400 });
    }
    try {
      const stat = statSync(fullPath);
      const size = stat.size;
      const sizeKB = Math.round(size / 1024);
      const sizeMB = (size / (1024 * 1024)).toFixed(1);

      if (size > 2_000_000) {
        return NextResponse.json({ tooLarge: true, size, sizeLabel: `${sizeMB} MB`, message: 'File exceeds 2 MB limit' });
      }
      if (size > 200_000) {
        return NextResponse.json({ large: true, size, sizeLabel: `${sizeKB} KB` });
      }
      const content = readFileSync(fullPath, 'utf-8');
      return NextResponse.json({ content });
    } catch {
      return NextResponse.json({ error: 'File not found' }, { status: 404 });
    }
  }

  // Return tree for selected root
  const idx = Math.min(rootIdx, docRoots.length - 1);
  const root = docRoots[idx];
  const tree = scanDir(root, root);

  return NextResponse.json({ roots: rootNames, rootPaths: docRoots, tree });
}
