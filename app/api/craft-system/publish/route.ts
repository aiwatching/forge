import { NextResponse } from 'next/server';
import { bundleCraftForPublish } from '@/lib/crafts/registry';
import { loadSettings } from '@/lib/settings';

// POST /api/craft-system/publish   body: { projectPath, name }
// Bundles the craft files + a registry-entry snippet ready to drop into the
// forge-crafts registry repo. Returns { entry, files, instructions }.
export async function POST(req: Request) {
  const { projectPath, name } = await req.json() as { projectPath: string; name: string };
  if (!projectPath || !name) return NextResponse.json({ error: 'projectPath + name required' }, { status: 400 });

  const bundle = bundleCraftForPublish(projectPath, name);
  if (bundle.error) return NextResponse.json({ error: bundle.error }, { status: 400 });

  const repo = (loadSettings() as any).craftsRepoUrl || 'https://raw.githubusercontent.com/aiwatching/forge-crafts/main';
  const repoMatch = repo.match(/github\.com\/([^/]+)\/([^/]+)|raw\.githubusercontent\.com\/([^/]+)\/([^/]+)/);
  const ownerRepo = repoMatch ? `${repoMatch[1] || repoMatch[3]}/${(repoMatch[2] || repoMatch[4]).replace(/\.git$/, '')}` : 'aiwatching/forge-crafts';

  // GitHub web-edit deep links — clicking "create file" without write access
  // makes GitHub auto-fork the repo into the user's account, create the file
  // in the fork, and prompt to open a PR. Zero local-clone required.
  const ghBase = `https://github.com/${ownerRepo}`;
  const editFileUrl = (path: string) => `${ghBase}/edit/main/${encodeURIComponent(path)}`;

  // GitHub's /new/<branch>/<dir>?filename=<name>&value=<...> — dir + filename
  // are independent so we split nested paths into prefix dir / leaf name.
  const fileLinks = bundle.files.map(f => {
    const lastSlash = f.path.lastIndexOf('/');
    const subdir = lastSlash >= 0 ? f.path.slice(0, lastSlash) : '';
    const filename = lastSlash >= 0 ? f.path.slice(lastSlash + 1) : f.path;
    const dirPath = subdir ? `${bundle.entry.name}/${subdir}` : bundle.entry.name;
    const githubUrl = `${ghBase}/new/main/${dirPath.split('/').map(encodeURIComponent).join('/')}?filename=${encodeURIComponent(filename)}&value=${encodeURIComponent(f.content)}`;
    return { path: f.path, githubUrl };
  });

  return NextResponse.json({
    entry: bundle.entry,
    files: bundle.files,
    fileLinks,
    repo: { owner: ownerRepo.split('/')[0], name: ownerRepo.split('/')[1], url: ghBase },
    registryEditUrl: editFileUrl('registry.json'),
    instructions: [
      `All publishes go through a pull request — direct pushes to main are not accepted, even from maintainers.`,
      `1. Click each file's "Open in GitHub" button. GitHub auto-forks ${ownerRepo} into your account (if you don't have write access) and creates the file there.`,
      `2. After all files are created, open registry.json and append the JSON entry from the "registry.json entry" tab.`,
      `3. In each commit dialog, pick "Create a new branch for this commit and start a pull request" — never commit to main directly.`,
      `4. After the last commit, GitHub takes you straight to the PR. Submit it; once merged, the craft appears in every Forge user's marketplace.`,
    ],
  });
}
