#!/usr/bin/env tsx
/**
 * Benchmark Runner — Compare Claude Code single-agent vs Forge multi-smith workspace.
 *
 * Runs all tasks under `tasks/<task-name>/` through both harnesses.
 * Tracks tokens + cost per run.
 *
 * Usage: pnpm tsx scripts/bench/run.ts [task-name]
 *   Without args: runs all tasks.
 *   With task name (e.g. "01-text-utils"): runs only that task.
 */

import { execSync, spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Use isolated bench project to avoid touching user's real workspaces.
// Create with: mkdir -p /tmp/forge-bench-project/src && cd /tmp/forge-bench-project && git init
const PROJECT = process.env.BENCH_PROJECT || '/tmp/forge-bench-project';
const FORGE_URL = process.env.FORGE_URL || 'http://localhost:8403';
const TASKS_DIR = join(__dirname, 'tasks');
const RESULTS_DIR = join(__dirname, 'results');
const TASK_TIMEOUT_MS = 25 * 60 * 1000; // 25 min per run
const POLL_INTERVAL_MS = 10_000;

// Claude Code session dirs: root + any sub-workdirs smiths might use.
// Claude resolves symlinks (e.g. /tmp → /private/tmp on macOS) when encoding project paths.
const CLAUDE_PROJECTS_ROOT = join(homedir(), '.claude', 'projects');
const encodePath = (p: string) => p.replace(/[^a-zA-Z0-9]/g, '-');
const PROJECT_REAL = (() => { try { return realpathSync(PROJECT); } catch { return PROJECT; } })();
const CLAUDE_PROJECT_DIRS = [
  join(CLAUDE_PROJECTS_ROOT, encodePath(PROJECT_REAL)),
  join(CLAUDE_PROJECTS_ROOT, encodePath(PROJECT_REAL + '/src')),
  join(CLAUDE_PROJECTS_ROOT, encodePath(PROJECT_REAL + '/qa')),
  join(CLAUDE_PROJECTS_ROOT, encodePath(PROJECT_REAL + '/review')),
];

if (!existsSync(RESULTS_DIR)) mkdirSync(RESULTS_DIR, { recursive: true });

interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUSD: number;
}

interface Result {
  task: string;
  harness: 'claude' | 'forge';
  branch: string;
  pass: boolean;
  durationMs: number;
  filesChanged: string[];
  usage: Usage;
  errorDetails?: string;
  validatorTail?: string;
}

// ─── Git helpers ──────────────────────────────────────────

