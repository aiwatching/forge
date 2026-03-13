#!/usr/bin/env npx tsx
/**
 * Standalone terminal WebSocket server with tmux-backed persistent sessions.
 * Sessions survive browser close and app restart.
 *
 * Protocol:
 *   Client → Server:
 *     { type: 'create', cols, rows }           — create new tmux session
 *     { type: 'attach', sessionName, cols, rows } — attach to existing
 *     { type: 'list' }                         — list all mw-* sessions
 *     { type: 'input', data }                  — stdin
 *     { type: 'resize', cols, rows }           — resize
 *     { type: 'kill', sessionName }            — kill a session
 *
 *   Server → Client:
 *     { type: 'sessions', sessions: [{name, created, attached, windows}] }
 *     { type: 'connected', sessionName }
 *     { type: 'output', data }
 *     { type: 'exit', code }
 *
 * Usage: npx tsx lib/terminal-standalone.ts
 */

import { WebSocketServer, WebSocket } from 'ws';
import * as pty from 'node-pty';
import { execSync } from 'node:child_process';
import { homedir } from 'node:os';

const PORT = Number(process.env.TERMINAL_PORT) || 3001;
const SESSION_PREFIX = 'mw-';

// Remove CLAUDECODE env so Claude Code can run inside terminal sessions
delete process.env.CLAUDECODE;

// ─── tmux helpers ──────────────────────────────────────────────

function tmuxBin(): string {
  try {
    return execSync('which tmux', { encoding: 'utf-8' }).trim();
  } catch {
    return 'tmux';
  }
}

const TMUX = tmuxBin();

function listTmuxSessions(): { name: string; created: string; attached: boolean; windows: number }[] {
  try {
    const out = execSync(
      `${TMUX} list-sessions -F "#{session_name}||#{session_created}||#{session_attached}||#{session_windows}" 2>/dev/null`,
      { encoding: 'utf-8' }
    );
    return out
      .trim()
      .split('\n')
      .filter(line => line.startsWith(SESSION_PREFIX))
      .map(line => {
        const [name, created, attached, windows] = line.split('||');
        return {
          name,
          created: new Date(Number(created) * 1000).toISOString(),
          attached: attached !== '0',
          windows: Number(windows) || 1,
        };
      });
  } catch {
    return [];
  }
}

function createTmuxSession(cols: number, rows: number): string {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const name = `${SESSION_PREFIX}${id}`;
  execSync(`${TMUX} new-session -d -s ${name} -x ${cols} -y ${rows}`, {
    cwd: homedir(),
    env: { ...process.env, TERM: 'xterm-256color' },
  });
  return name;
}

function killTmuxSession(name: string): boolean {
  if (!name.startsWith(SESSION_PREFIX)) return false;
  try {
    execSync(`${TMUX} kill-session -t ${name} 2>/dev/null`);
    return true;
  } catch {
    return false;
  }
}

function tmuxSessionExists(name: string): boolean {
  try {
    execSync(`${TMUX} has-session -t ${name} 2>/dev/null`);
    return true;
  } catch {
    return false;
  }
}

// ─── WebSocket server ──────────────────────────────────────────

const wss = new WebSocketServer({ port: PORT });
console.log(`[terminal] WebSocket server on ws://0.0.0.0:${PORT} (tmux-backed)`);

wss.on('connection', (ws: WebSocket) => {
  let term: pty.IPty | null = null;
  let sessionName: string | null = null;

  function attachToTmux(name: string, cols: number, rows: number) {
    if (!tmuxSessionExists(name)) {
      ws.send(JSON.stringify({ type: 'output', data: `\r\n\x1b[91mSession "${name}" no longer exists\x1b[0m\r\n` }));
      ws.send(JSON.stringify({ type: 'exit', code: 1 }));
      return;
    }

    sessionName = name;

    // Attach to tmux session via pty
    term = pty.spawn(TMUX, ['attach-session', '-t', name], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: homedir(),
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
      } as Record<string, string>,
    });

    console.log(`[terminal] Attached to tmux session "${name}" (pid: ${term.pid})`);
    ws.send(JSON.stringify({ type: 'connected', sessionName: name }));

    term.onData((data: string) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'output', data }));
      }
    });

    term.onExit(({ exitCode }) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'exit', code: exitCode }));
      }
      term = null;
    });
  }

  ws.on('message', (msg: Buffer) => {
    try {
      const parsed = JSON.parse(msg.toString());

      switch (parsed.type) {
        case 'list': {
          const sessions = listTmuxSessions();
          ws.send(JSON.stringify({ type: 'sessions', sessions }));
          break;
        }

        case 'create': {
          const cols = parsed.cols || 120;
          const rows = parsed.rows || 30;
          const name = createTmuxSession(cols, rows);
          attachToTmux(name, cols, rows);
          break;
        }

        case 'attach': {
          const cols = parsed.cols || 120;
          const rows = parsed.rows || 30;
          attachToTmux(parsed.sessionName, cols, rows);
          break;
        }

        case 'input': {
          if (term) term.write(parsed.data);
          break;
        }

        case 'resize': {
          if (term) term.resize(parsed.cols, parsed.rows);
          break;
        }

        case 'kill': {
          if (parsed.sessionName) {
            killTmuxSession(parsed.sessionName);
            // Refresh list
            ws.send(JSON.stringify({ type: 'sessions', sessions: listTmuxSessions() }));
          }
          break;
        }
      }
    } catch {}
  });

  ws.on('close', () => {
    // Only kill the pty attach process, NOT the tmux session — it persists
    if (term) {
      term.kill();
      console.log(`[terminal] Detached from tmux session "${sessionName}"`);
    }
  });
});
