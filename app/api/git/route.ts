import { NextResponse, type NextRequest } from 'next/server';
import { execSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { loadSettings } from '@/lib/settings';

function isUnderProjectRoot(dir: string): boolean {
  const settings = loadSettings();
  const roots = (settings.projectRoots || []).map(r => r.replace(/^~/, homedir()));
  return roots.some(root => dir.startsWith(root) || dir === root);
}

function git(cmd: string, cwd: string): string {
  return execSync(`git ${cmd}`, { cwd, encoding: 'utf-8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim();
}

// GET /api/git?dir=<path> — git status for a project
export async function GET(req: NextRequest) {
  const dir = req.nextUrl.searchParams.get('dir');
  if (!dir || !isUnderProjectRoot(dir)) {
    return NextResponse.json({ error: 'Invalid directory' }, { status: 400 });
  }

  try {
    const branch = git('rev-parse --abbrev-ref HEAD', dir);
    const statusRaw = execSync('git status --porcelain -u', { cwd: dir, encoding: 'utf-8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] }).toString();
    const changes = statusRaw.replace(/\n$/, '').split('\n').filter(Boolean).map(line => ({
      status: line.substring(0, 2).trim() || 'M',
      path: line.substring(3).replace(/\/$/, ''),
    }));

    let remote = '';
    try { remote = git('remote get-url origin', dir); } catch {}

    let ahead = 0;
    let behind = 0;
    try {
      const counts = git(`rev-list --left-right --count HEAD...origin/${branch}`, dir);
      const [a, b] = counts.split('\t');
      ahead = parseInt(a) || 0;
      behind = parseInt(b) || 0;
    } catch {}

    const lastCommit = git('log -1 --format="%h %s" 2>/dev/null || echo ""', dir);

    // Git log — recent commits
    let log: { hash: string; message: string; author: string; date: string }[] = [];
    try {
      const logOut = git('log --format="%h||%s||%an||%ar" -20', dir);
      log = logOut.split('\n').filter(Boolean).map(line => {
        const [hash, message, author, date] = line.split('||');
        return { hash, message, author, date };
      });
    } catch {}

    return NextResponse.json({ branch, changes, remote, ahead, behind, lastCommit, log });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

// POST /api/git — git operations (commit, push, pull, clone)
export async function POST(req: NextRequest) {
  const body = await req.json();
  const { action, dir, message, files, repoUrl, targetDir } = body;

  if (action === 'clone') {
    // Clone a repo into a project root
    if (!repoUrl) return NextResponse.json({ error: 'repoUrl required' }, { status: 400 });
    const settings = loadSettings();
    const roots = (settings.projectRoots || []).map(r => r.replace(/^~/, homedir()));
    const cloneTarget = targetDir || roots[0];
    if (!cloneTarget) return NextResponse.json({ error: 'No project root configured' }, { status: 400 });

    try {
      const output = execSync(`git clone "${repoUrl}"`, {
        cwd: cloneTarget,
        encoding: 'utf-8',
        timeout: 60000,
      });
      // Extract cloned dir name from URL
      const repoName = repoUrl.split('/').pop()?.replace(/\.git$/, '') || 'repo';
      return NextResponse.json({ ok: true, path: join(cloneTarget, repoName), output });
    } catch (e: any) {
      return NextResponse.json({ error: e.message }, { status: 500 });
    }
  }

  if (!dir || !isUnderProjectRoot(dir)) {
    return NextResponse.json({ error: 'Invalid directory' }, { status: 400 });
  }

  try {
    if (action === 'commit') {
      if (!message) return NextResponse.json({ error: 'message required' }, { status: 400 });
      if (files && files.length > 0) {
        for (const f of files) {
          git(`add "${f}"`, dir);
        }
      } else {
        git('add -A', dir);
      }
      git(`commit -m "${message.replace(/"/g, '\\"')}"`, dir);
      return NextResponse.json({ ok: true });
    }

    if (action === 'push') {
      const output = git('push', dir);
      return NextResponse.json({ ok: true, output });
    }

    if (action === 'pull') {
      const output = git('pull', dir);
      return NextResponse.json({ ok: true, output });
    }

    if (action === 'stage') {
      if (files && files.length > 0) {
        for (const f of files) git(`add "${f}"`, dir);
      } else {
        git('add -A', dir);
      }
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
