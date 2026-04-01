import { NextResponse, type NextRequest } from 'next/server';
import { execSync, exec } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import { loadSettings } from '@/lib/settings';

function isUnderProjectRoot(dir: string): boolean {
  const settings = loadSettings();
  const roots = (settings.projectRoots || []).map(r => r.replace(/^~/, homedir()));
  return roots.some(root => dir.startsWith(root) || dir === root);
}

const execAsync = promisify(exec);

function gitSync(cmd: string, cwd: string): string {
  return execSync(`git ${cmd}`, { cwd, encoding: 'utf-8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim();
}

async function gitAsync(cmd: string, cwd: string): Promise<string> {
  try {
    const { stdout } = await execAsync(`git ${cmd}`, { cwd, encoding: 'utf-8', timeout: 10000 });
    return stdout.trim();
  } catch { return ''; }
}

// GET /api/git?dir=<path> — git status for a project
export async function GET(req: NextRequest) {
  const dir = req.nextUrl.searchParams.get('dir');
  if (!dir || !isUnderProjectRoot(dir)) {
    return NextResponse.json({ error: 'Invalid directory' }, { status: 400 });
  }

  try {
    // Run all git commands in parallel
    const [branchOut, statusOut, remoteOut, lastCommitOut, logOut, branchListOut] = await Promise.all([
      gitAsync('rev-parse --abbrev-ref HEAD', dir),
      gitAsync('status --porcelain -u', dir),
      gitAsync('remote get-url origin', dir),
      gitAsync('log -1 --format="%h %s"', dir),
      gitAsync('log --format="%h||%s||%an||%ar" -20', dir),
      gitAsync('branch --format="%(refname:short)||%(upstream:short)||%(objectname:short)"', dir),
    ]);

    const branch = branchOut;
    const changes = statusOut ? statusOut.split('\n').filter(Boolean).map(line => ({
      status: line.substring(0, 2).trim() || 'M',
      path: line.substring(3).replace(/\/$/, ''),
    })) : [];

    let ahead = 0, behind = 0;
    try {
      const counts = await gitAsync(`rev-list --left-right --count HEAD...origin/${branch}`, dir);
      if (counts) { const [a, b] = counts.split('\t'); ahead = parseInt(a) || 0; behind = parseInt(b) || 0; }
    } catch {}

    const log = logOut ? logOut.split('\n').filter(Boolean).map(line => {
      const [hash, message, author, date] = line.split('||');
      return { hash, message, author, date };
    }) : [];

    const branches = branchListOut ? branchListOut.split('\n').filter(Boolean).map(line => {
      const [name, upstream, hash] = line.split('||');
      return { name, upstream: upstream || '', hash: hash || '', current: name === branch };
    }) : [];

    return NextResponse.json({ branch, branches, changes, remote: remoteOut, ahead, behind, lastCommit: lastCommitOut, log });
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
          gitSync(`add "${f}"`, dir);
        }
      } else {
        gitSync('add -A', dir);
      }
      gitSync(`commit -m "${message.replace(/"/g, '\\"')}"`, dir);
      return NextResponse.json({ ok: true });
    }

    if (action === 'push') {
      const output = gitSync('push', dir);
      return NextResponse.json({ ok: true, output });
    }

    if (action === 'pull') {
      const output = gitSync('pull', dir);
      return NextResponse.json({ ok: true, output });
    }

    if (action === 'checkout') {
      const branch = body.branch;
      if (!branch) return NextResponse.json({ error: 'branch required' }, { status: 400 });
      const out = gitSync(`checkout ${branch}`, dir);
      return NextResponse.json({ ok: true, output: out });
    }

    if (action === 'stage') {
      if (files && files.length > 0) {
        for (const f of files) gitSync(`add "${f}"`, dir);
      } else {
        gitSync('add -A', dir);
      }
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
