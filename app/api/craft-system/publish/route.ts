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

  return NextResponse.json({
    entry: bundle.entry,
    files: bundle.files,
    instructions: [
      `Open a PR against https://github.com/${ownerRepo}`,
      `1. Create a folder \`${bundle.entry.name}/\` at the repo root.`,
      `2. Add the files listed below into that folder.`,
      `3. Append the registry-entry JSON to \`registry.json\` under \`crafts: [...]\`.`,
      `4. Submit the PR. Once merged, all Forge users can install via the marketplace browser.`,
    ],
  });
}
