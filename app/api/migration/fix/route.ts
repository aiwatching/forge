import { NextResponse } from 'next/server';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createTask } from '@/lib/task-manager';
import { buildDiagnosisContext, renderDiagnosisMarkdown, renderBatchDiagnosis } from '@/lib/migration/diagnose';

interface FixRequest {
  projectPath: string;
  projectName?: string;
  mode: 'inject' | 'task';
  endpointIds?: string[];
  sessionName?: string;
  customPrompt?: string;
}

export async function POST(req: Request) {
  const body = await req.json() as FixRequest;
  const { projectPath, projectName, mode, endpointIds, sessionName, customPrompt } = body;
  if (!projectPath || !mode) return NextResponse.json({ error: 'projectPath + mode required' }, { status: 400 });
  if (!endpointIds || endpointIds.length === 0) return NextResponse.json({ error: 'endpointIds required' }, { status: 400 });

  const ctxs = endpointIds
    .map(id => buildDiagnosisContext(projectPath, id))
    .filter((x): x is NonNullable<typeof x> => !!x);
  if (ctxs.length === 0) return NextResponse.json({ error: 'no endpoints found' }, { status: 404 });

  let prompt = ctxs.length === 1 ? renderDiagnosisMarkdown(ctxs[0]) : renderBatchDiagnosis(ctxs);
  if (customPrompt) prompt += '\n\n## Additional context from user\n\n' + customPrompt;

  if (mode === 'task') {
    const name = projectName || projectPath.split('/').filter(Boolean).pop() || 'project';
    const task = createTask({ projectName: name, projectPath, prompt });
    return NextResponse.json({ ok: true, mode: 'task', taskId: task.id, count: ctxs.length });
  }

  if (mode === 'inject') {
    if (!sessionName) return NextResponse.json({ error: 'sessionName required for inject mode' }, { status: 400 });
    try {
      const buf = join(tmpdir(), `forge-migration-fix-${Date.now()}.txt`);
      writeFileSync(buf, prompt);
      execSync(`tmux load-buffer -t "${sessionName}" "${buf}" && tmux paste-buffer -t "${sessionName}" && sleep 0.2 && tmux send-keys -t "${sessionName}" Enter`, { timeout: 5000 });
      try { unlinkSync(buf); } catch {}
      return NextResponse.json({ ok: true, mode: 'inject', sessionName, count: ctxs.length });
    } catch (e: any) {
      return NextResponse.json({ error: e?.message || String(e) }, { status: 500 });
    }
  }

  return NextResponse.json({ error: 'invalid mode' }, { status: 400 });
}