function git(cmd: string): string {
  return execSync(`git ${cmd}`, { cwd: PROJECT, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function ensureCleanBranch(): void {
  console.log('[bench] Preparing harness_test repo...');
  try { git('stash -u'); } catch {}
  git('checkout main');
  try { git('clean -fdx --exclude=.idea --exclude=node_modules --exclude=.forge'); } catch {}
  const branches = git('branch --list bench/start');
  if (branches) git('branch -D bench/start');
  git('checkout -b bench/start');
  console.log('[bench] bench/start branch ready at', git('rev-parse HEAD').slice(0, 7));
}

function createBranch(name: string): void {
  try { git(`branch -D ${name}`); } catch {}
  git(`checkout -B ${name} bench/start`);
}

function getChangedFiles(): string[] {
  const diff = git(`diff --name-only bench/start...HEAD`);
  return diff.split('\n').filter(Boolean);
}

// ─── Validator ────────────────────────────────────────────

function runValidator(validatorPath: string): { pass: boolean; output: string } {
  try {
    const output = execSync(`bash ${validatorPath} ${PROJECT}`, {
      encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { pass: true, output };
  } catch (err: any) {
    const output = (err.stdout || '') + (err.stderr || '') + '\n' + (err.message || '');
    return { pass: false, output };
  }
}

function runSetup(setupPath: string): void {
  if (!existsSync(setupPath)) return;
  console.log(`[bench] Running setup: ${setupPath}`);
  execSync(`bash ${setupPath} ${PROJECT}`, { encoding: 'utf-8', stdio: 'inherit' });
  // Commit setup output so bench branches start from the post-setup state
  git('add -A');
  try { git(`commit -m "task-setup" --allow-empty`); } catch {}
}

// ─── Token tracking ───────────────────────────────────────

function snapshotClaudeSessions(): Map<string, number> {
  // Key: full file path, Value: byte size at snapshot time
  const sizes = new Map<string, number>();
  for (const dir of CLAUDE_PROJECT_DIRS) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      const fp = join(dir, f);
      try { sizes.set(fp, statSync(fp).size); } catch {}
    }
  }
  return sizes;
}

function computeForgeUsage(before: Map<string, number>): Usage {
  const usage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0 };
  let newFiles = 0, modifiedFiles = 0, assistCount = 0;
  for (const dir of CLAUDE_PROJECT_DIRS) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      const fp = join(dir, f);
      const prevSize = before.has(fp) ? before.get(fp)! : 0;
      const curSize = statSync(fp).size;
      if (curSize <= prevSize) continue;
      if (prevSize === 0) newFiles++; else modifiedFiles++;

      // Read as buffer and slice by bytes (jsonl may have multi-byte chars)
      const buf = readFileSync(fp);
      const newContent = buf.slice(prevSize).toString('utf-8');
      for (const line of newContent.split('\n')) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);
          const u = obj.message?.usage;
          if (!u || obj.type !== 'assistant') continue;
          assistCount++;
          usage.inputTokens += u.input_tokens || 0;
          usage.outputTokens += u.output_tokens || 0;
          usage.cacheReadInputTokens += u.cache_read_input_tokens || 0;
          usage.cacheCreationInputTokens += u.cache_creation_input_tokens || 0;
        } catch {}
      }
    }
  }
  console.log(`[forge-usage] dirs=${CLAUDE_PROJECT_DIRS.length} new=${newFiles} modified=${modifiedFiles} entries=${assistCount}`);
  // Rough cost estimate (Sonnet 4.6 pricing: $3/M input, $15/M output, $0.30/M cache read, $3.75/M cache creation)
  // Numbers approximate, update if pricing changes
  const COST_IN_PER_M = 3;
  const COST_OUT_PER_M = 15;
  const COST_CACHE_READ_PER_M = 0.3;
  const COST_CACHE_CREATE_PER_M = 3.75;
  usage.costUSD =
    (usage.inputTokens * COST_IN_PER_M +
     usage.outputTokens * COST_OUT_PER_M +
     usage.cacheReadInputTokens * COST_CACHE_READ_PER_M +
     usage.cacheCreationInputTokens * COST_CACHE_CREATE_PER_M) / 1_000_000;
  return usage;
}

// ─── Claude Code headless runner ──────────────────────────

async function runClaudeCode(taskName: string, taskPrompt: string, branch: string): Promise<Result> {
  console.log(`\n[claude] === Running Claude Code on branch ${branch} ===`);
  createBranch(branch);
  const start = Date.now();

  return new Promise((resolve) => {
    const child = spawn('claude', [
      '-p',
      '--dangerously-skip-permissions',
      '--output-format', 'json',
      taskPrompt,
    ], {
      cwd: PROJECT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, TASK_TIMEOUT_MS);

    child.on('close', (code) => {
      clearTimeout(timer);
      const durationMs = Date.now() - start;
      console.log(`[claude] Exit: ${code}, duration: ${Math.round(durationMs / 1000)}s${timedOut ? ' (TIMEOUT)' : ''}`);

      // Parse usage from JSON output
      const usage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0 };
      try {
        const parsed = JSON.parse(stdout);
        if (parsed.usage) {
          usage.inputTokens = parsed.usage.input_tokens || 0;
          usage.outputTokens = parsed.usage.output_tokens || 0;
          usage.cacheReadInputTokens = parsed.usage.cache_read_input_tokens || 0;
          usage.cacheCreationInputTokens = parsed.usage.cache_creation_input_tokens || 0;
        }
        usage.costUSD = parsed.total_cost_usd || 0;
      } catch {}

      // Commit and validate
      try { git('add -A'); git('commit -m "claude-code run" --allow-empty'); } catch {}
      const changed = getChangedFiles();

      resolve({
        task: taskName,
        harness: 'claude',
        branch,
        pass: false,
        durationMs,
        filesChanged: changed,
        usage,
        errorDetails: timedOut ? 'TIMEOUT' : (code !== 0 ? `exit ${code}: ${stderr.slice(-300)}` : undefined),
      });
    });
  });
}

