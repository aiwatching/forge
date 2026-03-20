#!/usr/bin/env npx tsx
/**
 * forge — Forge CLI
 *
 * Local CLI that talks to the same backend as Telegram.
 * Usage:
 *   mw task <project> "prompt"     — submit a task
 *   mw run <flow-name>             — run a YAML workflow
 *   mw tasks [status]              — list tasks
 *   mw log <id>                    — show task execution log
 *   mw status <id>                 — task details
 *   mw cancel <id>                 — cancel a task
 *   mw retry <id>                  — retry a failed task
 *   mw flows                       — list available workflows
 *   mw projects                    — list projects
 *   mw watch <id>                  — live stream task output
 */

const BASE = process.env.MW_URL || 'http://localhost:3000';

const [, , cmd, ...args] = process.argv;

/** Check npm for newer version, print reminder if available */
async function checkForUpdate() {
  try {
    const { readFileSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf-8'));
    const current = pkg.version;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const res = await fetch('https://registry.npmjs.org/@aion0/forge/latest', {
      signal: controller.signal,
      headers: { 'Accept': 'application/json' },
    });
    clearTimeout(timeout);
    if (!res.ok) return;
    const data = await res.json();
    const latest = data.version;

    const [ca, cb, cc] = current.split('.').map(Number);
    const [la, lb, lc] = latest.split('.').map(Number);
    if (la > ca || (la === ca && lb > cb) || (la === ca && lb === cb && lc > cc)) {
      console.log(`\n  Update available: v${current} → v${latest}`);
      console.log(`  Run: forge upgrade\n`);
    }
  } catch {}
}

async function api(path: string, opts?: RequestInit) {
  const res = await fetch(`${BASE}${path}`, opts);
  if (!res.ok) {
    const text = await res.text();
    console.error(`Error ${res.status}: ${text}`);
    process.exit(1);
  }
  return res.json();
}

async function main() {
  if (cmd === '--version' || cmd === '-v') {
    const { readFileSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    try {
      const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf-8'));
      console.log(`@aion0/forge v${pkg.version}`);
    } catch {
      console.log('forge (version unknown)');
    }
    process.exit(0);
  }

  if (cmd === '--reset-password') {
    // Shortcut: delegate to forge-server.mjs --reset-password
    const { execSync } = await import('node:child_process');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const serverScript = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'forge-server.mjs');
    try {
      execSync(`node ${serverScript} --reset-password`, { stdio: 'inherit' });
    } catch {}
    process.exit(0);
  }

  switch (cmd) {
    case 'task':
    case 't': {
      // Parse --new flag to force a fresh session
      const newSession = args.includes('--new');
      const filtered = args.filter(a => a !== '--new');
      const project = filtered[0];
      const prompt = filtered.slice(1).join(' ');
      if (!project || !prompt) {
        console.log('Usage: mw task <project> <prompt> [--new]');
        console.log('  --new    Start a fresh session (ignore previous context)');
        console.log('Example: mw task my-app "Fix the login bug"');
        process.exit(1);
      }
      const task = await api('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectName: project, prompt, newSession }),
      });
      const session = task.conversationId ? '(continuing session)' : '(new session)';
      console.log(`✓ Task ${task.id} created ${session}`);
      console.log(`  Project: ${task.projectName}`);
      console.log(`  ${prompt}`);
      console.log(`\n  Watch: mw watch ${task.id}`);
      console.log(`  Status: mw status ${task.id}`);
      break;
    }

    case 'run':
    case 'r': {
      const flowName = args[0];
      if (!flowName) {
        console.log('Usage: mw run <flow-name>');
        console.log('List flows: mw flows');
        process.exit(1);
      }
      const result = await api('/api/flows/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: flowName }),
      });
      console.log(`✓ Flow "${flowName}" started`);
      for (const t of result.tasks) {
        console.log(`  Task ${t.id}: ${t.projectName} — ${t.prompt.slice(0, 60)}`);
      }
      break;
    }

    case 'tasks':
    case 'ls': {
      const status = args[0] || '';
      const query = status ? `?status=${status}` : '';
      const tasks = await api(`/api/tasks${query}`);
      if (tasks.length === 0) {
        console.log('No tasks.');
        break;
      }
      const icons: Record<string, string> = {
        queued: '⏳', running: '🔄', done: '✅', failed: '❌', cancelled: '⚪',
      };
      for (const t of tasks) {
        const icon = icons[t.status] || '?';
        const cost = t.costUSD != null ? ` $${t.costUSD.toFixed(3)}` : '';
        console.log(`${icon} ${t.id}  ${t.status.padEnd(9)} ${t.projectName.padEnd(20)} ${t.prompt.slice(0, 50)}${cost}`);
      }
      break;
    }

    case 's': {
      const id = args[0];
      if (!id) { console.log('Usage: forge status <id>'); process.exit(1); }
      const task = await api(`/api/tasks/${id}`);
      console.log(`Task: ${task.id}`);
      console.log(`Project: ${task.projectName} (${task.projectPath})`);
      console.log(`Status: ${task.status}`);
      console.log(`Prompt: ${task.prompt}`);
      if (task.startedAt) console.log(`Started: ${task.startedAt}`);
      if (task.completedAt) console.log(`Completed: ${task.completedAt}`);
      if (task.costUSD != null) console.log(`Cost: $${task.costUSD.toFixed(4)}`);
      if (task.error) console.log(`Error: ${task.error}`);
      if (task.resultSummary) {
        console.log(`\nResult:\n${task.resultSummary}`);
      }
      if (task.gitDiff) {
        console.log(`\nGit Diff:\n${task.gitDiff.slice(0, 2000)}`);
      }
      break;
    }

    case 'log':
    case 'l': {
      const id = args[0];
      if (!id) { console.log('Usage: mw log <id>'); process.exit(1); }
      const task = await api(`/api/tasks/${id}`);
      if (task.log.length === 0) {
        console.log('No log entries.');
        break;
      }
      for (const entry of task.log) {
        const prefix = entry.subtype === 'tool_use' ? `🔧 [${entry.tool}]`
          : entry.subtype === 'error' ? '❗'
          : entry.type === 'result' ? '✅'
          : entry.subtype === 'tool_result' ? '  ↳'
          : '  ';
        console.log(`${prefix} ${entry.content.slice(0, 300)}`);
      }
      break;
    }

    case 'watch':
    case 'w': {
      const id = args[0];
      if (!id) { console.log('Usage: mw watch <id>'); process.exit(1); }
      console.log(`Watching task ${id}... (Ctrl+C to stop)\n`);

      const res = await fetch(`${BASE}/api/tasks/${id}/stream`);
      if (!res.ok || !res.body) {
        console.error('Failed to connect to stream');
        process.exit(1);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const data = JSON.parse(line.slice(6));
            if (data.type === 'log') {
              const e = data.entry;
              if (e.subtype === 'tool_use') {
                console.log(`🔧 [${e.tool}] ${e.content.slice(0, 200)}`);
              } else if (e.subtype === 'text') {
                process.stdout.write(e.content);
              } else if (e.type === 'result') {
                console.log(`\n✅ ${e.content}`);
              } else if (e.subtype === 'error') {
                console.log(`❗ ${e.content}`);
              }
            } else if (data.type === 'status') {
              if (data.status === 'done') {
                console.log('\n✅ Task completed');
              } else if (data.status === 'failed') {
                console.log('\n❌ Task failed');
              } else if (data.status === 'running') {
                console.log('🚀 Started...\n');
              }
            } else if (data.type === 'complete') {
              if (data.task?.costUSD != null) {
                console.log(`Cost: $${data.task.costUSD.toFixed(4)}`);
              }
              process.exit(0);
            }
          } catch {}
        }
      }
      break;
    }

    case 'cancel': {
      const id = args[0];
      if (!id) { console.log('Usage: mw cancel <id>'); process.exit(1); }
      await api(`/api/tasks/${id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'cancel' }),
      });
      console.log(`✓ Task ${id} cancelled`);
      break;
    }

    case 'retry': {
      const id = args[0];
      if (!id) { console.log('Usage: mw retry <id>'); process.exit(1); }
      const task = await api(`/api/tasks/${id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'retry' }),
      });
      console.log(`✓ Retrying as task ${task.id}`);
      break;
    }

    case 'flows':
    case 'f': {
      const flows = await api('/api/flows');
      if (flows.length === 0) {
        console.log('No flows defined.');
        console.log(`Create flows in ~/.forge/flows/*.yaml`);
        break;
      }
      for (const f of flows) {
        const schedule = f.schedule ? ` (${f.schedule})` : '';
        console.log(`  ${f.name}${schedule} — ${f.steps.length} steps`);
      }
      break;
    }

    case 'session': {
      const subCmd = args[0];

      // mw session link <project> <session-id> — register a local CLI session
      if (subCmd === 'link') {
        const project = args[1];
        const sessionId = args[2];
        if (!project || !sessionId) {
          console.log('Usage: mw session link <project> <session-id>');
          console.log('\nFind your session ID:');
          console.log('  In Claude Code CLI, look for the session ID in the output');
          console.log('  Or check: ls ~/.claude/projects/');
          process.exit(1);
        }
        const result = await api('/api/tasks/link', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectName: project, conversationId: sessionId }),
        });
        console.log(`✓ Linked session ${sessionId} to project ${result.projectName}`);
        console.log(`  Future "mw task ${result.projectName} ..." will continue this session`);
        break;
      }

      // mw session (no args) — list all project sessions
      if (!subCmd) {
        const tasks = await api('/api/tasks?status=done');
        const sessions = new Map<string, { id: string; project: string; path: string; lastUsed: string }>();
        for (const t of tasks) {
          if (t.conversationId && !sessions.has(t.projectName)) {
            sessions.set(t.projectName, {
              id: t.conversationId,
              project: t.projectName,
              path: t.projectPath,
              lastUsed: t.completedAt,
            });
          }
        }
        if (sessions.size === 0) {
          console.log('No active sessions. Submit a task first, or link a local session:');
          console.log('  mw session link <project> <session-id>');
          break;
        }
        console.log('Project sessions:\n');
        for (const [name, s] of sessions) {
          console.log(`  ${name.padEnd(25)} ${s.id}`);
          console.log(`  ${''.padEnd(25)} cd ${s.path} && claude --resume ${s.id}`);
          console.log();
        }
        break;
      }

      // mw session <project> — get session for specific project
      const project = subCmd;
      const tasks = await api('/api/tasks?status=done');
      const match = tasks.find((t: any) => t.projectName === project && t.conversationId);
      if (!match) {
        console.log(`No session found for project: ${project}`);
        console.log(`\nLink a local session: mw session link ${project} <session-id>`);
        break;
      }
      console.log(`Project: ${match.projectName}`);
      console.log(`Session: ${match.conversationId}`);
      console.log(`Path:    ${match.projectPath}`);
      console.log(`\nResume in CLI:`);
      console.log(`  cd ${match.projectPath} && claude --resume ${match.conversationId}`);
      break;
    }

    case 'tunnel_code':
    case 'tcode': {
      const { readFileSync, existsSync } = await import('node:fs');
      const { join } = await import('node:path');
      const { getDataDir: _gdd } = await import('../lib/dirs');
      const dataDir = _gdd();
      const codeFile = join(dataDir, 'session-code.json');
      try {
        if (existsSync(codeFile)) {
          const data = JSON.parse(readFileSync(codeFile, 'utf-8'));
          if (data.code) {
            console.log(`Session code: ${data.code}`);
          } else {
            console.log('No session code. Start tunnel first.');
          }
        } else {
          console.log('No session code. Start tunnel first.');
        }
      } catch {}
      // Also show tunnel URL if running
      try {
        const tunnelState = JSON.parse(readFileSync(join(dataDir, 'tunnel-state.json'), 'utf-8'));
        if (tunnelState.url) console.log(`Tunnel URL: ${tunnelState.url}`);
      } catch {}
      break;
    }

    case 'projects':
    case 'p': {
      const projects = await api('/api/projects');
      for (const p of projects) {
        const lang = p.language ? `[${p.language}]` : '';
        console.log(`  ${p.name.padEnd(25)} ${lang.padEnd(6)} ${p.path}`);
      }
      console.log(`\n${projects.length} projects`);
      break;
    }

    case 'server': {
      // Delegate to forge-server.mjs
      const { execSync } = await import('node:child_process');
      const { join, dirname } = await import('node:path');
      const { fileURLToPath } = await import('node:url');
      const serverScript = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'forge-server.mjs');
      const sub = args[0] || 'start';
      const serverArgs = args.slice(1);

      const flagMap: Record<string, string[]> = {
        'start': [],
        'stop': ['--stop'],
        'restart': ['--restart'],
        'rebuild': ['--rebuild'],
        'dev': ['--dev'],
      };

      const flags = flagMap[sub] || [];
      const allArgs = [...flags, ...serverArgs];

      try {
        execSync(`node ${serverScript} ${allArgs.join(' ')}`, { stdio: 'inherit' });
      } catch {}
      break;
    }

    case 'status': {
      // If arg provided, show task details
      if (args[0]) {
        const task = await api(`/api/tasks/${args[0]}`);
        console.log(`Task: ${task.id}`);
        console.log(`Project: ${task.projectName} (${task.projectPath})`);
        console.log(`Status: ${task.status}`);
        console.log(`Prompt: ${task.prompt}`);
        if (task.startedAt) console.log(`Started: ${task.startedAt}`);
        if (task.completedAt) console.log(`Completed: ${task.completedAt}`);
        if (task.costUSD != null) console.log(`Cost: $${task.costUSD.toFixed(4)}`);
        if (task.error) console.log(`Error: ${task.error}`);
        if (task.resultSummary) console.log(`\nResult:\n${task.resultSummary}`);
        if (task.gitDiff) console.log(`\nGit Diff:\n${task.gitDiff.slice(0, 2000)}`);
        break;
      }

      // No arg — show process status
      const { execSync } = await import('node:child_process');

      const check = (pattern: string) => {
        try {
          const out = execSync(`ps aux | grep '${pattern}' | grep -v grep | head -1`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
          return out ? out.split(/\s+/)[1] : null;
        } catch { return null; }
      };

      const nextPid = check('next-server');
      const termPid = check('terminal-standalone');
      const telePid = check('telegram-standalone');
      const tunnPid = check('cloudflared tunnel');

      console.log('');
      console.log(`  ${nextPid ? '●' : '○'} Next.js        ${nextPid ? `running (pid: ${nextPid})` : 'stopped'}`);
      console.log(`  ${termPid ? '●' : '○'} Terminal       ${termPid ? `running (pid: ${termPid})` : 'stopped'}`);
      console.log(`  ${telePid ? '●' : '○'} Telegram       ${telePid ? `running (pid: ${telePid})` : 'stopped'}`);
      console.log(`  ${tunnPid ? '●' : '○'} Tunnel         ${tunnPid ? `running (pid: ${tunnPid})` : 'stopped'}`);

      try {
        const { execSync: ex } = await import('node:child_process');
        const sessions = ex("tmux list-sessions -F '#{session_name} #{session_attached}' 2>/dev/null", { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] })
          .trim().split('\n').filter(l => l.startsWith('mw-'));
        console.log(`\n  Sessions: ${sessions.length}`);
        for (const s of sessions) {
          const [name, att] = s.split(' ');
          console.log(`    ${att !== '0' ? '●' : '○'} ${name}`);
        }
      } catch {
        console.log('\n  Sessions: 0');
      }
      console.log('');
      break;
    }

    case 'upgrade': {
      const { execSync } = await import('node:child_process');
      const { lstatSync } = await import('node:fs');
      const { join, dirname } = await import('node:path');
      const { fileURLToPath } = await import('node:url');

      // Check if installed via npm link (symlink)
      const cliDir = dirname(fileURLToPath(import.meta.url));
      let isLinked = false;
      try { isLinked = lstatSync(join(cliDir, '..')).isSymbolicLink(); } catch {}

      if (isLinked) {
        console.log('[forge] Installed via npm link (local source)');
        console.log('[forge] Pull latest and rebuild:');
        console.log('  cd ' + join(cliDir, '..'));
        console.log('  git pull && pnpm install && pnpm build');
      } else {
        console.log('[forge] Upgrading from npm...');
        try {
          const { homedir } = await import('node:os');
          execSync('npm install -g @aion0/forge@latest --prefer-online', {
            stdio: 'inherit',
            cwd: homedir(),
          });
          // Show installed version
          try {
            const { readFileSync } = await import('node:fs');
            const globalRoot = execSync('npm root -g', { encoding: 'utf-8', cwd: homedir() }).trim();
            const pkg = JSON.parse(readFileSync(join(globalRoot, '@aion0', 'forge', 'package.json'), 'utf-8'));
            console.log(`[forge] Upgraded to v${pkg.version}. Run: forge server restart`);
          } catch {
            console.log('[forge] Upgraded. Run: forge server restart');
          }
        } catch {
          console.log('[forge] Upgrade failed');
        }
      }
      break;
    }

    case 'uninstall': {
      const { execSync } = await import('node:child_process');
      console.log('[forge] Stopping server...');
      try { execSync('forge server stop', { stdio: 'inherit' }); } catch {}
      console.log('[forge] Uninstalling...');
      try {
        execSync('npm uninstall -g @aion0/forge', { stdio: 'inherit' });
        console.log('[forge] Uninstalled. Data remains in ~/.forge/');
      } catch {
        console.log('[forge] Uninstall failed');
      }
      break;
    }

    default:
      console.log(`forge — Forge CLI (@aion0/forge)

Usage:
  forge server start [options]   Start server (default: foreground)
  forge server stop              Stop server
  forge server restart           Restart server (safe for remote)
  forge server dev               Start in dev mode
  forge server rebuild           Force rebuild

  forge task <project> <prompt>  Submit a task
  forge tasks [status]           List tasks
  forge watch <id>               Live stream output
  forge status [<id>]            Process status / task details
  forge log <id>                 Show execution log
  forge cancel <id>              Cancel a task
  forge retry <id>               Retry a failed task

  forge run <flow>               Run a workflow
  forge flows                    List workflows
  forge projects                 List projects
  forge session [project]        Show session info
  forge password                 Show login password

  forge upgrade                  Update to latest version
  forge uninstall                Remove forge

Options for 'forge server start':
  --port 4000                    Custom web port (default: 3000)
  --terminal-port 4001           Custom terminal port (default: 3001)
  --dir ~/.forge-staging         Custom data directory
  --background                   Run in background
  --reset-terminal               Kill terminal server on start

Shortcuts: t=task, ls=tasks, w=watch, s=status, l=log, f=flows, p=projects, pw=password`);
  }
}

const skipUpdateCheck = ['upgrade', 'uninstall', '--version', '-v', '--reset-password'];
main().then(() => { if (!skipUpdateCheck.includes(cmd)) return checkForUpdate(); }).catch(err => {
  console.error(err.message);
  process.exit(1);
});
