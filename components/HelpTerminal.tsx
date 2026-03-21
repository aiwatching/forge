'use client';

import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

const SESSION_NAME = 'mw-forge-help';

function getWsUrl() {
  if (typeof window === 'undefined') return `ws://localhost:${parseInt(process.env.TERMINAL_PORT || '3001')}`;
  const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsHost = window.location.hostname;
  if (wsHost !== 'localhost' && wsHost !== '127.0.0.1') {
    return `${wsProtocol}//${window.location.host}/terminal-ws`;
  }
  const webPort = parseInt(window.location.port) || 3000;
  return `${wsProtocol}//${wsHost}:${webPort + 1}`;
}

export default function HelpTerminal() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!containerRef.current) return;

    let disposed = false;
    const cs = getComputedStyle(document.documentElement);
    const tv = (name: string) => cs.getPropertyValue(name).trim();
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 12,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      scrollback: 3000,
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

      socket.onopen = () => {
        if (disposed) { socket.close(); return; }
        socket.send(JSON.stringify({ type: 'attach', sessionName: SESSION_NAME, cols: term.cols, rows: term.rows }));
      };

      socket.onmessage = (event) => {
        if (disposed) return;
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'output') {
            try { term.write(msg.data); } catch {}
          } else if (msg.type === 'connected') {
            setConnected(true);
            if (isNewSession) {
              isNewSession = false;
              setTimeout(() => {
                if (socket.readyState === WebSocket.OPEN) {
                  socket.send(JSON.stringify({ type: 'input', data: `cd ~/.forge/help 2>/dev/null && claude\n` }));
                }
              }, 300);
            }
          } else if (msg.type === 'error') {
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

    const resizeObserver = new ResizeObserver(() => {
      const el = containerRef.current;
      if (!el || el.offsetWidth < 50 || el.offsetHeight < 30) return;
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
      ws?.close();
      resizeObserver.disconnect();
      term.dispose();
    };
  }, []);

  return (
    <div className="h-full flex flex-col">
      <div ref={containerRef} className="flex-1" />
    </div>
  );
}
