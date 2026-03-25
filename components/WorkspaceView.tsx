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
  agentId: string;       // agent registry id: claude, codex, etc.
  role: string;          // role description / system prompt
  inputPaths: string[];  // directories/files to read from (relative to project)
  outputPaths: string[]; // directories/files to write to
  waitFor: string[];     // file paths to wait for before starting (relative to project)
  autoStart: boolean;    // start immediately or wait for user
}

interface AgentPreset {
  id: string;
  label: string;
  icon: string;
  role: string;
  inputPaths: string[];
  outputPaths: string[];
  waitFor: string[];
}

// ─── Presets ──────────────────────────────────────────────

const AGENT_PRESETS: AgentPreset[] = [
  {
    id: 'pm', label: 'PM', icon: '📋',
    role: 'You are a product manager. Analyze the task, write a PRD with functional requirements, edge cases, and acceptance criteria. Save it to the output path.',
    inputPaths: ['docs/'], outputPaths: ['docs/prd/'], waitFor: [],
  },
  {
    id: 'engineer', label: 'Engineer', icon: '🔨',
    role: 'You are a senior engineer. Read the requirements, design the architecture, implement the code. Write architecture doc and code.',
    inputPaths: ['docs/prd/'], outputPaths: ['src/', 'docs/architecture.md'], waitFor: ['docs/prd/requirements.md'],
  },
  {
    id: 'qa', label: 'QA', icon: '🧪',
    role: 'You are a QA engineer. Read requirements and code, design test cases, write and run tests.',
    inputPaths: ['docs/prd/', 'src/'], outputPaths: ['tests/', 'docs/test-plan.md'], waitFor: ['docs/prd/requirements.md'],
  },
  {
    id: 'reviewer', label: 'Reviewer', icon: '🔍',
    role: 'You are a code reviewer. Review all changes, check quality, security, and test coverage. Write a review report.',
    inputPaths: ['src/', 'tests/', 'docs/'], outputPaths: ['docs/review.md'], waitFor: ['docs/architecture.md', 'docs/test-plan.md'],
  },
];

const AGENT_COLORS = [
  { border: '#22c55e', bg: '#0d1a0d', accent: '#4ade80' },
  { border: '#3b82f6', bg: '#0d1117', accent: '#60a5fa' },
  { border: '#a855f7', bg: '#130d1a', accent: '#c084fc' },
  { border: '#f97316', bg: '#1a130d', accent: '#fb923c' },
  { border: '#ec4899', bg: '#1a0d13', accent: '#f472b6' },
  { border: '#06b6d4', bg: '#0d1a1a', accent: '#22d3ee' },
];

// ─── Terminal WebSocket URL ───────────────────────────────

function getWsUrl() {
  if (typeof window === 'undefined') return 'ws://localhost:8404';
  const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsHost = window.location.hostname;
  if (wsHost !== 'localhost' && wsHost !== '127.0.0.1') {
    return `${wsProtocol}//${window.location.host}/terminal-ws`;
  }
  const webPort = parseInt(window.location.port) || 8403;
  return `${wsProtocol}//${wsHost}:${webPort + 1}`;
}

// ─── Single Agent Terminal Pane ───────────────────────────

