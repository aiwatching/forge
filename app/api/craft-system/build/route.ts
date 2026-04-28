import { NextResponse } from 'next/server';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createTask } from '@/lib/task-manager';
import { getCraft } from '@/lib/crafts/loader';

interface BuildRequest {
  projectPath: string;
  projectName?: string;
  request: string;       // user's natural-language description
  craftName?: string;    // for refine — existing craft to modify
}

function buildPrompt(req: BuildRequest, refining?: boolean, existing?: { manifest?: string; ui?: string; server?: string; promptHistory?: string }) {
  const lines: string[] = [];
  lines.push(refining
    ? `# Refine Forge Craft \`${req.craftName}\``
    : `# Build a new Forge Craft for project ${req.projectName || req.projectPath}`);
  lines.push('');
  lines.push('Use the **craft-builder** skill loaded in your environment. Follow its rules exactly.');
  lines.push('');
  lines.push('## User request');
  lines.push('');
  lines.push('```');
  lines.push(req.request);
  lines.push('```');
  lines.push('');
  if (refining && existing) {
    lines.push('## Existing craft files');
    lines.push('');
    if (existing.manifest) { lines.push('### craft.yaml'); lines.push('```yaml'); lines.push(existing.manifest); lines.push('```'); lines.push(''); }
    if (existing.ui) { lines.push('### ui.tsx'); lines.push('```tsx'); lines.push(existing.ui); lines.push('```'); lines.push(''); }
    if (existing.server) { lines.push('### server.ts'); lines.push('```ts'); lines.push(existing.server); lines.push('```'); lines.push(''); }
    if (existing.promptHistory) { lines.push('### prompt.md (history)'); lines.push('```markdown'); lines.push(existing.promptHistory); lines.push('```'); lines.push(''); }
    lines.push('Apply the user request as a **minimal change** to the existing craft. Preserve everything that works. Append the refine request to `prompt.md`.');
  } else {
    lines.push(`Write the craft into \`${req.projectPath}/.forge/crafts/<chosen-name>/\`.`);
    lines.push('Pick a kebab-case name based on what the user wants. After writing files, the new tab will show up automatically.');
  }
  lines.push('');
  lines.push('Reference sample: `lib/builtin-crafts/file-counter/` (in the Forge install). Read it for the file shape.');
  return lines.join('\n');
}

export async function POST(req: Request) {
  const body = await req.json() as BuildRequest;
  const { projectPath, projectName, request, craftName } = body;
  if (!projectPath || !request) return NextResponse.json({ error: 'projectPath + request required' }, { status: 400 });

  let refining = false;
  let existing: any = undefined;
  if (craftName) {
    const c = getCraft(projectPath, craftName);
    if (c && c.__scope === 'project') {
      refining = true;
      const dir = c.__dir;
      const read = (f: string) => existsSync(join(dir, f)) ? readFileSync(join(dir, f), 'utf8') : undefined;
      existing = {
        manifest: read('craft.yaml'),
        ui: read('ui.tsx'),
        server: read('server.ts'),
        promptHistory: read('prompt.md'),
      };
    }
  }

  // Ensure project crafts dir exists so the AI has somewhere to write.
  const craftsDir = join(projectPath, '.forge', 'crafts');
  if (!existsSync(craftsDir)) mkdirSync(craftsDir, { recursive: true });

  const prompt = buildPrompt(body, refining, existing);
  const task = createTask({
    projectName: projectName || projectPath.split('/').filter(Boolean).pop() || 'project',
    projectPath,
    prompt,
  });
  return NextResponse.json({ ok: true, taskId: task.id, refining });
}
