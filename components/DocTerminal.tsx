'use client';

import { useState, useEffect, useRef, useCallback} from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

const SESSION_NAME = 'mw-docs-claude';

function getWsUrl() {
  if (typeof window === 'undefined') return `ws://localhost:${parseInt(process.env.TERMINAL_PORT || '8404')}`;
  const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsHost = window.location.hostname;
  if (wsHost !== 'localhost' && wsHost !== '127.0.0.1') {
    return `${wsProtocol}//${window.location.host}/terminal-ws`;
  }
  const webPort = parseInt(window.location.port) || 8403;
  return `${wsProtocol}//${wsHost}:${webPort + 1}`;
}

export default function DocTerminal({ docRoot }: { docRoot: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const docRootRef = useRef(docRoot);
  const skipPermRef = useRef(false);

  useEffect(() => {
    fetch('/api/settings').then(r => r.json())
      .then((s: any) => { if (s.skipPermissions) skipPermRef.current = true; })
      .catch(() => {});
  }, []);
  docRootRef.current = docRoot;

  useEffect(() => {
    if (!containerRef.current) return;

    let disposed = false;
    const cs = getComputedStyle(document.documentElement);
    const tv = (name: string) => cs.getPropertyValue(name).trim();
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      scrollback: 5000,
      logger: { trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      theme: {
        background: tv('--term-bg') || '#1a1a2e',
        foreground: tv('--term-fg') || '#e0e0e0',
        cursor: tv('--term-cursor') || '#7c5bf0',
        selectionBackground: (tv('--term-cursor') || '#7c5bf0') + '44',
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);

    term.open(containerRef.current);
    try { fit.fit(); } catch {}

    const wsUrl = getWsUrl();
    let ws: WebSocket | null = null;
    let reconnectTimer = 0;
    let isNewSession = false;

    function connect() {
      if (disposed) return;
      const socket = new WebSocket(wsUrl);
      ws = socket;
      wsRef.current = socket;

      socket.onopen = () => {
        if (disposed) { socket.close(); return; }
        const cols = term.cols;
        const rows = term.rows;
        socket.send(JSON.stringify({ type: 'attach', sessionName: SESSION_NAME, cols, rows }));
      };

      socket.onmessage = (event) => {
        if (disposed) return;
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'output') {
            try { term.write(msg.data); } catch {};
          } else if (msg.type === 'connected') {
            setConnected(true);
            // For newly created session: cd to doc root and run claude --resume to let user pick
            if (isNewSession && docRootRef.current) {
              isNewSession = false;
              setTimeout(() => {
                if (socket.readyState === WebSocket.OPEN) {
                  const sf = skipPermRef.current ? ' --dangerously-skip-permissions' : '';
                  socket.send(JSON.stringify({ type: 'input', data: `cd "${docRootRef.current}" && claude -c${sf}\n` }));
                }
              }, 300);
            }
          } else if (msg.type === 'error') {
            // Session doesn't exist — create it
            isNewSession = true;
            if (socket.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify({ type: 'create', cols: term.cols, rows: term.rows, sessionName: SESSION_NAME }));
            }
          }
        } catch {}
      };

      socket.onclose = () => {
        if (disposed) return;
        setConnected(false);
        reconnectTimer = window.setTimeout(connect, 3000);
      };

      socket.onerror = () => {};
    }

    connect();

    term.onData((data) => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input', data }));
    });

    // Resize with protection
    const resizeObserver = new ResizeObserver(() => {
      const el = containerRef.current;
      if (!el || el.offsetWidth < 100 || el.offsetHeight < 50) return;
      try {
        fit.fit();
        if (term.cols < 2 || term.rows < 2) return;
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
        }
      } catch {}
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      disposed = true;
      clearTimeout(reconnectTimer);
      resizeObserver.disconnect();
      if (ws) { ws.onclose = null; ws.close(); }
      term.dispose();
    };
  }, []);

  const runCommand = useCallback((cmd: string) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'input', data: cmd + '\n' }));
    }
  }, []);

  return (
    <div className="h-full flex flex-col bg-[#1a1a2e]">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-2 py-1 border-b border-[#2a2a4a] shrink-0">
        <span className="text-[9px] text-gray-500">Claude Console</span>
        <span className={`text-[9px] ${connected ? 'text-green-500' : 'text-gray-600'}`}>
          {connected ? '● connected' : '○'}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={() => { const sf = skipPermRef.current ? ' --dangerously-skip-permissions' : ''; runCommand(`cd "${docRoot}" && claude${sf}`); }}
            className="text-[10px] px-2 py-0.5 text-[var(--accent)] hover:bg-[#2a2a4a] rounded"
          >
            New
          </button>
          <button
            onClick={() => { const sf = skipPermRef.current ? ' --dangerously-skip-permissions' : ''; runCommand(`cd "${docRoot}" && claude -c${sf}`); }}
            className="text-[10px] px-2 py-0.5 text-gray-400 hover:text-white hover:bg-[#2a2a4a] rounded"
          >
            Resume
          </button>
        </div>
      </div>

      {/* Terminal */}
      <div ref={containerRef} className="flex-1 min-h-0" />
    </div>
  );
}
