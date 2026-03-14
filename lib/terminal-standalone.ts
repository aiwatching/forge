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
 *     { type: 'load-state' }                   — load shared terminal state
 *     { type: 'save-state', data }             — save shared terminal state
 *
 *   Server → Client:
 *     { type: 'sessions', sessions: [{name, created, attached, windows}] }
 *     { type: 'connected', sessionName }
 *     { type: 'output', data }
 *     { type: 'exit', code }
 *     { type: 'terminal-state', data }         — loaded state (or null)
 *
 * Usage: npx tsx lib/terminal-standalone.ts
 */

import { WebSocketServer, WebSocket } from 'ws';
import * as pty from 'node-pty';
import { execSync } from 'node:child_process';
import { homedir } from 'node:os';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const PORT = Number(process.env.TERMINAL_PORT) || 3001;
const SESSION_PREFIX = 'mw-';

// Remove CLAUDECODE env so Claude Code can run inside terminal sessions
delete process.env.CLAUDECODE;

// ─── Shared state persistence ─────────────────────────────────

const STATE_DIR = join(homedir(), '.forge');
const STATE_FILE = join(STATE_DIR, 'terminal-state.json');

function loadTerminalState(): unknown {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
  } catch {
    return null;
  }
}

function saveTerminalState(data: unknown): void {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('[terminal] Failed to save state:', e);
  }
}

/** Get session names that have custom labels (user-renamed) */
function getRenamedSessions(): Set<string> {
  try {
    const state = loadTerminalState() as any;
    if (!state?.sessionLabels) return new Set();
    // sessionLabels: { "mw-xxx": "My Custom Name", ... }
    // A session is "renamed" if its label differs from default patterns
    const renamed = new Set<string>();
    for (const [sessionName, label] of Object.entries(state.sessionLabels)) {
      if (label && typeof label === 'string') {
        renamed.add(sessionName);
      }
    }
    return renamed;
  } catch {
    return new Set();
  }
}

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

const MAX_SESSIONS = 10;

