'use client';

import { useState, useEffect, useRef, useCallback, memo } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

// ─── Types ────────────────────────────────────────────────

interface WorkspaceAgent {
  id: string;
  label: string;
  icon: string;
  agentId: string;       // agent CLI: claude, codex, aider
  role: string;          // description (displayed in header, not injected)
  inputPaths: string[];
  outputPaths: string[];
  status: 'idle' | 'running' | 'done';
}

interface AgentPreset {
  id: string;
  label: string;
  icon: string;
  agentId: string;
  role: string;
  inputPaths: string[];
  outputPaths: string[];
}

// ─── Presets ──────────────────────────────────────────────

const AGENT_PRESETS: AgentPreset[] = [
  { id: 'pm', label: 'PM', icon: '📋', agentId: 'claude', role: 'Product Manager — analyze requirements, write PRD', inputPaths: ['docs/'], outputPaths: ['docs/prd/'] },
  { id: 'engineer', label: 'Engineer', icon: '🔨', agentId: 'claude', role: 'Senior Engineer — architecture design, implementation', inputPaths: ['docs/prd/'], outputPaths: ['src/', 'docs/architecture.md'] },
  { id: 'qa', label: 'QA', icon: '🧪', agentId: 'claude', role: 'QA Engineer — test cases, test execution', inputPaths: ['docs/', 'src/'], outputPaths: ['tests/', 'docs/test-plan.md'] },
  { id: 'reviewer', label: 'Reviewer', icon: '🔍', agentId: 'claude', role: 'Code Reviewer — review changes, quality check', inputPaths: ['src/', 'tests/'], outputPaths: ['docs/review.md'] },
];

const COLORS = [
  { border: '#22c55e', bg: '#0a1a0a', accent: '#4ade80' },
  { border: '#3b82f6', bg: '#0a0f1a', accent: '#60a5fa' },
  { border: '#a855f7', bg: '#100a1a', accent: '#c084fc' },
  { border: '#f97316', bg: '#1a100a', accent: '#fb923c' },
  { border: '#ec4899', bg: '#1a0a10', accent: '#f472b6' },
  { border: '#06b6d4', bg: '#0a1a1a', accent: '#22d3ee' },
];

// ─── Terminal WebSocket URL ───────────────────────────────

function getWsUrl() {
  if (typeof window === 'undefined') return 'ws://localhost:8404';
  const p = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const h = window.location.hostname;
  if (h !== 'localhost' && h !== '127.0.0.1') return `${p}//${window.location.host}/terminal-ws`;
  const port = parseInt(window.location.port) || 8403;
  return `${p}//${h}:${port + 1}`;
}

// ─── Agent Terminal Panel ─────────────────────────────────