// ─── Forge workspace API ──────────────────────────────────

async function api(path: string, opts: RequestInit = {}): Promise<any> {
  const res = await fetch(`${FORGE_URL}${path}`, {
    ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  const text = await res.text();
  let data: any; try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) throw new Error(`${res.status} ${path}: ${text.slice(0, 200)}`);
  return data;
}

function makeAgent(opts: {
  id: string; label: string; icon: string; workDir: string;
  dependsOn: string[]; outputs: string[]; role: string;
  steps: { id: string; label: string; prompt: string }[];
  primary?: boolean;
}) {
  return {
    id: opts.id, label: opts.label, icon: opts.icon,
    type: 'agent' as const, primary: opts.primary || false,
    backend: 'cli', agentId: 'claude',
    dependsOn: opts.dependsOn, workDir: opts.workDir, outputs: opts.outputs,
    role: opts.role, steps: opts.steps,
    persistentSession: true, skipPermissions: true,
  };
}

function cleanStaleRequests(): void {
  const reqDir = join(PROJECT, '.forge', 'requests');
  if (existsSync(reqDir)) {
    try {
      execSync(`rm -rf ${reqDir}`, { encoding: 'utf-8' });
      console.log('[bench] Cleaned stale .forge/requests/');
    } catch {}
  }
}

function killStaleTmuxSessions(): void {
  try {
    const list = execSync('tmux list-sessions 2>/dev/null || true', { encoding: 'utf-8' });
    for (const line of list.split('\n')) {
      const name = line.split(':')[0];
      // Only kill sessions for the bench project — safe isolation
      if (name.startsWith('mw-forge-forge-bench-project') || name.startsWith('mw-forge-bench-project')) {
        try { execSync(`tmux kill-session -t "${name}" 2>/dev/null`, { timeout: 3000 }); } catch {}
      }
    }
    console.log('[bench] Killed stale tmux sessions');
  } catch {}
}

async function deleteExistingWorkspace(): Promise<void> {
  try {
    const existing = await api(`/api/workspace?projectPath=${encodeURIComponent(PROJECT)}`);
    if (existing && existing.id) {
      console.log(`[forge] Deleting existing workspace ${existing.id}`);
      try { await api(`/api/workspace/${existing.id}/agents`, { method: 'POST', body: JSON.stringify({ action: 'stop_daemon' }) }); } catch {}
      await new Promise(r => setTimeout(r, 2000));
      await api(`/api/workspace?id=${existing.id}`, { method: 'DELETE' });
      await new Promise(r => setTimeout(r, 1000));
    }
  } catch {}
  killStaleTmuxSessions();
}

async function runForgeWorkspace(taskName: string, taskPrompt: string, branch: string, validatorPath: string): Promise<Result> {
  console.log(`\n[forge] === Running Forge workspace on branch ${branch} ===`);
  createBranch(branch);

  const tokenSnapshot = snapshotClaudeSessions();
  const start = Date.now();
  let wsId: string | null = null;

  try {
    cleanStaleRequests();
    await deleteExistingWorkspace();

    const ws = await api('/api/workspace', {
      method: 'POST',
      body: JSON.stringify({ projectPath: PROJECT, projectName: 'forge-bench' }),
    });
    wsId = ws.id;
    console.log(`[forge] Created workspace: ${wsId}`);

    const ts = Date.now();
    const inputId = `input-${ts}`;
    const leadId = `lead-${ts}`;
    const engId = `engineer-${ts}`;
    const reviewerId = `reviewer-${ts}`;
    const qaId = `qa-${ts}`;

    // Input
    await api(`/api/workspace/${wsId}/agents`, {
      method: 'POST',
      body: JSON.stringify({
        action: 'add',
        config: {
          id: inputId, label: 'Requirements', icon: '📝',
          type: 'input', content: '', entries: [],
          role: '', backend: 'cli', dependsOn: [], outputs: [], steps: [],
        },
      }),
    });

    // Lead (Primary)
    await api(`/api/workspace/${wsId}/agents`, {
      method: 'POST',
      body: JSON.stringify({
        action: 'add',
        config: makeAgent({
          id: leadId, label: 'Lead', icon: '👑', primary: true, workDir: './',
          dependsOn: [inputId], outputs: ['docs/lead/'],
          role: 'Lead coordinator. Read upstream task VERBATIM. Create one request with the FULL original task text as description AND every single requirement extracted into acceptance_criteria. Do NOT summarize or simplify — preserve all details.',
          steps: [
            { id: 'create-req', label: 'Create Request', prompt: 'Read the upstream task. Create ONE request via create_request:\n- title: short descriptive\n- description: THE ENTIRE ORIGINAL TASK TEXT copied verbatim (do not summarize)\n- acceptance_criteria: extract EVERY requirement as a testable bullet. Include every field, every validation rule, every edge case mentioned in the task. Do not drop any detail.\n- priority: "high"\nThen verify with list_requests.' },
          ],
        }),
      }),
    });

    // Engineer
    await api(`/api/workspace/${wsId}/agents`, {
      method: 'POST',
      body: JSON.stringify({
        action: 'add',
        config: makeAgent({
          id: engId, label: 'Engineer', icon: '🔨', workDir: './src',
          dependsOn: [leadId], outputs: ['src/'],
          role: 'Engineer. Claim open requests. Implement COMPLETELY — every acceptance_criterion, every validation rule, every field specified. If Reviewer requests changes, read their findings and fix ALL items listed.',
          steps: [
            { id: 'claim', label: 'Claim', prompt: 'list_requests(status: "open"). If the request has a review section with result "changes_requested", skip the claim step and go directly to fixing. Otherwise claim_request on the first open item.' },
            { id: 'implement', label: 'Implement', prompt: 'get_request for the item. Read the ORIGINAL task description AND every single acceptance_criterion. Implement ALL of them — do not skip any. Every field, every validation, every edge case. Write tests covering each criterion. Run tests to verify pass.' },
            { id: 'report', label: 'Report', prompt: 'update_response(section: "engineer", data: { files_changed: [...], notes: "list each criterion and how you implemented it" }).' },
          ],
        }),
      }),
    });

    // Reviewer — checks Engineer's work against the ORIGINAL task spec, not just Engineer's tests
    await api(`/api/workspace/${wsId}/agents`, {
      method: 'POST',
      body: JSON.stringify({
        action: 'add',
        config: makeAgent({
          id: reviewerId, label: 'Reviewer', icon: '🔍', workDir: './review',
          dependsOn: [engId], outputs: ['docs/review/'],
          role: 'Reviewer. Verify the Engineer\'s implementation matches the ORIGINAL task spec (not just the tests they wrote). Read the request description AND acceptance_criteria. Check for missing features, missing validation, missing edge cases.',
          steps: [
            { id: 'review', label: 'Review', prompt: 'list_requests(status: "review"). get_request for details. READ the ORIGINAL task description carefully. Then read the files the Engineer created. Check: (1) every acceptance_criterion is covered, (2) all error handling specified in the task is implemented, (3) all return/output fields specified are present. If anything is missing, list specific issues. update_response(section: "review") with result: "approved" if all matches, or "changes_requested" with findings listing each missing piece.' },
          ],
        }),
      }),
    });

    // QA
    await api(`/api/workspace/${wsId}/agents`, {
      method: 'POST',
      body: JSON.stringify({
        action: 'add',
        config: makeAgent({
          id: qaId, label: 'QA', icon: '🧪', workDir: './qa',
          dependsOn: [reviewerId], outputs: ['docs/qa/'],
          role: 'QA. After Reviewer approves, write INDEPENDENT test cases based on the ORIGINAL task spec. Test every acceptance_criterion, including edge cases and validation. Do not just run engineer\'s existing tests — verify the spec yourself.',
          steps: [
            { id: 'test', label: 'Test', prompt: 'list_requests(status: "qa"). get_request for details. Read the ORIGINAL task description. Write your own independent tests that verify EACH acceptance_criterion and error case from the spec. Run them. update_response(section: "qa") with result passed/failed and findings.' },
          ],
        }),
      }),
    });
    console.log('[forge] Added 5 agents (Input + Lead + Engineer + Reviewer + QA)');

    await api(`/api/workspace/${wsId}/agents`, { method: 'POST', body: JSON.stringify({ action: 'start_daemon' }) });
    console.log('[forge] Daemon started');
    await new Promise(r => setTimeout(r, 10_000));

    await api(`/api/workspace/${wsId}/agents`, {
      method: 'POST', body: JSON.stringify({ action: 'complete_input', agentId: inputId, content: taskPrompt }),
    });
    console.log('[forge] Input submitted — bus auto-notifies Lead via persistent session (with MCP)');

    // Poll strategy: validator + all-done stability check.
    // Break when validator passes, or when all smiths stable done for 90s (they gave up).
    const deadline = Date.now() + TASK_TIMEOUT_MS;
    const IDLE_GIVEUP_MS = 90_000;
    let pollCount = 0;
    let validatorPassed = false;
    let firstAllIdleAt: number | null = null;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
      pollCount++;
      const state = await api(`/api/workspace/${wsId}/agents`);
      const agentStates = state.states || state.agentStates || {};
      const smiths = (state.agents || []).filter((a: any) => a.type !== 'input');
      const statuses = smiths.map((a: any) => {
        const s = agentStates[a.id];
        return `${a.label}=${s?.taskStatus || '?'}`;
      }).join(' ');
      const allIdle = smiths.every((a: any) => {
        const ts = agentStates[a.id]?.taskStatus;
        return ts === 'done' || ts === 'failed' || ts === 'idle';
      });
      if (allIdle) {
        if (firstAllIdleAt === null) firstAllIdleAt = Date.now();
      } else {
        firstAllIdleAt = null;
      }
      const v = runValidator(validatorPath);
      const idleFor = firstAllIdleAt ? Date.now() - firstAllIdleAt : 0;
      console.log(`[forge] Poll ${pollCount}: ${statuses} | validator=${v.pass ? 'PASS' : 'fail'}${firstAllIdleAt ? ` idle=${Math.round(idleFor/1000)}s` : ''}`);
      if (v.pass) { validatorPassed = true; break; }
      if (firstAllIdleAt && idleFor >= IDLE_GIVEUP_MS) { console.log('[forge] All smiths idle too long — giving up'); break; }
    }
    console.log(`[forge] Exit: validator ${validatorPassed ? 'passed' : 'FAILED/TIMEOUT'}`);
    const durationMs = Date.now() - start;

    try { await api(`/api/workspace/${wsId}/agents`, { method: 'POST', body: JSON.stringify({ action: 'stop_daemon' }) }); } catch {}
    try { git('add -A'); git('commit -m "forge-workspace run" --allow-empty'); } catch {}

    const changed = getChangedFiles();
    const usage = computeForgeUsage(tokenSnapshot);

    return {
      task: taskName,
      harness: 'forge',
      branch,
      pass: false,
      durationMs,
      filesChanged: changed,
      usage,
    };
  } catch (err: any) {
    console.error('[forge] Error:', err.message);
    if (wsId) {
      try { await api(`/api/workspace/${wsId}/agents`, { method: 'POST', body: JSON.stringify({ action: 'stop_daemon' }) }); } catch {}
    }
    return {
      task: taskName,
      harness: 'forge',
      branch,
      pass: false,
      durationMs: Date.now() - start,
      filesChanged: [],
      usage: computeForgeUsage(tokenSnapshot),
      errorDetails: err.message,
    };
  }
}

