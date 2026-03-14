'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

const SESSION_NAME = 'mw-docs-claude';

function getWsUrl() {
  if (typeof window === 'undefined') return 'ws://localhost:3001';
  const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsHost = window.location.hostname;
  if (wsHost !== 'localhost' && wsHost !== '127.0.0.1') {
    return `${wsProtocol}//${window.location.host}/terminal-ws`;
  }
  return `${wsProtocol}//${wsHost}:3001`;
}

interface ClaudeSession {
  sessionId: string;
  summary?: string;
  firstPrompt?: string;
}

export default function DocTerminal({ docRoot }: { docRoot: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [connected, setConnected] = useState(false);
  const [sessions, setSessions] = useState<ClaudeSession[]>([]);
  const [showPicker, setShowPicker] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const termRef = useRef<Terminal | null>(null);

  // Fetch Claude sessions for the doc root
  const fetchSessions = useCallback(async () => {
    try {
      const name = docRoot.split('/').pop() || docRoot;
      const res = await fetch(`/api/claude-sessions/${encodeURIComponent(name)}`);
      if (res.ok) {
        const data = await res.json();
        setSessions(data);
      }
    } catch {}
  }, [docRoot]);

  useEffect(() => { fetchSessions(); }, [fetchSessions]);

  useEffect(() => {
    if (!containerRef.current) return;

    let disposed = false;
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      scrollback: 5000,
      logger: { trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      theme: {
        background: '#1a1a2e',
        foreground: '#e0e0e0',
        cursor: '#7c5bf0',
        selectionBackground: '#7c5bf066',
      },
    });
    termRef.current = term;

    const fit = new FitAddon();
    term.loadAddon(fit);

    term.open(containerRef.current);
    try { fit.fit(); } catch {}

    const wsUrl = getWsUrl();
    let ws: WebSocket | null = null;
    let reconnectTimer = 0;

    function connect() {
      if (disposed) return;
      const socket = new WebSocket(wsUrl);
      ws = socket;
      wsRef.current = socket;

      socket.onopen = () => {
        if (disposed) { socket.close(); return; }
        const cols = term.cols;
        const rows = term.rows;
        // Always attach to the dedicated docs session
        socket.send(JSON.stringify({ type: 'attach', sessionName: SESSION_NAME, cols, rows }));
      };

      socket.onmessage = (event) => {
        if (disposed) return;
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'output') {
            term.write(msg.data);
          } else if (msg.type === 'connected') {
            setConnected(true);
          } else if (msg.type === 'error') {
            // Session doesn't exist yet — create it
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

    // Resize
    const resizeObserver = new ResizeObserver(() => {
      try {
        fit.fit();
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

  const startClaude = useCallback((sessionId?: string) => {
    const cmd = sessionId
      ? `cd "${docRoot}" && claude --resume ${sessionId}`
      : `cd "${docRoot}" && claude`;
    runCommand(cmd);
    setShowPicker(false);
  }, [docRoot, runCommand]);

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
            onClick={() => startClaude()}
            className="text-[10px] px-2 py-0.5 text-[var(--accent)] hover:bg-[#2a2a4a] rounded"
          >
            New Claude
          </button>
          <button
            onClick={() => { fetchSessions(); setShowPicker(v => !v); }}
            className={`text-[10px] px-2 py-0.5 rounded ${showPicker ? 'text-white bg-[#7c5bf0]/30' : 'text-gray-400 hover:bg-[#2a2a4a]'}`}
          >
            Resume
          </button>
        </div>
      </div>

      {/* Session picker */}
      {showPicker && (
        <div className="border-b border-[#2a2a4a] bg-[#12122a] max-h-40 overflow-y-auto">
          {sessions.length === 0 ? (
            <div className="text-[10px] text-gray-500 p-2">No previous sessions</div>
          ) : (
            sessions.map(s => (
              <button
                key={s.sessionId}
                onClick={() => startClaude(s.sessionId)}
                className="w-full text-left px-3 py-1.5 hover:bg-[#2a2a4a] text-xs border-b border-[#2a2a4a]/50"
              >
                <span className="font-mono text-[var(--accent)]">{s.sessionId.slice(0, 12)}</span>
                {s.firstPrompt && (
                  <span className="text-gray-500 ml-2 truncate">{s.firstPrompt.slice(0, 60)}</span>
                )}
              </button>
            ))
          )}
        </div>
      )}

      {/* Terminal */}
      <div ref={containerRef} className="flex-1 min-h-0" />
    </div>
  );
}