function createTmuxSession(cols: number, rows: number): string {
  // Auto-cleanup: if too many sessions, kill the oldest idle ones
  const existing = listTmuxSessions();
  if (existing.length >= MAX_SESSIONS) {
    const idle = existing.filter(s => !s.attached);
    // Kill oldest idle sessions to make room
    const toKill = idle.slice(0, Math.max(1, idle.length - Math.floor(MAX_SESSIONS / 2)));
    for (const s of toKill) {
      console.log(`[terminal] Auto-cleanup: killing idle session "${s.name}"`);
      killTmuxSession(s.name);
    }
  }

  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const name = `${SESSION_PREFIX}${id}`;
  execSync(`${TMUX} new-session -d -s ${name} -x ${cols} -y ${rows}`, {
    cwd: homedir(),
    env: { ...process.env, TERM: 'xterm-256color' },
  });
  // Enable mouse scrolling and set large scrollback buffer
  try {
    execSync(`${TMUX} set-option -t ${name} mouse on 2>/dev/null`);
    execSync(`${TMUX} set-option -t ${name} history-limit 50000 2>/dev/null`);
  } catch {}
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

// ─── Connection tracking (for orphan cleanup) ──────────────────

/** Map from tmux session name → Set of WebSocket clients attached to it */
const sessionClients = new Map<string, Set<WebSocket>>();

/** Map from WebSocket → timestamp when the session was *created* (not attached) by this client */
const createdAt = new Map<WebSocket, { session: string; time: number }>();

function trackAttach(ws: WebSocket, sessionName: string) {
  if (!sessionClients.has(sessionName)) sessionClients.set(sessionName, new Set());
  sessionClients.get(sessionName)!.add(ws);
}

function trackDetach(ws: WebSocket, sessionName: string) {
  sessionClients.get(sessionName)?.delete(ws);
  if (sessionClients.get(sessionName)?.size === 0) sessionClients.delete(sessionName);
}

// ─── Periodic orphan cleanup ─────────────────────────────────

/** Clean up detached tmux sessions that no WS client is connected to (skip renamed ones) */
function cleanupOrphanedSessions() {
  const renamed = getRenamedSessions();
  const sessions = listTmuxSessions();
  for (const s of sessions) {
    if (s.attached) continue;
    if (renamed.has(s.name)) continue; // user renamed — preserve
    const clients = sessionClients.get(s.name)?.size ?? 0;
    if (clients === 0) {
      console.log(`[terminal] Cleanup: killing orphaned session "${s.name}" (no clients, not renamed)`);
      killTmuxSession(s.name);
    }
  }
}

// Run cleanup every 30 seconds
setInterval(cleanupOrphanedSessions, 30_000);

// ─── WebSocket server ──────────────────────────────────────────

const wss = new WebSocketServer({ port: PORT });
console.log(`[terminal] WebSocket server on ws://0.0.0.0:${PORT} (tmux-backed)`);

wss.on('connection', (ws: WebSocket) => {
  let term: pty.IPty | null = null;
  let sessionName: string | null = null;

  function attachToTmux(name: string, cols: number, rows: number) {
    if (!tmuxSessionExists(name)) {
      ws.send(JSON.stringify({ type: 'error', message: `session "${name}" no longer exists` }));
      return;
    }

    // Kill previous pty process before attaching to new session (prevents PTY leak)
    if (term) {
      try { term.kill(); } catch {}
      term = null;
    }

    // Ensure mouse and scrollback are enabled (for old sessions too)
    try {
      execSync(`${TMUX} set-option -t ${name} mouse on 2>/dev/null`);
      execSync(`${TMUX} set-option -t ${name} history-limit 50000 2>/dev/null`);
    } catch {}

    // Detach from previous session if switching
    if (sessionName) trackDetach(ws, sessionName);
    sessionName = name;
    trackAttach(ws, name);

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

    // Attached to tmux session (silent)
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
          try {
            const name = createTmuxSession(cols, rows);
            createdAt.set(ws, { session: name, time: Date.now() });
            attachToTmux(name, cols, rows);
          } catch (e: unknown) {
            const errMsg = e instanceof Error ? e.message : 'unknown error';
            console.error(`[terminal] Failed to create tmux session:`, errMsg);
            ws.send(JSON.stringify({ type: 'error', message: `failed to create session: ${errMsg}` }));
          }
          break;
        }

        case 'attach': {
          const cols = parsed.cols || 120;
          const rows = parsed.rows || 30;
          try {
            attachToTmux(parsed.sessionName, cols, rows);
          } catch (e: unknown) {
            const errMsg = e instanceof Error ? e.message : 'unknown error';
            console.error(`[terminal] Failed to attach to session:`, errMsg);
            ws.send(JSON.stringify({ type: 'error', message: `failed to attach: ${errMsg}` }));
          }
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
            ws.send(JSON.stringify({ type: 'sessions', sessions: listTmuxSessions() }));
          }
          break;
        }

        case 'load-state': {
          const state = loadTerminalState();
          ws.send(JSON.stringify({ type: 'terminal-state', data: state }));
          break;
        }

        case 'save-state': {
          if (parsed.data) {
            saveTerminalState(parsed.data);
          }
          break;
        }
      }
    } catch (e) {
      console.error('[terminal] Error handling message:', e);
      try {
        ws.send(JSON.stringify({ type: 'error', message: 'internal server error' }));
      } catch {}
    }
  });

  ws.on('close', () => {
    // Only kill the pty attach process, NOT the tmux session — it persists
    if (term) {
      term.kill();
      // Detached from tmux session (silent)
    }

    // Untrack this client
    const disconnectedSession = sessionName;
    if (sessionName) trackDetach(ws, sessionName);
    createdAt.delete(ws);

    // Grace period cleanup: if no client reconnects within 10s, kill the session (unless renamed)
    if (disconnectedSession) {
      setTimeout(() => {
        const clients = sessionClients.get(disconnectedSession)?.size ?? 0;
        if (clients === 0 && tmuxSessionExists(disconnectedSession)) {
          const renamed = getRenamedSessions();
          if (!renamed.has(disconnectedSession)) {
            console.log(`[terminal] Auto-killing orphaned session "${disconnectedSession}" (no clients after 10s, not renamed)`);
            killTmuxSession(disconnectedSession);
          }
        }
      }, 10_000);
    }
  });
});