// ─── Task loader ──────────────────────────────────────────

interface Task {
  name: string;
  dir: string;
  promptPath: string;
  validatorPath: string;
  setupPath?: string;
}

function loadTasks(filter?: string): Task[] {
  const dirs = readdirSync(TASKS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory() && d.name !== 'results')
    .map(d => d.name)
    .sort();
  const tasks: Task[] = [];
  for (const name of dirs) {
    if (filter && !name.includes(filter)) continue;
    const dir = join(TASKS_DIR, name);
    const promptPath = join(dir, 'task.md');
    const validatorPath = join(dir, 'validator.sh');
    const setupPath = join(dir, 'setup.sh');
    if (!existsSync(promptPath) || !existsSync(validatorPath)) continue;
    tasks.push({
      name, dir, promptPath, validatorPath,
      setupPath: existsSync(setupPath) ? setupPath : undefined,
    });
  }
  return tasks;
}

// ─── Report ───────────────────────────────────────────────

function fmtTokens(u: Usage): string {
  const total = u.inputTokens + u.outputTokens + u.cacheReadInputTokens + u.cacheCreationInputTokens;
  return `${(total / 1000).toFixed(1)}K (in=${u.inputTokens}, out=${u.outputTokens}, cache_r=${(u.cacheReadInputTokens/1000).toFixed(1)}K, cache_w=${(u.cacheCreationInputTokens/1000).toFixed(1)}K)`;
}

