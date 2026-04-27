import * as vscode from 'vscode';
import WebSocket from 'ws';

export interface ForgePtyOptions {
  url: string;             // ws://host:port
  attach?: string;         // existing tmux session name to attach to
  cwd?: string;            // for newly created sessions
  /** Command auto-typed after the new tmux session is connected (e.g. `claude --resume <id>`).
   *  Ignored on attach. */
  launchCommand?: string;
  cols?: number;
  rows?: number;
}

/**
 * VSCode Pseudoterminal that bridges to Forge's terminal WebSocket.
 *
 * Protocol (from lib/terminal-standalone.ts):
 *   client → server: { type: 'attach' | 'create', sessionName?, cols, rows, cwd? }
 *                    { type: 'input', data }
 *                    { type: 'resize', cols, rows }
 *   server → client: { type: 'output', data }
 *                    { type: 'connected', sessionName }
 *                    { type: 'error', message }
 */
export class ForgePty implements vscode.Pseudoterminal {
  private writeEmitter = new vscode.EventEmitter<string>();
  private closeEmitter = new vscode.EventEmitter<number>();
  private ws: WebSocket | null = null;
  private cols = 80;
  private rows = 24;
  private opened = false;

  onDidWrite = this.writeEmitter.event;
  onDidClose = this.closeEmitter.event;

  constructor(private opts: ForgePtyOptions) {
    this.cols = opts.cols || 80;
    this.rows = opts.rows || 24;
  }

  open(initialDimensions: vscode.TerminalDimensions | undefined): void {
    if (initialDimensions) {
      this.cols = initialDimensions.columns;
      this.rows = initialDimensions.rows;
    }
    this.opened = true;
    this.connect();
  }

  close(): void {
    this.opened = false;
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
  }

  handleInput(data: string): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'input', data }));
    }
  }

  setDimensions(dims: vscode.TerminalDimensions): void {
    this.cols = dims.columns;
    this.rows = dims.rows;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'resize', cols: this.cols, rows: this.rows }));
    }
  }

  private connect(): void {
    const ws = new WebSocket(this.opts.url);
    this.ws = ws;

    ws.on('open', () => {
      const msg = this.opts.attach
        ? { type: 'attach', sessionName: this.opts.attach, cols: this.cols, rows: this.rows }
        : { type: 'create', cols: this.cols, rows: this.rows, cwd: this.opts.cwd };
      ws.send(JSON.stringify(msg));
      this.writeEmitter.fire(this.opts.attach
        ? `\x1b[2m[forge] attaching to ${this.opts.attach}…\x1b[0m\r\n`
        : `\x1b[2m[forge] creating new session…\x1b[0m\r\n`);
    });

    ws.on('message', (raw) => {
      try {
        const m = JSON.parse(raw.toString());
        if (m.type === 'output' && typeof m.data === 'string') {
          this.writeEmitter.fire(m.data);
        } else if (m.type === 'error') {
          this.writeEmitter.fire(`\r\n\x1b[31m[forge] ${m.message || 'error'}\x1b[0m\r\n`);
        } else if (m.type === 'connected') {
          // For freshly created sessions, auto-type the launch command (claude --resume ...).
          if (this.opts.launchCommand && !this.opts.attach) {
            // Small delay so the bash prompt is fully ready before we type.
            setTimeout(() => {
              if (this.ws?.readyState === WebSocket.OPEN) {
                this.ws.send(JSON.stringify({ type: 'input', data: this.opts.launchCommand + '\n' }));
              }
            }, 200);
          }
        } else if (m.type === 'sessions') {
          // ignore — list response we didn't ask for
        }
      } catch {
        // ignore non-JSON
      }
    });

    ws.on('close', () => {
      if (this.opened) {
        this.writeEmitter.fire('\r\n\x1b[2m[forge] terminal closed\x1b[0m\r\n');
        this.closeEmitter.fire(0);
      }
    });

    ws.on('error', (err: Error) => {
      this.writeEmitter.fire(`\r\n\x1b[31m[forge] WS error: ${err.message}\x1b[0m\r\n`);
    });
  }
}
