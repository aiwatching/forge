import { NextResponse } from 'next/server';
import { execSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { bundleCraftForPublish } from '@/lib/crafts/registry';
import { loadSettings } from '@/lib/settings';

// One-click publish via the user's gh CLI: fork → clone → write files →
// append registry entry → push → open PR. Falls back to the manual flow
// (existing /api/craft-system/publish) when gh isn't available.

interface AutoPublishRequest {
  projectPath: string;
  name: string;
}

function exec(cmd: string, cwd?: string, timeout = 60000): string {
  return execSync(cmd, { cwd, timeout, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 10 * 1024 * 1024 });
}

export async function POST(req: Request) {
  const { projectPath, name } = (await req.json()) as AutoPublishRequest;
  if (!projectPath || !name) return NextResponse.json({ error: 'projectPath + name required' }, { status: 400 });

  // ── Pre-flight ────────────────────────────────────
  let me: string;
  try {
    exec('gh auth status', undefined, 5000);
    me = exec('gh api user --jq .login', undefined, 5000).trim();
  } catch (e: any) {
    return NextResponse.json({
      error: 'gh CLI is not authenticated. Run `gh auth login` in a terminal, then retry.',
      gh: false,
    }, { status: 400 });
  }

  const bundle = bundleCraftForPublish(projectPath, name);
  if (bundle.error || !bundle.entry) {
    return NextResponse.json({ error: bundle.error || 'failed to bundle craft' }, { status: 400 });
  }

  const repo = (loadSettings() as any).craftsRepoUrl || 'https://raw.githubusercontent.com/aiwatching/forge-crafts/main';
  const repoMatch = repo.match(/github\.com\/([^/]+)\/([^/]+)|raw\.githubusercontent\.com\/([^/]+)\/([^/]+)/);
  if (!repoMatch) return NextResponse.json({ error: `cannot parse craftsRepoUrl: ${repo}` }, { status: 400 });
  const ownerRepo = `${repoMatch[1] || repoMatch[3]}/${(repoMatch[2] || repoMatch[4]).replace(/\.git$/, '')}`;

  const branch = `craft/${name}-${bundle.entry.version}-${Date.now().toString(36).slice(-4)}`;
  const prTitle = `Add ${bundle.entry.displayName || bundle.entry.name} v${bundle.entry.version}`;
  const tmp = mkdtempSync(join(tmpdir(), 'forge-craft-pr-'));
  const repoDir = join(tmp, 'forge-crafts');

  const log: string[] = [];
  const step = (msg: string) => { log.push(msg); };

  try {
    // ── 1. Fork (idempotent — succeeds whether or not fork exists) ────
    step(`Forking ${ownerRepo}…`);
    try {
      exec(`gh repo fork ${ownerRepo} --clone=false --default-branch-only`, tmp, 30000);
    } catch {
      // Fork may already exist — gh exits non-zero in that case but still works
    }

    // ── 2. Clone the fork ────────────────────────────────────────
    step(`Cloning your fork ${me}/${ownerRepo.split('/')[1]}…`);
    exec(`gh repo clone ${me}/${ownerRepo.split('/')[1]} forge-crafts`, tmp, 60000);

    // Add upstream, sync from upstream main to avoid stale fork
    exec(`git remote add upstream https://github.com/${ownerRepo}.git`, repoDir, 5000);
    try {
      exec(`git fetch upstream main`, repoDir, 30000);
      exec(`git checkout main`, repoDir, 5000);
      exec(`git merge upstream/main --ff-only`, repoDir, 10000);
      exec(`git push origin main`, repoDir, 30000);
    } catch (e: any) {
      // Empty upstream repo or already in sync — both fine
      step(`(sync skipped: ${e?.message?.split('\n')[0] || ''})`);
    }

    // ── 3. New branch ────────────────────────────────────────────
    step(`Creating branch ${branch}…`);
    exec(`git checkout -b ${branch}`, repoDir, 5000);

    // ── 4. Write craft files ────────────────────────────────────
    const craftDir = join(repoDir, name);
    mkdirSync(craftDir, { recursive: true });
    for (const f of bundle.files) {
      const dest = join(craftDir, f.path);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, f.content, 'utf8');
    }
    step(`Wrote ${bundle.files.length} files into ${name}/`);

    // ── 5. Update registry.json ─────────────────────────────────
    const regPath = join(repoDir, 'registry.json');
    let registry: { version: number; crafts: any[] };
    if (existsSync(regPath)) {
      try {
        registry = JSON.parse(readFileSync(regPath, 'utf8'));
        if (!Array.isArray(registry.crafts)) registry.crafts = [];
      } catch {
        registry = { version: 1, crafts: [] };
      }
    } else {
      registry = { version: 1, crafts: [] };
    }

    // Replace existing entry with same name (republish/update path)
    registry.crafts = registry.crafts.filter((c: any) => c?.name !== bundle.entry.name);
    registry.crafts.push(bundle.entry);
    registry.crafts.sort((a: any, b: any) => (a.name || '').localeCompare(b.name || ''));
    writeFileSync(regPath, JSON.stringify(registry, null, 2) + '\n', 'utf8');
    step(`Updated registry.json (${registry.crafts.length} crafts)`);

    // ── 6. Commit + push ───────────────────────────────────────
    exec(`git add .`, repoDir, 5000);
    // Configure committer if not set globally — required for fresh containers
    try { exec('git config user.email', repoDir, 2000); } catch {
      exec(`git config user.email "${me}@users.noreply.github.com"`, repoDir, 2000);
      exec(`git config user.name "${me}"`, repoDir, 2000);
    }
    exec(`git commit -m "${prTitle.replace(/"/g, '\\"')}"`, repoDir, 10000);
    step(`Pushing branch…`);
    exec(`git push -u origin ${branch}`, repoDir, 60000);

    // ── 7. Open PR against upstream ────────────────────────────
    step(`Opening PR…`);
    const body = [
      `Submitted via Forge's one-click craft publish.`,
      ``,
      `**Craft**: \`${bundle.entry.name}\` v${bundle.entry.version}`,
      bundle.entry.description ? `**Description**: ${bundle.entry.description}` : '',
      bundle.entry.tags?.length ? `**Tags**: ${bundle.entry.tags.join(', ')}` : '',
      bundle.entry.author ? `**Author**: ${bundle.entry.author}` : '',
      ``,
      `Files:`,
      ...bundle.files.map(f => `- \`${name}/${f.path}\``),
      `- \`registry.json\` (entry added/updated)`,
    ].filter(Boolean).join('\n');
    const bodyFile = join(tmp, 'pr-body.md');
    writeFileSync(bodyFile, body, 'utf8');
    const prOut = exec(
      `gh pr create --repo ${ownerRepo} --base main --head ${me}:${branch} --title "${prTitle.replace(/"/g, '\\"')}" --body-file "${bodyFile}"`,
      repoDir, 30000
    ).trim();

    // gh prints the PR URL on the last line
    const prUrl = prOut.split('\n').filter(l => l.startsWith('http')).pop() || prOut;

    return NextResponse.json({ ok: true, prUrl, branch, log });
  } catch (e: any) {
    const stderr = (e?.stderr || '').toString();
    return NextResponse.json({
      error: e?.message?.split('\n')[0] || String(e),
      stderr: stderr.slice(0, 2000),
      log,
    }, { status: 500 });
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

// GET — quick probe so the UI can decide whether to show the one-click button
export async function GET() {
  try {
    exec('gh auth status', undefined, 5000);
    const me = exec('gh api user --jq .login', undefined, 5000).trim();
    return NextResponse.json({ available: true, user: me });
  } catch {
    return NextResponse.json({ available: false });
  }
}
