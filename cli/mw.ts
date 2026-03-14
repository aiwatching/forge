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

    case 'status':
    case 's': {
      const id = args[0];
      if (!id) { console.log('Usage: mw status <id>'); process.exit(1); }
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

    case 'password':
    case 'pw': {
      const { readFileSync } = await import('node:fs');
      const { homedir } = await import('node:os');
      const { join } = await import('node:path');
      const pwFile = join(homedir(), '.forge', 'password.json');
      try {
        const data = JSON.parse(readFileSync(pwFile, 'utf-8'));
        const today = new Date().toISOString().slice(0, 10);
        if (data.date === today) {
          console.log(`Login password: ${data.password}`);
          console.log(`Valid for: ${data.date}`);
        } else {
          console.log(`Password expired (was for ${data.date}). Restart server to generate new one.`);
        }
      } catch {
        console.log('No password file found. Password is set via MW_PASSWORD env var.');
      }
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

    default:
      console.log(`forge — Forge CLI (@aion0/forge)

Usage:
  forge task <project> <prompt>     Submit a task (auto-continues project session)
  forge task <project> <prompt> --new  Force a fresh session
  forge run <flow-name>             Run a YAML workflow
  forge tasks [status]              List tasks (running|queued|done|failed)
  forge watch <id>                  Live stream task output
  forge log <id>                    Show execution log
  forge status <id>                 Task details + result
  forge session [project]           Show session IDs → local claude --resume
  forge session link <project> <id> Link a local CLI session to the web system
  forge cancel <id>                 Cancel a task
  forge retry <id>                  Retry a failed task
  forge flows                       List workflows
  forge projects                    List projects
  forge password                    Show login password

Shortcuts: t=task, r=run, ls=tasks, w=watch, l=log, s=status, f=flows, p=projects, pw=password

Examples:
  forge task accord "Fix the authentication bug in login.ts"
  forge watch abc123
  forge run daily-review
  forge tasks running
  forge session accord              Show session ID, then:
    cd ~/IdeaProjects/accord && claude --resume <session-id>`);
  }
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