const AgentTerminalPane = memo(function AgentTerminalPane({
  agent,
  projectPath,
  colorIdx,
  isReady,
  onStatusChange,
}: {
  agent: WorkspaceAgent;
  projectPath: string;
  colorIdx: number;
  isReady: boolean; // whether waitFor dependencies are met
  onStatusChange: (agentId: string, status: 'idle' | 'waiting' | 'running' | 'done') => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const colors = AGENT_COLORS[colorIdx % AGENT_COLORS.length];
  const [started, setStarted] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const termRef = useRef<Terminal | null>(null);

  // Start terminal when ready
  useEffect(() => {
    if (!containerRef.current) return;
    if (started) return;

    // Don't auto-start if waiting for dependencies
    if (!isReady && agent.autoStart) {
      onStatusChange(agent.id, 'waiting');
      return;
    }
    if (!isReady && !agent.autoStart) return;

    setStarted(true);
    onStatusChange(agent.id, 'running');

    let disposed = false;
    const cs = getComputedStyle(document.documentElement);
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 12,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      scrollback: 5000,
      theme: {
        background: colors.bg,
        foreground: '#c9d1d9',
        cursor: colors.accent,
      },
    });
    termRef.current = term;

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);

    // Fit on mount and resize
    const doFit = () => { try { fitAddon.fit(); } catch {} };
    doFit();
    const ro = new ResizeObserver(doFit);
    ro.observe(containerRef.current);

    // Connect to terminal server
    const wsUrl = getWsUrl();
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    let connectedSession = '';

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'create', cols: term.cols, rows: term.rows }));
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'data' && !disposed) {
          term.write(msg.data);
        } else if (msg.type === 'connected') {
          connectedSession = msg.session;
          // Send the agent startup command
          const startCmd = buildAgentCommand(agent, projectPath);
          setTimeout(() => {
            if (!disposed && ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'input', data: startCmd }));
            }
          }, 300);
        }
      } catch {}
    };

    ws.onclose = () => {
      if (!disposed) term.write('\r\n\x1b[90m[disconnected]\x1b[0m\r\n');
    };

    // User input → terminal
    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'input', data }));
      }
    });

    // Resize → terminal
    term.onResize(({ cols, rows }) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols, rows }));
      }
    });

    return () => {
      disposed = true;
      ro.disconnect();
      ws.close();
      term.dispose();
    };
  }, [isReady, started]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleManualStart = () => {
    if (!started && isReady) {
      setStarted(true);
      onStatusChange(agent.id, 'running');
      // Re-trigger effect by forcing re-render — the useEffect above handles it
    }
  };

  return (
    <div className="flex flex-col min-h-0 rounded-lg overflow-hidden border" style={{ borderColor: colors.border + '60' }}>
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-1.5 shrink-0" style={{ background: colors.bg, borderBottom: `1px solid ${colors.border}40` }}>
        <div className="flex gap-1">
          <span className="w-2 h-2 rounded-full bg-red-500/80" />
          <span className="w-2 h-2 rounded-full bg-yellow-500/80" />
          <span className="w-2 h-2 rounded-full bg-green-500/80" />
        </div>
        <span className="text-xs">{agent.icon}</span>
        <span className="text-[10px] font-bold text-white">{agent.label}</span>
        <span className="text-[8px] px-1 py-0.5 rounded" style={{ background: colors.accent + '20', color: colors.accent }}>{agent.agentId}</span>
        {!started && !isReady && (
          <span className="text-[8px] text-yellow-400/70">⏳ waiting: {agent.waitFor.join(', ')}</span>
        )}
        {!started && isReady && !agent.autoStart && (
          <button onClick={handleManualStart} className="text-[8px] px-2 py-0.5 rounded" style={{ background: colors.accent + '30', color: colors.accent }}>
            Run
          </button>
        )}
        {started && <span className="text-[8px] animate-pulse" style={{ color: colors.accent }}>● running</span>}
        <div className="ml-auto flex gap-1 text-[7px] text-gray-500">
          {agent.inputPaths.length > 0 && <span>⬇ {agent.inputPaths.join(', ')}</span>}
          {agent.outputPaths.length > 0 && <span>⬆ {agent.outputPaths.join(', ')}</span>}
        </div>
      </div>

      {/* Terminal or waiting state */}
      <div ref={containerRef} className="flex-1 min-h-0" style={{ background: colors.bg }}>
        {!started && (
          <div className="p-3 text-[10px] text-gray-500 font-mono">
            <div style={{ color: colors.accent }}>$ {agent.label} ({agent.agentId})</div>
            <div className="mt-1 text-gray-600">{agent.role.slice(0, 120)}...</div>
            {agent.waitFor.length > 0 && !isReady && (
              <div className="mt-2 text-yellow-400/60">Waiting for: {agent.waitFor.join(', ')}</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
});

// ─── Build agent startup command ──────────────────────────

function buildAgentCommand(agent: WorkspaceAgent, projectPath: string): string {
  // Build a prompt that includes the role and input/output context
  const contextLines = [
    `You are working in project: ${projectPath}`,
    `Your role: ${agent.role}`,
  ];
  if (agent.inputPaths.length > 0) {
    contextLines.push(`Read input from: ${agent.inputPaths.join(', ')}`);
  }
  if (agent.outputPaths.length > 0) {
    contextLines.push(`Write output to: ${agent.outputPaths.join(', ')}`);
  }
  const prompt = contextLines.join('. ');

  // Use the agent's CLI — default to claude
  if (agent.agentId === 'claude' || !agent.agentId) {
    return `cd "${projectPath}" && claude -p "${prompt.replace(/"/g, '\\"')}"\n`;
  }
  // Generic agent
  return `cd "${projectPath}" && ${agent.agentId} "${prompt.replace(/"/g, '\\"')}"\n`;
}

// ─── File watcher hook ────────────────────────────────────

function useFileWatcher(projectPath: string, filePaths: string[], intervalMs = 3000) {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (filePaths.length === 0) { setReady(true); return; }

    const check = async () => {
      try {
        // Check each file by trying to read it via the code API
        const results = await Promise.all(
          filePaths.map(async (fp) => {
            const fullPath = fp.startsWith('/') ? fp : `${projectPath}/${fp}`;
            const res = await fetch(`/api/code?dir=${encodeURIComponent(projectPath)}&file=${encodeURIComponent(fullPath)}`);
            return res.ok;
          })
        );
        if (results.every(Boolean)) setReady(true);
      } catch {}
    };

    check();
    if (!ready) {
      const timer = setInterval(check, intervalMs);
      return () => clearInterval(timer);
    }
  }, [projectPath, filePaths.join(','), intervalMs, ready]); // eslint-disable-line react-hooks/exhaustive-deps

  return ready;
}

// ─── Agent Config Modal ───────────────────────────────────

function AgentConfigModal({ agent, agents: availableAgents, onSave, onClose }: {
  agent: WorkspaceAgent | null; // null = new agent
  agents: { id: string; name: string }[];
  onSave: (agent: WorkspaceAgent) => void;
  onClose: () => void;
}) {
  const [form, setForm] = useState<WorkspaceAgent>(agent || {
    id: `agent-${Date.now()}`,
    label: 'Custom Agent',
    icon: '⚙',
    agentId: 'claude',
    role: '',
    inputPaths: [],
    outputPaths: [],
    waitFor: [],
    autoStart: true,
  });
  const [inputStr, setInputStr] = useState(form.inputPaths.join(', '));
  const [outputStr, setOutputStr] = useState(form.outputPaths.join(', '));
  const [waitStr, setWaitStr] = useState(form.waitFor.join(', '));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div className="bg-[#1a1a2e] border border-[#3a3a5a] rounded-xl p-4 w-[460px] space-y-3" onClick={e => e.stopPropagation()}>
        <div className="text-sm font-bold text-white">{agent ? 'Edit Agent' : 'Add Agent'}</div>

        <div className="grid grid-cols-3 gap-2">
          <div>
            <label className="text-[9px] text-gray-400">Label</label>
            <input value={form.label} onChange={e => setForm(f => ({ ...f, label: e.target.value }))}
              className="w-full text-xs bg-[#0d1117] border border-[#30363d] rounded px-2 py-1.5 text-white" />
          </div>
          <div>
            <label className="text-[9px] text-gray-400">Icon</label>
            <input value={form.icon} onChange={e => setForm(f => ({ ...f, icon: e.target.value }))}
              className="w-full text-xs bg-[#0d1117] border border-[#30363d] rounded px-2 py-1.5 text-white" maxLength={2} />
          </div>
          <div>
            <label className="text-[9px] text-gray-400">Agent</label>
            <select value={form.agentId} onChange={e => setForm(f => ({ ...f, agentId: e.target.value }))}
              className="w-full text-xs bg-[#0d1117] border border-[#30363d] rounded px-2 py-1.5 text-white">
              {availableAgents.map(a => <option key={a.id} value={a.id}>{a.name || a.id}</option>)}
            </select>
          </div>
        </div>

        <div>
          <label className="text-[9px] text-gray-400">Role Description</label>
          <textarea value={form.role} onChange={e => setForm(f => ({ ...f, role: e.target.value }))}
            className="w-full text-xs bg-[#0d1117] border border-[#30363d] rounded px-2 py-1.5 text-gray-300 resize-none" rows={3} />
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="text-[9px] text-gray-400">Input Paths (comma-separated)</label>
            <input value={inputStr} onChange={e => setInputStr(e.target.value)}
              className="w-full text-[10px] bg-[#0d1117] border border-[#30363d] rounded px-2 py-1.5 text-gray-300 font-mono" placeholder="docs/prd/" />
          </div>
          <div>
            <label className="text-[9px] text-gray-400">Output Paths</label>
            <input value={outputStr} onChange={e => setOutputStr(e.target.value)}
              className="w-full text-[10px] bg-[#0d1117] border border-[#30363d] rounded px-2 py-1.5 text-gray-300 font-mono" placeholder="src/, docs/arch.md" />
          </div>
        </div>

        <div>
          <label className="text-[9px] text-gray-400">Wait For (files that must exist before starting)</label>
          <input value={waitStr} onChange={e => setWaitStr(e.target.value)}
            className="w-full text-[10px] bg-[#0d1117] border border-[#30363d] rounded px-2 py-1.5 text-gray-300 font-mono" placeholder="docs/prd/requirements.md" />
        </div>

        <label className="flex items-center gap-2 text-[10px] text-gray-400 cursor-pointer">
          <input type="checkbox" checked={form.autoStart} onChange={e => setForm(f => ({ ...f, autoStart: e.target.checked }))}
            className="accent-green-500" />
          Auto-start when dependencies are ready
        </label>

        <div className="flex justify-end gap-2 pt-1">
          <button onClick={onClose} className="text-xs px-3 py-1 text-gray-400 hover:text-white">Cancel</button>
          <button onClick={() => {
            onSave({
              ...form,
              inputPaths: inputStr.split(',').map(s => s.trim()).filter(Boolean),
              outputPaths: outputStr.split(',').map(s => s.trim()).filter(Boolean),
              waitFor: waitStr.split(',').map(s => s.trim()).filter(Boolean),
            });
          }} className="text-xs px-3 py-1 bg-green-600 text-white rounded hover:opacity-90">Save</button>
        </div>
      </div>
    </div>
  );
}

