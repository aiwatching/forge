import { NextResponse } from 'next/server';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { loadEndpoints } from '@/lib/migration/store';
import { createTask } from '@/lib/task-manager';
import type { Failure } from '@/lib/migration/types';

interface FixRequest {
  projectPath: string;
  projectName?: string;
  mode: 'inject' | 'task';
  endpointIds?: string[];           // single or batch
  failures?: Failure[];             // optional pre-clustered failures
  sessionName?: string;             // tmux session for inject mode
  customPrompt?: string;
}

function buildPrompt(eps: any[], failures?: Failure[], custom?: string): string {
  const lines: string[] = [];
  lines.push('# API parity fix request');
  lines.push('');
  lines.push('The following endpoints in the new web-server module produce results that differ from the legacy module. The legacy code MUST NOT be changed — fix the new module so its output matches.');
  lines.push('');
  if (failures && failures.length > 0) {
    lines.push('## Failures');
    for (const f of failures) {
      lines.push(`- \`${f.method} ${f.path}\` (${f.controller}) — ${f.errorType}: ${f.errorMessage}`);
    }
  } else if (eps.length > 0) {
    lines.push('## Endpoints');
    for (const e of eps) {
      lines.push(`- \`${e.method} ${e.path}\` — controller: ${e.controller}, status: ${e.status}${e.notes ? `, notes: ${e.notes}` : ''}`);
    }
  }
  lines.push('');
  lines.push('## Approach');
  lines.push('1. Read .forge/migration/runs/*.json for the latest run output and diffs.');
  lines.push('2. Identify the controller class in the new web-server module.');
  lines.push('3. Compare to the legacy implementation — focus on response shape, status codes, field names.');
  lines.push('4. Apply minimal fix; do not change unrelated code.');
  lines.push('5. Re-run the migration cockpit batch test for these endpoints.');
  if (custom) {
    lines.push('');
    lines.push('## Additional context');
    lines.push(custom);
  }
  return lines.join('\n');
}

export async function POST(req: Request) {
  const body = await req.json() as FixRequest;
  const { projectPath, projectName, mode, endpointIds, failures, sessionName, customPrompt } = body;
  if (!projectPath || !mode) return NextResponse.json({ error: 'projectPath + mode required' }, { status: 400 });

  const all = loadEndpoints(projectPath);
  const ids = new Set(endpointIds || []);
  const eps = ids.size > 0 ? all.filter(e => ids.has(e.id)) : [];
  const prompt = buildPrompt(eps, failures, customPrompt);

  if (mode === 'task') {
    const name = projectName || projectPath.split('/').filter(Boolean).pop() || 'project';
    const task = createTask({ projectName: name, projectPath, prompt });
    return NextResponse.json({ ok: true, mode: 'task', taskId: task.id });
  }

  if (mode === 'inject') {
    if (!sessionName) return NextResponse.json({ error: 'sessionName required for inject mode' }, { status: 400 });
    try {
      const buf = join(tmpdir(), `forge-migration-fix-${Date.now()}.txt`);
      writeFileSync(buf, prompt);
      execSync(`tmux load-buffer -t "${sessionName}" "${buf}" && tmux paste-buffer -t "${sessionName}" && sleep 0.2 && tmux send-keys -t "${sessionName}" Enter`, { timeout: 5000 });
      try { unlinkSync(buf); } catch {}
      return NextResponse.json({ ok: true, mode: 'inject', sessionName });
    } catch (e: any) {
      return NextResponse.json({ error: e?.message || String(e) }, { status: 500 });
    }
  }

  return NextResponse.json({ error: 'invalid mode' }, { status: 400 });
}
