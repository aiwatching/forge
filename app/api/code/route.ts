import { NextResponse } from 'next/server';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';
import { loadSettings } from '@/lib/settings';

interface FileNode {
  name: string;
  path: string;
  type: 'file' | 'dir';
  children?: FileNode[];
}

const IGNORE = new Set([
  'node_modules', '.git', '.next', 'dist', 'build', '.idea', '.vscode',
  '.DS_Store', 'coverage', '__pycache__', '.cache', '.output', 'target',
]);

const CODE_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.go', '.rs', '.java', '.kt', '.swift', '.c', '.cpp', '.h',
  '.css', '.scss', '.html', '.json', '.yaml', '.yml', '.toml',
  '.md', '.txt', '.sh', '.bash', '.zsh', '.fish',
  '.sql', '.graphql', '.proto', '.env', '.gitignore',
  '.xml', '.csv', '.lock',
]);

function isCodeFile(name: string): boolean {
  if (name.startsWith('.') && !name.startsWith('.env') && !name.startsWith('.git')) return false;
  const ext = extname(name);
  if (!ext) return !name.includes('.'); // files like Makefile, Dockerfile
  return CODE_EXTS.has(ext);
}

function scanDir(dir: string, base: string, depth: number = 0): FileNode[] {
  if (depth > 5) return [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    const nodes: FileNode[] = [];

    const sorted = entries
      .filter(e => !IGNORE.has(e.name) && !e.name.startsWith('.'))
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
      } else if (isCodeFile(entry.name)) {
        nodes.push({ name: entry.name, path: relPath, type: 'file' });
      }
    }
    return nodes;
  } catch {
    return [];
  }
}

// GET /api/code?dir=<absolute-path>&file=<relative-path>
//   dir mode: returns file tree for the given directory
//   file mode: returns file content
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const dir = searchParams.get('dir');
  const filePath = searchParams.get('file');

  if (!dir) {
    return NextResponse.json({ tree: [], dirName: '' });
  }

  const resolvedDir = dir.replace(/^~/, homedir());

  // Security: dir must be under a projectRoot
  const settings = loadSettings();
  const projectRoots = (settings.projectRoots || []).map(r => r.replace(/^~/, homedir()));
  const allowed = projectRoots.some(root => resolvedDir.startsWith(root) || resolvedDir === root);
  if (!allowed) {
    return NextResponse.json({ error: 'Directory not under any project root' }, { status: 403 });
  }

  // Git diff for a specific file
  const diffFile = searchParams.get('diff');
  if (diffFile) {
    const fullPath = join(resolvedDir, diffFile);
    if (!fullPath.startsWith(resolvedDir)) {
      return NextResponse.json({ error: 'Invalid path' }, { status: 400 });
    }
    try {
      // Try staged + unstaged diff
      let diff = '';
      try { diff = execSync(`git diff -- "${diffFile}"`, { cwd: resolvedDir, encoding: 'utf-8', timeout: 5000 }); } catch {}
      if (!diff) {
        try { diff = execSync(`git diff HEAD -- "${diffFile}"`, { cwd: resolvedDir, encoding: 'utf-8', timeout: 5000 }); } catch {}
      }
      if (!diff) {
        // Untracked file — show entire content as added
        try {
          const content = readFileSync(fullPath, 'utf-8');
          diff = content.split('\n').map(l => `+${l}`).join('\n');
        } catch {}
      }
      return NextResponse.json({ diff: diff || 'No changes' });
    } catch {
      return NextResponse.json({ diff: 'Failed to get diff' });
    }
  }

  // Read file content
  if (filePath) {
    const fullPath = join(resolvedDir, filePath);
    if (!fullPath.startsWith(resolvedDir)) {
      return NextResponse.json({ error: 'Invalid path' }, { status: 400 });
    }
    try {
      const stat = statSync(fullPath);
      if (stat.size > 500_000) {
        return NextResponse.json({ content: '// File too large to display', language: 'text' });
      }
      const content = readFileSync(fullPath, 'utf-8');
      const ext = extname(fullPath).replace('.', '') || 'text';
      return NextResponse.json({ content, language: ext });
    } catch {
      return NextResponse.json({ error: 'File not found' }, { status: 404 });
    }
  }

  // Return file tree
  const tree = scanDir(resolvedDir, resolvedDir);
  const dirName = resolvedDir.split('/').pop() || resolvedDir;

  // Git status: scan for git repos (could be root dir or subdirectories)
  interface GitRepo {
    name: string;       // repo dir name (or '.' for root)
    branch: string;
    remote: string;     // remote URL
    changes: { path: string; status: string }[];
  }
  const gitRepos: GitRepo[] = [];

  function scanGitStatus(dir: string, repoName: string, pathPrefix: string) {
    try {
      const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: dir, encoding: 'utf-8', timeout: 3000 }).trim();
      const statusOut = execSync('git status --porcelain -u', { cwd: dir, encoding: 'utf-8', timeout: 5000 });
      const changes = statusOut.replace(/\n$/, '').split('\n').filter(Boolean)
        .map(line => {
          if (line.length < 4) return null;
          return {
            status: line.substring(0, 2).trim() || 'M',
            path: pathPrefix ? `${pathPrefix}/${line.substring(3).replace(/\/$/, '')}` : line.substring(3).replace(/\/$/, ''),
          };
        })
        .filter((g): g is { status: string; path: string } => g !== null && !!g.path && !g.path.includes(' -> '));
      let remote = '';
      try { remote = execSync('git remote get-url origin', { cwd: dir, encoding: 'utf-8', timeout: 2000 }).trim(); } catch {}
      if (branch || changes.length > 0) {
        gitRepos.push({ name: repoName, branch, remote, changes });
      }
    } catch {}
  }

  // Check if root is a git repo
  try {
    execSync('git rev-parse --git-dir', { cwd: resolvedDir, encoding: 'utf-8', timeout: 2000 });
    scanGitStatus(resolvedDir, '.', '');
  } catch {
    // Root is not a git repo — scan subdirectories
    try {
      for (const entry of readdirSync(resolvedDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith('.') || IGNORE.has(entry.name)) continue;
        const subDir = join(resolvedDir, entry.name);
        try {
          execSync('git rev-parse --git-dir', { cwd: subDir, encoding: 'utf-8', timeout: 2000 });
          scanGitStatus(subDir, entry.name, entry.name);
        } catch {}
      }
    } catch {}
  }

  // Flatten for backward compat
  const gitChanges = gitRepos.flatMap(r => r.changes);
  const gitBranch = gitRepos.length === 1 ? gitRepos[0].branch : '';

  return NextResponse.json({ tree, dirName, dirPath: resolvedDir, gitBranch, gitChanges, gitRepos });
}