function writeReport(results: Result[]): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const byTask = new Map<string, Result[]>();
  for (const r of results) {
    if (!byTask.has(r.task)) byTask.set(r.task, []);
    byTask.get(r.task)!.push(r);
  }

  // Summary table
  let md = `# Benchmark Run — ${new Date().toLocaleString()}\n\n## Summary\n\n`;
  md += `| Task | Harness | Pass | Duration | Tokens | Cost | Files |\n`;
  md += `|------|---------|------|----------|--------|------|-------|\n`;
  for (const r of results) {
    const total = r.usage.inputTokens + r.usage.outputTokens + r.usage.cacheReadInputTokens + r.usage.cacheCreationInputTokens;
    md += `| ${r.task} | ${r.harness} | ${r.pass ? '✅' : '❌'} | ${Math.round(r.durationMs / 1000)}s | ${(total/1000).toFixed(1)}K | $${r.usage.costUSD.toFixed(3)} | ${r.filesChanged.length} |\n`;
  }

  // Per-task comparison
  md += `\n## Per-Task Comparison\n\n`;
  for (const [task, taskResults] of byTask) {
    const claude = taskResults.find(r => r.harness === 'claude');
    const forge = taskResults.find(r => r.harness === 'forge');
    md += `### ${task}\n\n`;
    md += `| Metric | Claude Code | Forge Workspace | Ratio |\n`;
    md += `|--------|-------------|-----------------|-------|\n`;
    if (claude && forge) {
      const cTot = claude.usage.inputTokens + claude.usage.outputTokens + claude.usage.cacheReadInputTokens + claude.usage.cacheCreationInputTokens;
      const fTot = forge.usage.inputTokens + forge.usage.outputTokens + forge.usage.cacheReadInputTokens + forge.usage.cacheCreationInputTokens;
      md += `| Result | ${claude.pass ? '✅' : '❌'} | ${forge.pass ? '✅' : '❌'} | - |\n`;
      md += `| Duration | ${Math.round(claude.durationMs / 1000)}s | ${Math.round(forge.durationMs / 1000)}s | ${(forge.durationMs / claude.durationMs).toFixed(1)}x |\n`;
      md += `| Total tokens | ${(cTot/1000).toFixed(1)}K | ${(fTot/1000).toFixed(1)}K | ${cTot > 0 ? (fTot / cTot).toFixed(1) + 'x' : '-'} |\n`;
      md += `| Cost | $${claude.usage.costUSD.toFixed(3)} | $${forge.usage.costUSD.toFixed(3)} | ${claude.usage.costUSD > 0 ? (forge.usage.costUSD / claude.usage.costUSD).toFixed(1) + 'x' : '-'} |\n`;
      md += `| Files changed | ${claude.filesChanged.length} | ${forge.filesChanged.length} | - |\n`;
      md += `\n**Claude files**: ${claude.filesChanged.join(', ') || '(none)'}\n\n`;
      md += `**Forge files**: ${forge.filesChanged.join(', ') || '(none)'}\n\n`;
      if (claude.errorDetails) md += `**Claude error**: ${claude.errorDetails}\n\n`;
      if (forge.errorDetails) md += `**Forge error**: ${forge.errorDetails}\n\n`;
    }
    md += '\n';
  }

  // Details — validator tails
  md += `## Validator Output Tails\n\n`;
  for (const r of results) {
    const tail = (r.validatorTail || '').slice(-600);
    md += `### ${r.task} / ${r.harness}\n\n\`\`\`\n${tail}\n\`\`\`\n\n`;
  }

  const outPath = join(RESULTS_DIR, `report-${ts}.md`);
  writeFileSync(outPath, md);
  writeFileSync(join(RESULTS_DIR, `report-${ts}.json`), JSON.stringify(results, null, 2));
  return outPath;
}

