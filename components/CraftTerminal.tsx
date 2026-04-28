'use client';

// Bottom-panel tmux terminal pinned to one craft. Attaches to the craft's
// session if it exists; otherwise creates it on demand with the chosen agent.

import { useState, useEffect, useRef, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

function getWsUrl() {
  if (typeof window === 'undefined') return `ws://localhost:${parseInt(process.env.TERMINAL_PORT || '8404')}`;
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = window.location.hostname;
  if (host !== 'localhost' && host !== '127.0.0.1') {
    return `${proto}//${window.location.host}/terminal-ws`;
  }
  const webPort = parseInt(window.location.port) || 8403;
  return `${proto}//${host}:${webPort + 1}`;
}

interface AgentSummary { id: string; name?: string; path?: string; }

export interface CraftTerminalProps {
  projectPath: string;
  craftName: string;
  preferredSessionName: string;     // e.g. mw-craft-<hash>-<name>; component will create if missing
  craftDir: string;                 // <project>/.forge/crafts/<name>/
}

export default function CraftTerminal({ projectPath, craftName, preferredSessionName, craftDir }: CraftTerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const [connected, setConnected] = useState(false);
  const [activeSession, setActiveSession] = useState(preferredSessionName);
  const activeSessionRef = useRef(activeSession);
  const [sessions, setSessions] = useState<{ name: string; cwd?: string; attached: boolean }[]>([]);
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [agentId, setAgentId] = useState<string>('');
  const skipPermRef = useRef(true);
  const [showPicker, setShowPicker] = useState(false);

  activeSessionRef.current = activeSession;

  // Load sessions + agents
  const refreshSessions = useCallback(async () => {
    try {
      const r = await fetch(`/api/migration/sessions?projectPath=${encodeURIComponent(projectPath)}`);
      if (!r.ok) return;
      const j = await r.json();
      setSessions([...(j.matches || []), ...(j.others || [])]);
    } catch {}
  }, [projectPath]);

  useEffect(() => { refreshSessions(); }, [refreshSessions]);

  useEffect(() => {
    fetch('/api/agents')
      .then(r => r.ok ? r.json() : { agents: [] })
      .then((res: any) => {
        const list = (res.agents || []).filter((a: any) => a.enabled !== false);
        setAgents(list);
        const def = res.defaultAgent && list.find((a: any) => a.id === res.defaultAgent) ? res.defaultAgent : list[0]?.id || '';
        setAgentId(def);
      });
    fetch('/api/settings').then(r => r.ok ? r.json() : null).then((s: any) => { if (s?.skipPermissions === false) skipPermRef.current = false; });
  }, []);

  // Mount xterm + connect
  useEffect(() => {
    if (!containerRef.current) return;
    let disposed = false;
    let reconnectTimer = 0;

    const cs = getComputedStyle(document.documentElement);
    const tv = (n: string) => cs.getPropertyValue(n).trim();
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 12,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      scrollback: 5000,
      logger: { trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      theme: {
        background: tv('--term-bg') || '#0d1117',
        foreground: tv('--term-fg') || '#e0e0e0',
        cursor: tv('--term-cursor') || '#7c5bf0',
        selectionBackground: (tv('--term-cursor') || '#7c5bf0') + '44',
      },
    });
    termRef.current = term;
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    try { fit.fit(); } catch {}

    function connect() {
      if (disposed) return;
      const ws = new WebSocket(getWsUrl());
      wsRef.current = ws;
      let pendingCreate = false;

      ws.onopen = () => {
        if (disposed) { ws.close(); return; }
        ws.send(JSON.stringify({ type: 'attach', sessionName: activeSessionRef.current, cols: term.cols, rows: term.rows }));
      };
      ws.onmessage = ev => {
        if (disposed) return;
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === 'output') { try { term.write(msg.data); } catch {} }
          else if (msg.type === 'connected') setConnected(true);
          else if (msg.type === 'error') {
            // Session doesn't exist — create it on demand
            if (!pendingCreate) {
              pendingCreate = true;
              ws.send(JSON.stringify({ type: 'create', sessionName: activeSessionRef.current, cols: term.cols, rows: term.rows }));
              // After creation, cd into craft dir and start the chosen agent
              setTimeout(() => {
                if (ws.readyState === WebSocket.OPEN) {
                  const a = agents.find(x => x.id === agentId) || agents[0];
                  const cli = a?.path || a?.id || 'claude';
                  const sf = (a?.id === 'claude' && skipPermRef.current) ? ' --dangerously-skip-permissions' : '';
                  ws.send(JSON.stringify({ type: 'input', data: `cd "${craftDir}" && ${cli}${sf}\n` }));
                }
              }, 400);
            }
          }
        } catch {}
      };
      ws.onclose = () => {
        if (disposed) return;
        setConnected(false);
        reconnectTimer = window.setTimeout(connect, 2000);
      };
    }
    connect();

    term.onData(d => {
      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input', data: d }));
    });

    const ro = new ResizeObserver(() => {
      const el = containerRef.current;
      if (!el || el.offsetWidth < 100 || el.offsetHeight < 50) return;
      try {
        fit.fit();
        if (term.cols < 2 || term.rows < 2) return;
        const ws = wsRef.current;
        if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      } catch {}
    });
    ro.observe(containerRef.current);

    return () => {
      disposed = true;
      clearTimeout(reconnectTimer);
      ro.disconnect();
      const ws = wsRef.current;
      if (ws) { ws.onclose = null; ws.close(); }
      term.dispose();
      termRef.current = null;
      wsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Switch session — close socket and reconnect with new name
  const switchSession = useCallback((name: string) => {
    setActiveSession(name);
    activeSessionRef.current = name;
    setShowPicker(false);
    const ws = wsRef.current;
    if (ws) ws.close();
    // Clear xterm output
    termRef.current?.clear();
  }, []);

  const startNewSession = useCallback(async () => {
    // Create a fresh session pinned to this craft + chosen agent
    const sessionName = `${preferredSessionName}-${Date.now().toString(36).slice(-4)}`;
    switchSession(sessionName);
  }, [preferredSessionName, switchSession]);

  const sendInjectPrompt = useCallback(() => {
    // Re-paste the original prompt.md into the running session
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    fetch(`/api/craft-system/helpers/file?projectPath=${encodeURIComponent(projectPath)}&path=${encodeURIComponent(`.forge/crafts/${craftName}/prompt.md`)}`)
      .then(r => r.ok ? r.text() : '')
      .then(text => {
        if (!text) return;
        ws.send(JSON.stringify({ type: 'input', data: text + '\n' }));
      });
  }, [projectPath, craftName]);

  return (
    <div className="h-full flex flex-col bg-[var(--bg-primary)] border-t border-[var(--border)]">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-2 py-1 border-b border-[var(--border)] shrink-0 bg-[var(--bg-secondary)]/40">
        <span className="text-[10px] text-[var(--text-secondary)]">🖥</span>
        <button onClick={() => { setShowPicker(v => !v); refreshSessions(); }}
          className="text-[10px] px-1.5 py-0.5 rounded font-mono text-[var(--accent)] hover:bg-[var(--accent)]/10"
          title="Switch session">
          {activeSession.replace(/^mw[a-z0-9]*-/, '')} ▾
        </button>
        <span className={`text-[9px] ${connected ? 'text-emerald-400' : 'text-[var(--text-secondary)]'}`}>
          {connected ? '● connected' : '○ disconnected'}
        </span>
        <select value={agentId} onChange={e => setAgentId(e.target.value)}
          className="text-[10px] bg-[var(--bg-tertiary)] border border-[var(--border)] rounded px-1.5 py-0.5"
          title="Agent used when creating a fresh session">
          {agents.length === 0 && <option value="">no agents</option>}
          {agents.map(a => <option key={a.id} value={a.id}>{a.name || a.id}</option>)}
        </select>
        <div className="flex-1" />
        <button onClick={sendInjectPrompt}
          className="text-[10px] px-2 py-0.5 rounded text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--accent)]"
          title="Re-paste the craft's prompt.md into the session">
          📋 prompt
        </button>
        <button onClick={startNewSession}
          className="text-[10px] px-2 py-0.5 rounded text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--accent)]"
          title="Start a fresh tmux session for this craft">
          + Fresh
        </button>
      </div>

      {/* Session picker dropdown */}
      {showPicker && (
        <div className="absolute top-12 left-2 z-30 bg-[var(--bg-primary)] border border-[var(--border)] rounded shadow-xl text-[10px] min-w-[260px] max-h-64 overflow-auto">
          <div className="px-2 py-1 text-[var(--text-secondary)] border-b border-[var(--border)]">All project sessions</div>
          {sessions.length === 0 && <div className="px-2 py-2 text-[var(--text-secondary)]">no sessions</div>}
          {sessions.map(s => (
            <button key={s.name} onClick={() => switchSession(s.name)}
              className={`w-full text-left px-2 py-1 hover:bg-[var(--bg-tertiary)] ${s.name === activeSession ? 'bg-[var(--accent)]/10 text-[var(--accent)]' : ''}`}>
              <div className="font-mono">{s.name.replace(/^mw[a-z0-9]*-/, '')}{s.attached ? ' ●' : ''}</div>
              {s.cwd && <div className="text-[9px] text-[var(--text-secondary)] truncate">{s.cwd}</div>}
            </button>
          ))}
          <button onClick={() => { setShowPicker(false); switchSession(preferredSessionName); }}
            className="w-full text-left px-2 py-1 border-t border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]">
            ↩ back to craft default ({preferredSessionName.replace(/^mw[a-z0-9]*-/, '')})
          </button>
        </div>
      )}

      {/* Terminal */}
      <div ref={containerRef} className="flex-1 min-h-0" />
    </div>
  );
}