// ─── Agent Pane Wrapper (with file watcher) ───────────────

function AgentPaneWithWatcher({ agent, projectPath, colorIdx, onStatusChange }: {
  agent: WorkspaceAgent;
  projectPath: string;
  colorIdx: number;
  onStatusChange: (agentId: string, status: 'idle' | 'waiting' | 'running' | 'done') => void;
}) {
  const isReady = useFileWatcher(projectPath, agent.waitFor);

  return (
    <AgentTerminalPane
      agent={agent}
      projectPath={projectPath}
      colorIdx={colorIdx}
      isReady={isReady}
      onStatusChange={onStatusChange}
    />
  );
}

// ─── Main Workspace View ──────────────────────────────────

export default function WorkspaceView({ projectPath, projectName, onClose }: {
  projectPath: string;
  projectName: string;
  onClose: () => void;
}) {
  const [agents, setAgents] = useState<WorkspaceAgent[]>([]);
  const [editing, setEditing] = useState<WorkspaceAgent | null | 'new'>(null);
  const [availableAgents, setAvailableAgents] = useState<{ id: string; name: string }[]>([]);
  const [statuses, setStatuses] = useState<Record<string, string>>({});

  useEffect(() => {
    fetch('/api/agents').then(r => r.json()).then(d => setAvailableAgents(d.agents || [])).catch(() => {});
  }, []);

  const handleStatusChange = useCallback((agentId: string, status: string) => {
    setStatuses(prev => ({ ...prev, [agentId]: status }));
  }, []);

  const addFromPreset = (preset: AgentPreset) => {
    const agent: WorkspaceAgent = {
      id: `${preset.id}-${Date.now()}`,
      label: preset.label,
      icon: preset.icon,
      agentId: 'claude',
      role: preset.role,
      inputPaths: preset.inputPaths,
      outputPaths: preset.outputPaths,
      waitFor: preset.waitFor,
      autoStart: true,
    };
    setAgents(prev => [...prev, agent]);
  };

  const removeAgent = (id: string) => {
    setAgents(prev => prev.filter(a => a.id !== id));
  };

  const saveAgent = (agent: WorkspaceAgent) => {
    setAgents(prev => {
      const idx = prev.findIndex(a => a.id === agent.id);
      if (idx >= 0) { const next = [...prev]; next[idx] = agent; return next; }
      return [...prev, agent];
    });
    setEditing(null);
  };

  // Grid layout based on agent count
  const gridClass = agents.length <= 1 ? 'grid-cols-1' :
    agents.length <= 2 ? 'grid-cols-2' :
    agents.length <= 4 ? 'grid-cols-2' :
    'grid-cols-3';

  return (
    <div className="flex-1 flex flex-col min-h-0" style={{ background: '#080810' }}>
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-2 border-b border-[#2a2a3a] shrink-0">
        <button onClick={onClose} className="text-gray-400 hover:text-white text-sm">←</button>
        <span className="text-sm font-bold text-white">Workspace</span>
        <span className="text-[10px] text-gray-500">{projectName}</span>
        <span className="text-[8px] text-gray-600 font-mono">{projectPath}</span>

        <div className="flex items-center gap-1 ml-auto">
          {/* Preset buttons */}
          {AGENT_PRESETS.map(p => (
            <button key={p.id} onClick={() => addFromPreset(p)}
              className="text-[8px] px-1.5 py-0.5 rounded border border-[#30363d] text-gray-400 hover:text-white hover:border-[var(--accent)] flex items-center gap-0.5">
              {p.icon} {p.label}
            </button>
          ))}
          <button onClick={() => setEditing('new')}
            className="text-[8px] px-1.5 py-0.5 rounded border border-dashed border-[#30363d] text-gray-500 hover:text-white">
            + Custom
          </button>
        </div>
      </div>

      {/* Agent terminals grid */}
      {agents.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-3">
          <span className="text-3xl">🚀</span>
          <div className="text-sm text-gray-400">Add agents to start</div>
          <div className="text-[10px] text-gray-600">Click a preset above or create a custom agent</div>
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
            <AgentPaneWithWatcher
              key={agent.id}
              agent={agent}
              projectPath={projectPath}
              colorIdx={i}
              onStatusChange={handleStatusChange}
            />
          ))}
        </div>
      )}

      {/* Config modal */}
      {editing && (
        <AgentConfigModal
          agent={editing === 'new' ? null : editing}
          agents={availableAgents}
          onSave={saveAgent}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}