const AgentPanel = memo(function AgentPanel({ agent, projectPath, colorIdx, onRemove }: {
  agent: WorkspaceAgent;
  projectPath: string;
  colorIdx: number;
  onRemove: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const c = COLORS[colorIdx % COLORS.length];
  const wsRef = useRef<WebSocket | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    let disposed = false;

    // Small delay to ensure container has layout dimensions
    const initTimer = setTimeout(() => {
      if (disposed) return;

      const term = new Terminal({
        cursorBlink: true,
        fontSize: 12,
        fontFamily: 'Menlo, Monaco, "Courier New", monospace',
        scrollback: 5000,
        allowProposedApi: true,
        theme: { background: '#0d1117', foreground: '#c9d1d9', cursor: c.accent },
      });
      termRef.current = term;

      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.open(el);
      term.focus();

      const doFit = () => {
        try {
          fitAddon.fit();
          // Notify ws of new size
          if (wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
          }
        } catch {}
      };
      setTimeout(doFit, 100);
      const ro = new ResizeObserver(doFit);
      ro.observe(el);

      // Connect WebSocket
      const ws = new WebSocket(getWsUrl());
      wsRef.current = ws;

      let isNewSession = false;
      let connectedSession = '';

      ws.onopen = () => {
        isNewSession = true;
        ws.send(JSON.stringify({ type: 'create', cols: term.cols, rows: term.rows }));
      };

      ws.onmessage = (event) => {
        if (disposed) return;
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'output') {
            try { term.write(msg.data); } catch {}
          } else if (msg.type === 'connected') {
            connectedSession = msg.sessionName || '';
            // Terminal session ready — launch agent
            if (isNewSession) {
              isNewSession = false;
              const agentCmd = agent.agentId || 'claude';
              setTimeout(() => {
                if (disposed || ws.readyState !== WebSocket.OPEN) return;
                ws.send(JSON.stringify({ type: 'input', data: `cd "${projectPath}" && ${agentCmd}\n` }));
              }, 500);
            }
            // Force terminal redraw
            setTimeout(() => {
              if (disposed || ws.readyState !== WebSocket.OPEN) return;
              ws.send(JSON.stringify({ type: 'resize', cols: term.cols - 1, rows: term.rows }));
              setTimeout(() => {
                if (disposed || ws.readyState !== WebSocket.OPEN) return;
                ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
              }, 50);
            }, 200);
          } else if (msg.type === 'error') {
            if (msg.message?.includes('no longer exists')) {
              isNewSession = true;
              ws.send(JSON.stringify({ type: 'create', cols: term.cols, rows: term.rows }));
            } else {
              term.write(`\r\n\x1b[93m[${msg.message || 'error'}]\x1b[0m\r\n`);
            }
          }
        } catch {}
      };

      ws.onclose = () => {
        if (disposed) return;
        term.write('\r\n\x1b[90m[disconnected — reconnecting...]\x1b[0m\r\n');
        // Auto-reconnect after 2s
        setTimeout(() => {
          if (disposed) return;
          const ws2 = new WebSocket(getWsUrl());
          wsRef.current = ws2;
          ws2.onopen = () => {
            if (connectedSession) {
              ws2.send(JSON.stringify({ type: 'attach', sessionName: connectedSession, cols: term.cols, rows: term.rows }));
            } else {
              isNewSession = true;
              ws2.send(JSON.stringify({ type: 'create', cols: term.cols, rows: term.rows }));
            }
          };
          ws2.onmessage = ws.onmessage;
          ws2.onclose = ws.onclose;
          term.onData((data) => {
            if (ws2.readyState === WebSocket.OPEN) ws2.send(JSON.stringify({ type: 'input', data }));
          });
          term.onResize(({ cols, rows }) => {
            if (ws2.readyState === WebSocket.OPEN) ws2.send(JSON.stringify({ type: 'resize', cols, rows }));
          });
        }, 2000);
      };

      // Forward user input to tmux
      term.onData((data) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input', data }));
      });

      term.onResize(({ cols, rows }) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resize', cols, rows }));
      });

      // Store cleanup refs
      cleanupRef.current = () => {
        disposed = true;
        ro.disconnect();
        ws.close();
        term.dispose();
      };
    }, 50);

    return () => {
      disposed = true;
      clearTimeout(initTimer);
      cleanupRef.current?.();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex flex-col min-h-0 rounded-lg overflow-hidden" style={{ border: `1px solid ${c.border}40` }}>
      {/* Header */}
      <div className="flex items-center gap-2 px-2 py-1 shrink-0" style={{ background: c.bg, borderBottom: `1px solid ${c.border}30` }}>
        <div className="flex gap-1">
          <span className="w-2 h-2 rounded-full bg-red-500/70" />
          <span className="w-2 h-2 rounded-full bg-yellow-500/70" />
          <span className="w-2 h-2 rounded-full bg-green-500/70" />
        </div>
        <span className="text-[10px]">{agent.icon}</span>
        <span className="text-[10px] font-bold text-white">{agent.label}</span>
        <span className="text-[7px] px-1 py-0.5 rounded" style={{ background: c.accent + '20', color: c.accent }}>{agent.agentId}</span>
        <span className="text-[7px] text-gray-500 truncate flex-1">{agent.role}</span>
        {agent.inputPaths.length > 0 && (
          <span className="text-[6px] text-gray-600">⬇{agent.inputPaths.join(',')}</span>
        )}
        {agent.outputPaths.length > 0 && (
          <span className="text-[6px] text-gray-600">⬆{agent.outputPaths.join(',')}</span>
        )}
        <button onClick={onRemove} className="text-[8px] text-gray-600 hover:text-red-400 ml-1">✕</button>
      </div>
      {/* Terminal */}
      <div ref={containerRef} className="flex-1 min-h-0" style={{ background: '#0d1117' }}
        onClick={() => termRef.current?.focus()} />
    </div>
  );
});

// ─── Main Workspace ───────────────────────────────────────

export default function WorkspaceView({ projectPath, projectName, onClose }: {
  projectPath: string;
  projectName: string;
  onClose: () => void;
}) {
  const [agents, setAgents] = useState<WorkspaceAgent[]>([]);

  const addFromPreset = (preset: AgentPreset) => {
    setAgents(prev => [...prev, {
      id: `${preset.id}-${Date.now()}`,
      label: preset.label,
      icon: preset.icon,
      agentId: preset.agentId,
      role: preset.role,
      inputPaths: preset.inputPaths,
      outputPaths: preset.outputPaths,
      status: 'running',
    }]);
  };

  const removeAgent = (id: string) => {
    setAgents(prev => prev.filter(a => a.id !== id));
  };

  const gridClass = agents.length <= 1 ? 'grid-cols-1' :
    agents.length <= 2 ? 'grid-cols-2' :
    agents.length <= 4 ? 'grid-cols-2' :
    'grid-cols-3';

  return (
    <div className="flex-1 flex flex-col min-h-0" style={{ background: '#080810' }}>
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-[#2a2a3a] shrink-0">
        <button onClick={onClose} className="text-gray-400 hover:text-white text-sm">←</button>
        <span className="text-xs font-bold text-white">Workspace</span>
        <span className="text-[9px] text-gray-500">{projectName}</span>
        <div className="flex items-center gap-1 ml-auto">
          {AGENT_PRESETS.map(p => (
            <button key={p.id} onClick={() => addFromPreset(p)}
              className="text-[8px] px-1.5 py-0.5 rounded border border-[#30363d] text-gray-400 hover:text-white hover:border-[var(--accent)] flex items-center gap-0.5">
              {p.icon} {p.label}
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      {agents.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-3">
          <span className="text-3xl">🚀</span>
          <div className="text-sm text-gray-400">Add agents to start</div>
          <div className="flex gap-2 mt-2">
            {AGENT_PRESETS.map(p => (
              <button key={p.id} onClick={() => addFromPreset(p)}
                className="text-[10px] px-3 py-1.5 rounded border border-[#30363d] text-gray-300 hover:text-white hover:border-[var(--accent)] flex items-center gap-1">
                {p.icon} {p.label}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className={`flex-1 grid ${gridClass} gap-1 p-1 min-h-0`}>
          {agents.map((agent, i) => (
            <AgentPanel
              key={agent.id}
              agent={agent}
              projectPath={projectPath}
              colorIdx={i}
              onRemove={() => removeAgent(agent.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
