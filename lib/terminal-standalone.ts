#!/usr/bin/env npx tsx
/**
 * Standalone terminal WebSocket server.
 * Run separately from Next.js to avoid Turbopack/native module conflicts.
 *
 * Usage: npx tsx lib/terminal-standalone.ts
 */

import { WebSocketServer, WebSocket } from 'ws';
import * as pty from 'node-pty';
import { homedir } from 'node:os';

const PORT = Number(process.env.TERMINAL_PORT) || 3001;

const wss = new WebSocketServer({ port: PORT });
console.log(`[terminal] WebSocket server on ws://0.0.0.0:${PORT}`);

wss.on('connection', (ws: WebSocket) => {
  const shell = process.env.SHELL || '/bin/zsh';

  let term: pty.IPty;
  try {
    term = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: homedir(),
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
      } as Record<string, string>,
    });
  } catch (err) {
    console.error('[terminal] Failed to spawn:', err);
    ws.send(JSON.stringify({ type: 'output', data: `\r\nFailed to start shell: ${err}\r\n` }));
    ws.close();
    return;
  }

  console.log(`[terminal] New session (pid: ${term.pid})`);

  term.onData((data: string) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'output', data }));
    }
  });

  term.onExit(({ exitCode }) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'exit', code: exitCode }));
      ws.close();
    }
  });

  ws.on('message', (msg: Buffer) => {
    try {
      const parsed = JSON.parse(msg.toString());
      if (parsed.type === 'input') {
        term.write(parsed.data);
      } else if (parsed.type === 'resize') {
        term.resize(parsed.cols, parsed.rows);
      }
    } catch {}
  });

  ws.on('close', () => {
    term.kill();
    console.log(`[terminal] Session closed (pid: ${term.pid})`);
  });
});
