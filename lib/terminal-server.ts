/**
 * Terminal Server — standalone WebSocket PTY server.
 * Runs on port 8404 alongside the Next.js server on 8403.
 */

import { WebSocketServer, WebSocket } from 'ws';
import * as pty from 'node-pty';
import { homedir } from 'node:os';

let wss: WebSocketServer | null = null;

export function startTerminalServer(port = 8404) {
  if (wss) return;

  wss = new WebSocketServer({ port });
  console.log(`[terminal] WebSocket server on ws://localhost:${port}`);

  wss.on('connection', (ws: WebSocket) => {
    const shell = process.env.SHELL || '/bin/zsh';
    const term = pty.spawn(shell, [], {
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
}

export function stopTerminalServer() {
  if (wss) {
    wss.close();
    wss = null;
  }
}
