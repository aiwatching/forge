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
  const newFileUrl = (path: string, content: string, filename: string) =>
    `${ghBase}/new/main/${encodeURIComponent(path)}?filename=${encodeURIComponent(filename)}&value=${encodeURIComponent(content)}`;
  const editFileUrl = (path: string) => `${ghBase}/edit/main/${encodeURIComponent(path)}`;

  const fileLinks = bundle.files.map(f => ({
    path: f.path,
    githubUrl: newFileUrl(bundle.entry.name, f.content, f.path),
  }));

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