// ─── Main ─────────────────────────────────────────────────

async function main() {
  const filter = process.argv[2]; // optional task filter
  const tasks = loadTasks(filter);
  if (tasks.length === 0) { console.error('No tasks found'); process.exit(1); }
  console.log(`[bench] Running ${tasks.length} task(s): ${tasks.map(t => t.name).join(', ')}`);

  ensureCleanBranch();
  const results: Result[] = [];

  for (const task of tasks) {
    console.log(`\n${'='.repeat(60)}\n[bench] TASK: ${task.name}\n${'='.repeat(60)}`);
    const prompt = readFileSync(task.promptPath, 'utf-8');

    // Run setup (on bench/start so both harnesses inherit same starting state)
    git('checkout bench/start');
    if (task.setupPath) runSetup(task.setupPath);

    const ts = Date.now();

    // Claude Code
    const claudeResult = await runClaudeCode(task.name, prompt, `bench/${task.name}-claude-${ts}`);
    const cv = runValidator(task.validatorPath);
    claudeResult.pass = cv.pass;
    claudeResult.validatorTail = cv.output;
    console.log(`[claude] ${task.name}: ${cv.pass ? 'PASS' : 'FAIL'}`);
    results.push(claudeResult);

    // Forge Workspace
    const forgeResult = await runForgeWorkspace(task.name, prompt, `bench/${task.name}-forge-${ts}`, task.validatorPath);
    const fv = runValidator(task.validatorPath);
    forgeResult.pass = fv.pass;
    forgeResult.validatorTail = fv.output;
    console.log(`[forge] ${task.name}: ${fv.pass ? 'PASS' : 'FAIL'}`);
    results.push(forgeResult);

    // If setup existed, undo it from bench/start for subsequent tasks
    if (task.setupPath) {
      git('checkout bench/start');
      try { git('reset --hard HEAD~1'); } catch {}
    }
  }

  const reportPath = writeReport(results);
  console.log(`\n[bench] Report written: ${reportPath}`);
  console.log('\n' + readFileSync(reportPath, 'utf-8').split('## Per-Task')[0]);
}

main().catch(err => {
  console.error('[bench] Fatal:', err);
  process.exit(1);
});
