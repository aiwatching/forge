import { NextResponse } from 'next/server';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
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
  '.xml', '.csv', '.lock', '.properties', '.gradle', '.groovy',
  '.scala', '.clj', '.cljs', '.jsp', '.erb', '.vue', '.svelte',
]);

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp', '.ico', '.avif']);

function isCodeFile(name: string): boolean {
  if (name.startsWith('.') && !name.startsWith('.env') && !name.startsWith('.git')) return false;
  const ext = extname(name);
  if (!ext) return !name.includes('.'); // files like Makefile, Dockerfile
  return CODE_EXTS.has(ext) || IMAGE_EXTS.has(ext);
}

function scanDir(dir: string, base: string, depth: number = 0): FileNode[] {
  if (depth > 10) return [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    const nodes: FileNode[] = [];

    const sorted = entries
      .filter(e => !IGNORE.has(e.name))
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
        nodes.push({ name: entry.name, path: relPath, type: 'dir', children });
      } else {
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
      const ext = extname(fullPath).replace('.', '').toLowerCase();
      const size = stat.size;
      const sizeKB = Math.round(size / 1024);
      const sizeMB = (size / (1024 * 1024)).toFixed(1);

      // Binary/unsupported file types
      const BINARY_EXTS = new Set([
        'png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'webp', 'svg', 'avif',
        'mp3', 'mp4', 'wav', 'ogg', 'webm', 'mov', 'avi',
        'zip', 'gz', 'tar', 'bz2', 'xz', '7z', 'rar',
        'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
        'exe', 'dll', 'so', 'dylib', 'bin', 'o', 'a',
        'woff', 'woff2', 'ttf', 'eot', 'otf',
        'sqlite', 'db', 'sqlite3',
        'class', 'jar', 'war',
        'pyc', 'pyo', 'wasm',
      ]);
      // Image files — return base64 for preview
      const IMAGE_PREVIEW = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico', 'avif']);
      if (IMAGE_PREVIEW.has(ext)) {
        if (size > 5_000_000) {
          return NextResponse.json({ binary: true, fileType: ext, size, sizeLabel: `${sizeMB} MB`, message: 'Image too large to preview (> 5 MB)' });
        }
        const data = readFileSync(fullPath);
        const mime = ext === 'svg' ? 'image/svg+xml' : `image/${ext === 'jpg' ? 'jpeg' : ext}`;
        const base64 = `data:${mime};base64,${data.toString('base64')}`;
        return NextResponse.json({ image: true, dataUrl: base64, fileType: ext, size, sizeLabel: sizeKB > 1024 ? `${sizeMB} MB` : `${sizeKB} KB` });
      }
      if (BINARY_EXTS.has(ext)) {
        return NextResponse.json({ binary: true, fileType: ext, size, sizeLabel: sizeKB > 1024 ? `${sizeMB} MB` : `${sizeKB} KB` });
      }

      const force = searchParams.get('force') === '1';

      // Large file warning (> 200KB needs confirmation, > 2MB blocked)
      if (size > 2_000_000) {
        return NextResponse.json({ tooLarge: true, size, sizeLabel: `${sizeMB} MB`, message: 'File exceeds 2 MB limit' });
      }
      if (size > 200_000 && !force) {
        return NextResponse.json({ large: true, size, sizeLabel: `${sizeKB} KB`, language: ext });
      }

      const content = readFileSync(fullPath, 'utf-8');
      return NextResponse.json({ content, language: ext, size });
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

  const gitOpts = { encoding: 'utf-8' as const, timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] as any };

  function scanGitStatus(dir: string, repoName: string, pathPrefix: string) {
    try {
      const branch = execSync('git rev-parse --abbrev-ref HEAD', { ...gitOpts, cwd: dir, timeout: 3000 }).toString().trim();
      const statusOut = execSync('git status --porcelain -u', { ...gitOpts, cwd: dir }).toString();
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
      try { remote = execSync('git remote get-url origin', { ...gitOpts, cwd: dir, timeout: 2000 }).toString().trim(); } catch {}
      if (branch || changes.length > 0) {
        gitRepos.push({ name: repoName, branch, remote, changes });
      }
    } catch {}
  }

  // Check if root is a git repo
  try {
    execSync('git rev-parse --git-dir', { cwd: resolvedDir, encoding: 'utf-8', timeout: 2000, stdio: ['pipe', 'pipe', 'pipe'] });
    scanGitStatus(resolvedDir, '.', '');
  } catch {
    // Root is not a git repo — scan subdirectories
    try {
      for (const entry of readdirSync(resolvedDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith('.') || IGNORE.has(entry.name)) continue;
        const subDir = join(resolvedDir, entry.name);
        try {
          execSync('git rev-parse --git-dir', { cwd: subDir, encoding: 'utf-8', timeout: 2000, stdio: ['pipe', 'pipe', 'pipe'] });
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

// PUT /api/code — save file content
export async function PUT(req: Request) {
  const { dir, file, content } = await req.json() as {
    dir: string;
    file: string;
    content: string;
  };

  if (!dir || !file) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }

  const resolvedDir = dir.replace(/^~/, homedir());
  const fullPath = join(resolvedDir, file);

  // Security: ensure path is within the directory
  if (!fullPath.startsWith(resolvedDir)) {
    return NextResponse.json({ error: 'Invalid path' }, { status: 400 });
  }

  // Verify dir is under a configured project root
  const settings = loadSettings();
  const roots = (settings.projectRoots || []).map(r => r.replace(/^~/, homedir()));
  const allowed = roots.some(r => resolvedDir.startsWith(r));
  if (!allowed) {
    return NextResponse.json({ error: 'Directory not in project roots' }, { status: 403 });
  }

  try {
    writeFileSync(fullPath, content, 'utf-8');
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: 'Failed to save' }, { status: 500 });
  }
}
