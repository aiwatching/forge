'use client';

import { useState, useEffect, useCallback, useMemo, useRef, forwardRef, useImperativeHandle, lazy, Suspense } from 'react';
import {
  ReactFlow, Background, Controls, Handle, Position, useReactFlow, ReactFlowProvider,
  type Node, type NodeProps, MarkerType, type NodeChange,
  applyNodeChanges,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

// ─── Types (mirrors lib/workspace/types) ─────────────────

interface AgentConfig {
  id: string; label: string; icon: string; role: string;
  type?: 'agent' | 'input';
  content?: string;
  entries?: { content: string; timestamp: number }[];
  backend: 'api' | 'cli';
  agentId?: string; provider?: string; model?: string;
  dependsOn: string[];
  workDir?: string;
  outputs: string[];
  steps: { id: string; label: string; prompt: string }[];
  requiresApproval?: boolean;
  watch?: { enabled: boolean; interval: number; targets: any[]; action?: 'log' | 'analyze' | 'approve'; prompt?: string };
}

interface AgentState {
  smithStatus: 'down' | 'active';
  mode: 'auto' | 'manual';
  taskStatus: 'idle' | 'running' | 'done' | 'failed';
  currentStep?: number;
  tmuxSession?: string;
  artifacts: { type: string; path?: string; summary?: string }[];
  error?: string; lastCheckpoint?: number;
  daemonIteration?: number;
}

// ─── Constants ───────────────────────────────────────────

const COLORS = [
  { border: '#22c55e', bg: '#0a1a0a', accent: '#4ade80' },
  { border: '#3b82f6', bg: '#0a0f1a', accent: '#60a5fa' },
  { border: '#a855f7', bg: '#100a1a', accent: '#c084fc' },
  { border: '#f97316', bg: '#1a100a', accent: '#fb923c' },
  { border: '#ec4899', bg: '#1a0a10', accent: '#f472b6' },
  { border: '#06b6d4', bg: '#0a1a1a', accent: '#22d3ee' },
];

// Smith status colors
const SMITH_STATUS: Record<string, { label: string; color: string; glow?: boolean }> = {
  down: { label: 'down', color: '#30363d' },
  active: { label: 'active', color: '#3fb950', glow: true },
};

// Task status colors
const TASK_STATUS: Record<string, { label: string; color: string; glow?: boolean }> = {
  idle: { label: 'idle', color: '#30363d' },
  running: { label: 'running', color: '#3fb950', glow: true },
  done: { label: 'done', color: '#58a6ff' },
  failed: { label: 'failed', color: '#f85149' },
};

const PRESET_AGENTS: Omit<AgentConfig, 'id'>[] = [
  { label: 'PM', icon: '📋', role: 'Product Manager — analyze requirements, write PRD. Do NOT write code.', backend: 'cli', agentId: 'claude', dependsOn: [], outputs: ['docs/prd.md'], steps: [
    { id: 'analyze', label: 'Analyze', prompt: 'Read existing docs and project structure. Identify key requirements.' },
    { id: 'write', label: 'Write PRD', prompt: 'Write a detailed PRD to docs/prd.md.' },
    { id: 'review', label: 'Self-Review', prompt: 'Review and improve the PRD.' },
  ]},
  { label: 'Engineer', icon: '🔨', role: 'Senior Engineer — design and implement based on PRD.', backend: 'cli', agentId: 'claude', dependsOn: [], outputs: ['src/', 'docs/architecture.md'], steps: [
    { id: 'design', label: 'Design', prompt: 'Read PRD, design architecture, write docs/architecture.md.' },
    { id: 'implement', label: 'Implement', prompt: 'Implement features based on the architecture.' },
    { id: 'test', label: 'Self-Test', prompt: 'Review implementation and fix issues.' },
  ]},
  { label: 'QA', icon: '🧪', role: 'QA Engineer — write and run tests. Do NOT fix bugs, only report.', backend: 'cli', agentId: 'claude', dependsOn: [], outputs: ['tests/', 'docs/test-plan.md'], steps: [
    { id: 'plan', label: 'Test Plan', prompt: 'Write test plan to docs/test-plan.md.' },
    { id: 'write', label: 'Write Tests', prompt: 'Implement test cases in tests/ directory.' },
    { id: 'run', label: 'Run Tests', prompt: 'Run all tests and document results.' },
  ]},
  { label: 'Reviewer', icon: '🔍', role: 'Code Reviewer — review for quality and security. Do NOT modify code.', backend: 'cli', agentId: 'claude', dependsOn: [], outputs: ['docs/review.md'], steps: [
    { id: 'review', label: 'Review', prompt: 'Review all code changes for quality and security.' },
    { id: 'report', label: 'Report', prompt: 'Write review report to docs/review.md.' },
  ]},
];

// ─── API helpers ─────────────────────────────────────────

async function wsApi(workspaceId: string, action: string, body?: Record<string, any>) {
  const res = await fetch(`/api/workspace/${workspaceId}/agents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...body }),
  });
  const data = await res.json();
  if (data.warning) {
    alert(`Warning: ${data.warning}`);
  }
  if (!res.ok && data.error) {
    alert(`Error: ${data.error}`);
  }
  return data;
}

async function ensureWorkspace(projectPath: string, projectName: string): Promise<string> {
  // Find or create workspace
  const res = await fetch(`/api/workspace?projectPath=${encodeURIComponent(projectPath)}`);
  const existing = await res.json();
  if (existing?.id) return existing.id;

  const createRes = await fetch('/api/workspace', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectPath, projectName }),
  });
  const created = await createRes.json();
  return created.id;
}

// ─── SSE Hook ────────────────────────────────────────────

function useWorkspaceStream(workspaceId: string | null, onEvent?: (event: any) => void) {
  const [agents, setAgents] = useState<AgentConfig[]>([]);
  const [states, setStates] = useState<Record<string, AgentState>>({});
  const [logPreview, setLogPreview] = useState<Record<string, string[]>>({});
  const [busLog, setBusLog] = useState<any[]>([]);
  const [daemonActive, setDaemonActive] = useState(false);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    if (!workspaceId) return;

    const es = new EventSource(`/api/workspace/${workspaceId}/stream`);

    es.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data);

        if (event.type === 'init') {
          setAgents(event.agents || []);
          setStates(event.agentStates || {});
          setBusLog(event.busLog || []);
          if (event.daemonActive !== undefined) setDaemonActive(event.daemonActive);
          return;
        }

        if (event.type === 'task_status') {
          setStates(prev => ({
            ...prev,
            [event.agentId]: {
              ...prev[event.agentId],
              taskStatus: event.taskStatus,
              error: event.error,
            },
          }));
        }

        if (event.type === 'smith_status') {
          setStates(prev => ({
            ...prev,
            [event.agentId]: {
              ...prev[event.agentId],
              smithStatus: event.smithStatus,
              mode: event.mode,
            },
          }));
        }

        if (event.type === 'log') {
          const entry = event.entry;
          if (entry?.content) {
            setLogPreview(prev => {
              // Summary entries replace the preview entirely (cleaner display)
              if (entry.subtype === 'step_summary' || entry.subtype === 'final_summary') {
                const summaryLines = entry.content.split('\n').filter((l: string) => l.trim()).slice(0, 4);
                return { ...prev, [event.agentId]: summaryLines };
              }
              // Regular logs: append, keep last 3
              const lines = [...(prev[event.agentId] || []), entry.content].slice(-3);
              return { ...prev, [event.agentId]: lines };
            });
          }
        }

        if (event.type === 'step') {
          setStates(prev => ({
            ...prev,
            [event.agentId]: { ...prev[event.agentId], currentStep: event.stepIndex },
          }));
        }

        if (event.type === 'error') {
          setStates(prev => ({
            ...prev,
            [event.agentId]: { ...prev[event.agentId], taskStatus: 'failed', error: event.error },
          }));
        }

        if (event.type === 'bus_message') {
          setBusLog(prev => prev.some(m => m.id === event.message.id) ? prev : [...prev, event.message]);
        }

        if (event.type === 'bus_message_status') {
          setBusLog(prev => prev.map(m =>
            m.id === event.messageId ? { ...m, status: event.status } : m
          ));
        }

        // Server pushed updated agents list + states (after add/remove/update/reset)
        if (event.type === 'agents_changed') {
          const newAgents = event.agents || [];
          setAgents(prev => {
            // Guard: don't accept a smaller agents list unless it was an explicit removal
            // (removal shrinks by exactly 1, not more)
            if (newAgents.length > 0 && newAgents.length < prev.length - 1) {
              console.warn(`[sse] agents_changed: ignoring shrink from ${prev.length} to ${newAgents.length}`);
              return prev;
            }
            return newAgents;
          });
          if (event.agentStates) setStates(event.agentStates);
        }

        // Watch alerts — update agent state with last alert
        if (event.type === 'watch_alert') {
          setStates(prev => ({
            ...prev,
            [event.agentId]: {
              ...prev[event.agentId],
              lastWatchAlert: event.summary,
              lastWatchTime: event.timestamp,
            },
          }));
        }

        // Forward special events to the component
        if (event.type === 'user_input_request' || event.type === 'workspace_complete') {
          onEventRef.current?.(event);
        }
      } catch {}
    };

    return () => es.close();
  }, [workspaceId]);

  return { agents, states, logPreview, busLog, setAgents, daemonActive, setDaemonActive };
}

// ─── Agent Config Modal ──────────────────────────────────

function AgentConfigModal({ initial, mode, existingAgents, projectPath, onConfirm, onCancel }: {
  initial: Partial<AgentConfig>;
  mode: 'add' | 'edit';
  existingAgents: AgentConfig[];
  projectPath?: string;
  onConfirm: (cfg: Omit<AgentConfig, 'id'>) => void;
  onCancel: () => void;
}) {
  const [label, setLabel] = useState(initial.label || '');
  const [icon, setIcon] = useState(initial.icon || '🤖');
  const [role, setRole] = useState(initial.role || '');
  const [backend, setBackend] = useState<'api' | 'cli'>(initial.backend === 'api' ? 'api' : 'cli');
  const [agentId, setAgentId] = useState(initial.agentId || 'claude');
  const [availableAgents, setAvailableAgents] = useState<{ id: string; name: string; isProfile?: boolean; backendType?: string }[]>([]);

  useEffect(() => {
    fetch('/api/agents').then(r => r.json()).then(data => {
      const list = (data.agents || data || []).map((a: any) => ({
        id: a.id, name: a.name || a.id,
        isProfile: a.isProfile || a.base,
        backendType: a.backendType || 'cli',
      }));
      setAvailableAgents(list);
    }).catch(() => {});
  }, []);
  const [workDirVal, setWorkDirVal] = useState(initial.workDir || '');
  const [outputs, setOutputs] = useState((initial.outputs || []).join(', '));
  const [selectedDeps, setSelectedDeps] = useState<Set<string>>(new Set(initial.dependsOn || []));
  const [stepsText, setStepsText] = useState(
    (initial.steps || []).map(s => `${s.label}: ${s.prompt}`).join('\n') || ''
  );
  const [watchEnabled, setWatchEnabled] = useState(initial.watch?.enabled || false);
  const [watchInterval, setWatchInterval] = useState(String(initial.watch?.interval || 60));
  const [watchAction, setWatchAction] = useState<'log' | 'analyze' | 'approve'>(initial.watch?.action || 'log');
  const [watchPrompt, setWatchPrompt] = useState(initial.watch?.prompt || '');
  const [watchTargets, setWatchTargets] = useState<{ type: string; path?: string; cmd?: string }[]>(
    initial.watch?.targets || []
  );
  const [projectDirs, setProjectDirs] = useState<string[]>([]);

  useEffect(() => {
    if (!watchEnabled || !projectPath) return;
    fetch(`/api/code?dir=${encodeURIComponent(projectPath)}`)
      .then(r => r.json())
      .then(data => {
        // Flatten directory tree (type='dir') to list of paths
        const dirs: string[] = [];
        const walk = (nodes: any[], prefix = '') => {
          for (const n of nodes || []) {
            if (n.type === 'dir') {
              const path = prefix ? `${prefix}/${n.name}` : n.name;
              dirs.push(path);
              if (n.children) walk(n.children, path);
            }
          }
        };
        walk(data.tree || []);
        setProjectDirs(dirs);
      })
      .catch(() => {});
  }, [watchEnabled, projectPath]);

  const applyPreset = (p: Omit<AgentConfig, 'id'>) => {
    setLabel(p.label); setIcon(p.icon); setRole(p.role);
    setBackend(p.backend); setAgentId(p.agentId || 'claude');
    setWorkDirVal(p.workDir || './');
    setOutputs(p.outputs.join(', '));
    setStepsText(p.steps.map(s => `${s.label}: ${s.prompt}`).join('\n'));
  };

  const toggleDep = (id: string) => {
    setSelectedDeps(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const parseSteps = () => stepsText.split('\n').filter(Boolean).map((line, i) => {
    const [lbl, ...rest] = line.split(':');
    return { id: `step-${i}`, label: lbl.trim(), prompt: rest.join(':').trim() || lbl.trim() };
  });

  // Filter out self when editing
  const otherAgents = existingAgents.filter(a => a.id !== initial.id);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.75)' }}
      onClick={e => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="w-[440px] max-h-[80vh] overflow-auto rounded-lg border border-[#30363d] p-4 shadow-xl" style={{ background: '#0d1117' }}>
        <div className="flex items-center justify-between mb-3">
          <span className="text-sm font-bold text-white">{mode === 'add' ? 'Add Agent' : 'Edit Agent'}</span>
          <button onClick={onCancel} className="text-gray-500 hover:text-white text-xs">✕</button>
        </div>

        <div className="flex flex-col gap-2.5">
          {/* Preset quick-select (add mode only) */}
          {mode === 'add' && (
            <div className="flex flex-col gap-1">
              <label className="text-[9px] text-gray-500 uppercase">Template</label>
              <div className="flex gap-1 flex-wrap">
                {PRESET_AGENTS.map((p, i) => (
                  <button key={i} onClick={() => applyPreset(p)}
                    className={`text-[9px] px-2 py-1 rounded border transition-colors ${label === p.label ? 'border-[#58a6ff] text-[#58a6ff] bg-[#58a6ff]/10' : 'border-[#30363d] text-gray-400 hover:text-white'}`}>
                    {p.icon} {p.label}
                  </button>
                ))}
                <button onClick={() => { setLabel(''); setIcon('🤖'); setRole(''); setStepsText(''); setOutputs(''); }}
                  className={`text-[9px] px-2 py-1 rounded border border-dashed ${!label ? 'border-[#58a6ff] text-[#58a6ff]' : 'border-[#30363d] text-gray-500 hover:text-white'}`}>
                  Custom
                </button>
              </div>
            </div>
          )}

          {/* Icon + Label */}
          <div className="flex gap-2">
            <div className="flex flex-col gap-1">
              <label className="text-[9px] text-gray-500 uppercase">Icon</label>
              <input value={icon} onChange={e => setIcon(e.target.value)} className="w-12 text-center text-sm bg-[#161b22] border border-[#30363d] rounded px-1 py-1 text-white focus:outline-none focus:border-[#58a6ff]" />
            </div>
            <div className="flex flex-col gap-1 flex-1">
              <label className="text-[9px] text-gray-500 uppercase">Label</label>
              <input value={label} onChange={e => setLabel(e.target.value)} placeholder="e.g. Engineer" className="text-xs bg-[#161b22] border border-[#30363d] rounded px-2 py-1 text-white focus:outline-none focus:border-[#58a6ff]" />
            </div>
          </div>

          {/* Backend */}
          <div className="flex flex-col gap-1">
            <label className="text-[9px] text-gray-500 uppercase">Backend</label>
            <div className="flex gap-1">
              {(['cli', 'api'] as const).map(b => (
                <button key={b} onClick={() => setBackend(b)}
                  className={`text-[9px] px-2 py-1 rounded border ${backend === b ? 'border-[#58a6ff] text-[#58a6ff] bg-[#58a6ff]/10' : 'border-[#30363d] text-gray-400 hover:text-white'}`}>
                  {b === 'cli' ? 'CLI (subscription)' : 'API (api key)'}
                </button>
              ))}
            </div>
          </div>

          {/* Agent selection — dynamic from /api/agents */}
          {backend === 'cli' && (
            <div className="flex flex-col gap-1">
              <label className="text-[9px] text-gray-500 uppercase">Agent / Profile</label>
              <div className="flex gap-1 flex-wrap">
                {(availableAgents.length > 0
                  ? availableAgents.filter(a => a.backendType !== 'api')
                  : [{ id: 'claude', name: 'claude' }, { id: 'codex', name: 'codex' }, { id: 'aider', name: 'aider' }]
                ).map(a => (
                  <button key={a.id} onClick={() => setAgentId(a.id)}
                    className={`text-[9px] px-2 py-1 rounded border ${agentId === a.id ? 'border-[#58a6ff] text-[#58a6ff] bg-[#58a6ff]/10' : 'border-[#30363d] text-gray-400 hover:text-white'}`}>
                    {a.name}{a.isProfile ? ' ●' : ''}
                  </button>
                ))}
              </div>
            </div>
          )}
          {backend === 'api' && (
            <div className="flex flex-col gap-1">
              <label className="text-[9px] text-gray-500 uppercase">API Profile</label>
              <div className="flex gap-1 flex-wrap">
                {availableAgents.filter(a => a.backendType === 'api').map(a => (
                  <button key={a.id} onClick={() => setAgentId(a.id)}
                    className={`text-[9px] px-2 py-1 rounded border ${agentId === a.id ? 'border-[#58a6ff] text-[#58a6ff] bg-[#58a6ff]/10' : 'border-[#30363d] text-gray-400 hover:text-white'}`}>
                    {a.name}
                  </button>
                ))}
                {availableAgents.filter(a => a.backendType === 'api').length === 0 && (
                  <span className="text-[9px] text-gray-600">No API profiles configured. Add in Settings.</span>
                )}
              </div>
            </div>
          )}

          {/* Role */}
          <div className="flex flex-col gap-1">
            <label className="text-[9px] text-gray-500 uppercase">Role / System Prompt</label>
            <textarea value={role} onChange={e => setRole(e.target.value)} rows={2}
              className="text-xs bg-[#161b22] border border-[#30363d] rounded px-2 py-1 text-white focus:outline-none focus:border-[#58a6ff] resize-none" />
          </div>

          {/* Depends On — checkbox list of existing agents */}
          {otherAgents.length > 0 && (
            <div className="flex flex-col gap-1">
              <label className="text-[9px] text-gray-500 uppercase">Depends On (upstream agents)</label>
              <div className="flex flex-wrap gap-1.5">
                {otherAgents.map(a => (
                  <button key={a.id} onClick={() => toggleDep(a.id)}
                    className={`text-[9px] px-2 py-1 rounded border flex items-center gap-1 ${
                      selectedDeps.has(a.id)
                        ? 'border-[#58a6ff] text-[#58a6ff] bg-[#58a6ff]/10'
                        : 'border-[#30363d] text-gray-400 hover:text-white'}`}>
                    <span>{selectedDeps.has(a.id) ? '☑' : '☐'}</span>
                    <span>{a.icon} {a.label}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Work Dir + Outputs */}
          <div className="flex gap-2">
            <div className="flex flex-col gap-1 w-28">
              <label className="text-[9px] text-gray-500 uppercase">Work Dir</label>
              <input value={workDirVal} onChange={e => setWorkDirVal(e.target.value)} placeholder={label ? `${label.toLowerCase().replace(/\s+/g, '-')}/` : 'engineer/'}
                className="text-xs bg-[#161b22] border border-[#30363d] rounded px-2 py-1 text-white focus:outline-none focus:border-[#58a6ff]" />
              <div className="text-[8px] text-gray-600 mt-0.5">
                → {'{project}/'}{(workDirVal || (label ? `${label.toLowerCase().replace(/\s+/g, '-')}/` : '')).replace(/^\.?\//, '')}
              </div>
            </div>
            <div className="flex flex-col gap-1 flex-1">
              <label className="text-[9px] text-gray-500 uppercase">Outputs</label>
              <input value={outputs} onChange={e => setOutputs(e.target.value)} placeholder="docs/prd.md, src/"
                className="text-xs bg-[#161b22] border border-[#30363d] rounded px-2 py-1 text-white focus:outline-none focus:border-[#58a6ff]" />
            </div>
          </div>

          {/* Steps */}
          <div className="flex flex-col gap-1">
            <label className="text-[9px] text-gray-500 uppercase">Steps (one per line — Label: Prompt)</label>
            <textarea value={stepsText} onChange={e => setStepsText(e.target.value)} rows={4}
              placeholder="Analyze: Read docs and identify requirements&#10;Write: Write PRD to docs/prd.md&#10;Review: Review and improve"
              className="text-xs bg-[#161b22] border border-[#30363d] rounded px-2 py-1 text-white focus:outline-none focus:border-[#58a6ff] resize-none font-mono" />
          </div>

          {/* Watch */}
          <div className="flex flex-col gap-1.5 border-t border-[#21262d] pt-2 mt-1">
            <div className="flex items-center gap-2">
              <label className="text-[9px] text-gray-500 uppercase">Watch</label>
              <input type="checkbox" checked={watchEnabled} onChange={e => setWatchEnabled(e.target.checked)}
                className="accent-[#58a6ff]" />
              <span className="text-[8px] text-gray-600">Autonomous periodic monitoring</span>
            </div>
            {watchEnabled && (<>
              <div className="flex gap-2">
                <div className="flex flex-col gap-0.5 flex-1">
                  <label className="text-[8px] text-gray-600">Interval (seconds)</label>
                  <input value={watchInterval} onChange={e => setWatchInterval(e.target.value)} type="number" min="10"
                    className="text-xs bg-[#161b22] border border-[#30363d] rounded px-2 py-1 text-white focus:outline-none focus:border-[#58a6ff] w-20" />
                </div>
                <div className="flex flex-col gap-0.5 flex-1">
                  <label className="text-[8px] text-gray-600">On Change</label>
                  <select value={watchAction} onChange={e => setWatchAction(e.target.value as any)}
                    className="text-xs bg-[#161b22] border border-[#30363d] rounded px-2 py-1 text-white focus:outline-none focus:border-[#58a6ff]">
                    <option value="log">Log only</option>
                    <option value="analyze">Auto analyze</option>
                    <option value="approve">Require approval</option>
                  </select>
                </div>
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-[8px] text-gray-600">Targets</label>
                {watchTargets.map((t, i) => (
                  <div key={i} className="flex items-center gap-1">
                    <select value={t.type} onChange={e => {
                      const next = [...watchTargets];
                      next[i] = { type: e.target.value };
                      setWatchTargets(next);
                    }} className="text-[10px] bg-[#161b22] border border-[#30363d] rounded px-1 py-0.5 text-white w-24">
                      <option value="directory">Directory</option>
                      <option value="git">Git</option>
                      <option value="agent_output">Agent Output</option>
                      <option value="command">Command</option>
                    </select>
                    {t.type === 'directory' && (
                      <select value={t.path || ''} onChange={e => {
                        const next = [...watchTargets];
                        next[i] = { ...t, path: e.target.value };
                        setWatchTargets(next);
                      }} className="text-[10px] bg-[#161b22] border border-[#30363d] rounded px-1 py-0.5 text-white flex-1">
                        <option value="">Project root</option>
                        {projectDirs.map(d => <option key={d} value={d + '/'}>{d}/</option>)}
                      </select>
                    )}
                    {t.type === 'agent_output' && (
                      <select value={t.path || ''} onChange={e => {
                        const next = [...watchTargets];
                        next[i] = { ...t, path: e.target.value };
                        setWatchTargets(next);
                      }} className="text-[10px] bg-[#161b22] border border-[#30363d] rounded px-1 py-0.5 text-white flex-1">
                        <option value="">Select agent...</option>
                        {existingAgents.filter(a => a.id !== initial.id).map(a =>
                          <option key={a.id} value={a.id}>{a.icon} {a.label}</option>
                        )}
                      </select>
                    )}
                    {t.type === 'command' && (
                      <input value={t.cmd || ''} onChange={e => {
                        const next = [...watchTargets];
                        next[i] = { ...t, cmd: e.target.value };
                        setWatchTargets(next);
                      }} placeholder="npm test"
                        className="text-[10px] bg-[#161b22] border border-[#30363d] rounded px-1 py-0.5 text-white flex-1" />
                    )}
                    <button onClick={() => setWatchTargets(watchTargets.filter((_, j) => j !== i))}
                      className="text-[9px] text-gray-500 hover:text-red-400">✕</button>
                  </div>
                ))}
                <button onClick={() => setWatchTargets([...watchTargets, { type: 'directory' }])}
                  className="text-[8px] text-gray-500 hover:text-[#58a6ff] self-start">+ Add target</button>
              </div>
              {watchAction === 'analyze' && (
                <div className="flex flex-col gap-0.5">
                  <label className="text-[8px] text-gray-600">Analysis prompt (optional)</label>
                  <input value={watchPrompt} onChange={e => setWatchPrompt(e.target.value)}
                    placeholder="Analyze these changes and check for issues..."
                    className="text-xs bg-[#161b22] border border-[#30363d] rounded px-2 py-1 text-white focus:outline-none focus:border-[#58a6ff]" />
                </div>
              )}
            </>)}
          </div>
        </div>

        <div className="flex justify-end gap-2 mt-4">
          <button onClick={onCancel} className="text-xs px-3 py-1.5 rounded border border-[#30363d] text-gray-400 hover:text-white">Cancel</button>
          <button disabled={!label.trim()} onClick={() => {
            onConfirm({
              label: label.trim(), icon: icon.trim() || '🤖', role: role.trim(),
              backend, agentId, dependsOn: Array.from(selectedDeps),
              workDir: workDirVal.trim() || label.trim().toLowerCase().replace(/\s+/g, '-') + '/',
              outputs: outputs.split(',').map(s => s.trim()).filter(Boolean),
              steps: parseSteps(),
              watch: watchEnabled && watchTargets.length > 0 ? {
                enabled: true,
                interval: Math.max(10, parseInt(watchInterval) || 60),
                targets: watchTargets,
                action: watchAction,
                prompt: watchPrompt || undefined,
              } : undefined,
            } as any);
          }} className="text-xs px-3 py-1.5 rounded bg-[#238636] text-white hover:bg-[#2ea043] disabled:opacity-40">
            {mode === 'add' ? 'Add' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Message Dialog ──────────────────────────────────────

function MessageDialog({ agentLabel, onSend, onCancel }: {
  agentLabel: string;
  onSend: (msg: string) => void;
  onCancel: () => void;
}) {
  const [msg, setMsg] = useState('');
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.75)' }}
      onClick={e => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="w-96 rounded-lg border border-[#30363d] p-4 shadow-xl" style={{ background: '#0d1117' }}>
        <div className="text-sm font-bold text-white mb-2">Message to {agentLabel}</div>
        <textarea value={msg} onChange={e => setMsg(e.target.value)} rows={3} autoFocus
          placeholder="Type your message..."
          className="w-full text-xs bg-[#161b22] border border-[#30363d] rounded px-2 py-1.5 text-white focus:outline-none focus:border-[#58a6ff] resize-none" />
        <div className="flex justify-end gap-2 mt-3">
          <button onClick={onCancel} className="text-xs px-3 py-1.5 rounded border border-[#30363d] text-gray-400 hover:text-white">Cancel</button>
          <button onClick={() => { if (msg.trim()) onSend(msg.trim()); }}
            className="text-xs px-3 py-1.5 rounded bg-[#238636] text-white hover:bg-[#2ea043]">Send</button>
        </div>
      </div>
    </div>
  );
}

// ─── Run Prompt Dialog ───────────────────────────────────

function RunPromptDialog({ agentLabel, onRun, onCancel }: {
  agentLabel: string;
  onRun: (input: string) => void;
  onCancel: () => void;
}) {
  const [input, setInput] = useState('');
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.75)' }}
      onClick={e => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="w-[460px] rounded-lg border border-[#30363d] p-4 shadow-xl" style={{ background: '#0d1117' }}>
        <div className="text-sm font-bold text-white mb-1">Run {agentLabel}</div>
        <div className="text-[9px] text-gray-500 mb-3">Describe the task or requirements. This will be the initial input for the agent.</div>
        <textarea value={input} onChange={e => setInput(e.target.value)} rows={5} autoFocus
          placeholder="e.g. Build a REST API for user management with login, registration, and profile endpoints. Use Express + TypeScript + PostgreSQL."
          className="w-full text-xs bg-[#161b22] border border-[#30363d] rounded px-2 py-1.5 text-white focus:outline-none focus:border-[#58a6ff] resize-none" />
        <div className="flex items-center justify-between mt-3">
          <span className="text-[8px] text-gray-600">Leave empty to run without specific input</span>
          <div className="flex gap-2">
            <button onClick={onCancel} className="text-xs px-3 py-1.5 rounded border border-[#30363d] text-gray-400 hover:text-white">Cancel</button>
            <button onClick={() => onRun(input.trim())}
              className="text-xs px-3 py-1.5 rounded bg-[#238636] text-white hover:bg-[#2ea043]">▶ Run</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Log Panel (overlay) ─────────────────────────────────

/** Format log content: handle \n, truncate long text, detect JSON */
function LogContent({ content }: { content: string }) {
  if (!content) return null;
  const MAX_LINES = 30;
  const MAX_CHARS = 3000;

  let text = content;

  // Try to parse JSON and extract readable content
  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text);
      // Tool result with content field
      if (parsed.content) text = String(parsed.content);
      else text = JSON.stringify(parsed, null, 2);
    } catch {
      // Not valid JSON, keep as-is
    }
  }

  // Truncate
  const lines = text.split('\n');
  const truncatedLines = lines.length > MAX_LINES;
  const truncatedChars = text.length > MAX_CHARS;
  if (truncatedLines) text = lines.slice(0, MAX_LINES).join('\n');
  if (truncatedChars) text = text.slice(0, MAX_CHARS);
  const truncated = truncatedLines || truncatedChars;

  return (
    <span className="break-all">
      <pre className="whitespace-pre-wrap text-[10px] leading-relaxed inline">{text}</pre>
      {truncated && <span className="text-gray-600 text-[9px]"> ...({lines.length} lines)</span>}
    </span>
  );
}

function LogPanel({ agentId, agentLabel, workspaceId, onClose }: {
  agentId: string; agentLabel: string; workspaceId: string; onClose: () => void;
}) {
  const [logs, setLogs] = useState<any[]>([]);
  const [filter, setFilter] = useState<'all' | 'messages' | 'summaries'>('all');
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Read persistent logs from logs.jsonl (not in-memory state history)
    fetch(`/api/workspace/${workspaceId}/smith`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'logs', agentId }),
    }).then(r => r.json()).then(data => {
      if (data.logs?.length) setLogs(data.logs);
    }).catch(() => {});
  }, [workspaceId, agentId]);

  useEffect(() => {
    scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight);
  }, [logs, filter]);

  const filteredLogs = filter === 'all' ? logs :
    filter === 'messages' ? logs.filter((e: any) => e.subtype === 'bus_message' || e.subtype === 'revalidation_request' || e.subtype === 'user_message') :
    logs.filter((e: any) => e.subtype === 'step_summary' || e.subtype === 'final_summary');

  const msgCount = logs.filter((e: any) => e.subtype === 'bus_message' || e.subtype === 'revalidation_request' || e.subtype === 'user_message').length;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.85)' }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="flex flex-col rounded-xl overflow-hidden shadow-2xl" style={{ width: '75vw', height: '65vh', border: '1px solid #30363d', background: '#0d1117' }}>
        <div className="flex items-center gap-2 px-4 py-2 border-b border-[#30363d] shrink-0">
          <span className="text-sm font-bold text-white">Logs: {agentLabel}</span>
          <span className="text-[9px] text-gray-500">{filteredLogs.length}/{logs.length}</span>
          {/* Filter tabs */}
          <div className="flex gap-1 ml-3">
            {([['all', 'All'], ['messages', `📨 Messages${msgCount > 0 ? ` (${msgCount})` : ''}`], ['summaries', '📊 Summaries']] as const).map(([key, label]) => (
              <button key={key} onClick={() => setFilter(key as any)}
                className={`text-[8px] px-2 py-0.5 rounded ${filter === key ? 'bg-[#21262d] text-white' : 'text-gray-500 hover:text-gray-300'}`}>
                {label}
              </button>
            ))}
          </div>
          <button onClick={async () => {
            await fetch(`/api/workspace/${workspaceId}/smith`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action: 'clear_logs', agentId }),
            });
            setLogs([]);
          }} className="text-[8px] text-gray-500 hover:text-red-400 ml-auto mr-2">Clear</button>
          <button onClick={onClose} className="text-gray-500 hover:text-white text-sm">✕</button>
        </div>
        <div ref={scrollRef} className="flex-1 overflow-auto p-3 font-mono text-[11px] space-y-0.5">
          {filteredLogs.length === 0 && <div className="text-gray-600 text-center mt-8">{filter === 'all' ? 'No logs yet' : 'No matching entries'}</div>}
          {filteredLogs.map((entry, i) => {
            const isSummary = entry.subtype === 'step_summary' || entry.subtype === 'final_summary';
            const isBusMsg = entry.subtype === 'bus_message' || entry.subtype === 'revalidation_request' || entry.subtype === 'user_message';
            return (
              <div key={i} className={`${
                isSummary ? 'my-1 px-2 py-1.5 rounded border border-[#21262d] text-[#58a6ff] bg-[#161b22]' :
                isBusMsg ? 'my-0.5 px-2 py-1 rounded border border-[#f0883e30] text-[#f0883e] bg-[#f0883e08]' :
                'flex gap-2 ' + (
                  entry.type === 'system' ? 'text-gray-600' :
                  entry.type === 'result' ? 'text-green-400' : 'text-gray-300'
                )
              }`}>
                {isSummary ? (
                  <pre className="whitespace-pre-wrap text-[10px] leading-relaxed">{entry.content}</pre>
                ) : isBusMsg ? (
                  <div className="text-[10px] flex items-center gap-2">
                    <span>📨</span>
                    <span className="text-[8px] text-gray-500">{entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString() : ''}</span>
                    <span>{entry.content}</span>
                  </div>
                ) : (
                  <>
                    <span className="text-[8px] text-gray-600 shrink-0 w-16">{entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString() : ''}</span>
                    {entry.tool && <span className="text-yellow-500 shrink-0">[{entry.tool}]</span>}
                    <LogContent content={entry.content} />
                  </>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ─── Memory Panel ────────────────────────────────────────

const TYPE_COLORS: Record<string, string> = {
  decision: 'text-yellow-400', bugfix: 'text-red-400', feature: 'text-green-400',
  refactor: 'text-cyan-400', discovery: 'text-purple-400', change: 'text-gray-400', session: 'text-blue-400',
};

function MemoryPanel({ agentId, agentLabel, workspaceId, onClose }: {
  agentId: string; agentLabel: string; workspaceId: string; onClose: () => void;
}) {
  const [data, setData] = useState<any>(null);

  useEffect(() => {
    fetch(`/api/workspace/${workspaceId}/memory?agentId=${encodeURIComponent(agentId)}`)
      .then(r => r.json()).then(setData).catch(() => {});
  }, [workspaceId, agentId]);

  const stats = data?.stats;
  const display: any[] = data?.display || [];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.85)' }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="flex flex-col rounded-xl overflow-hidden shadow-2xl" style={{ width: '70vw', height: '65vh', border: '1px solid #30363d', background: '#0d1117' }}>
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-2 border-b border-[#30363d] shrink-0">
          <span className="text-sm">🧠</span>
          <span className="text-sm font-bold text-white">Memory: {agentLabel}</span>
          {stats && (
            <span className="text-[9px] text-gray-500">
              {stats.totalObservations} observations, {stats.totalSessions} sessions
              {stats.lastUpdated && ` · last updated ${new Date(stats.lastUpdated).toLocaleString()}`}
            </span>
          )}
          <button onClick={onClose} className="text-gray-500 hover:text-white text-sm ml-auto">✕</button>
        </div>

        {/* Stats bar */}
        {stats?.typeBreakdown && Object.keys(stats.typeBreakdown).length > 0 && (
          <div className="flex items-center gap-3 px-4 py-1.5 border-b border-[#21262d] text-[9px]">
            {Object.entries(stats.typeBreakdown).map(([type, count]) => (
              <span key={type} className={TYPE_COLORS[type] || 'text-gray-400'}>
                {type}: {count as number}
              </span>
            ))}
          </div>
        )}

        {/* Entries */}
        <div className="flex-1 overflow-auto p-3 space-y-1.5">
          {display.length === 0 && (
            <div className="text-gray-600 text-center mt-8">No memory yet. Run this agent to build memory.</div>
          )}
          {display.map((entry: any) => (
            <div key={entry.id} className={`rounded px-3 py-2 ${entry.isCompact ? 'opacity-60' : ''}`}
              style={{ background: '#161b22', border: '1px solid #21262d' }}>
              <div className="flex items-center gap-2">
                <span className="text-[10px]">{entry.icon}</span>
                <span className={`text-[9px] font-medium ${TYPE_COLORS[entry.type] || 'text-gray-400'}`}>{entry.type}</span>
                <span className="text-[10px] text-white flex-1 truncate">{entry.title}</span>
                <span className="text-[8px] text-gray-600 shrink-0">
                  {new Date(entry.timestamp).toLocaleString()}
                </span>
              </div>
              {!entry.isCompact && entry.subtitle && (
                <div className="text-[9px] text-gray-500 mt-1">{entry.subtitle}</div>
              )}
              {!entry.isCompact && entry.facts && entry.facts.length > 0 && (
                <div className="mt-1 space-y-0.5">
                  {entry.facts.map((f: string, i: number) => (
                    <div key={i} className="text-[8px] text-gray-500">• {f}</div>
                  ))}
                </div>
              )}
              {entry.files && entry.files.length > 0 && (
                <div className="text-[8px] text-gray-600 mt-1">
                  Files: {entry.files.join(', ')}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Bus Message Panel ───────────────────────────────────

// ─── Agent Inbox/Outbox Panel ────────────────────────────

function InboxPanel({ agentId, agentLabel, busLog, agents, workspaceId, onClose }: {
  agentId: string; agentLabel: string; busLog: any[]; agents: AgentConfig[]; workspaceId: string; onClose: () => void;
}) {
  const labelMap = new Map(agents.map(a => [a.id, `${a.icon} ${a.label}`]));
  const getLabel = (id: string) => labelMap.get(id) || id;
  const [deletedIds, setDeletedIds] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Filter messages related to this agent, exclude locally deleted
  const inbox = busLog.filter(m => m.to === agentId && m.type !== 'ack' && !deletedIds.has(m.id));
  const outbox = busLog.filter(m => m.from === agentId && m.to !== '_system' && m.type !== 'ack' && !deletedIds.has(m.id));
  const [tab, setTab] = useState<'inbox' | 'outbox'>('inbox');
  const messages = tab === 'inbox' ? inbox : outbox;

  const handleDelete = async (msgId: string) => {
    await wsApi(workspaceId, 'delete_message', { messageId: msgId });
    setDeletedIds(prev => new Set(prev).add(msgId));
  };

  const toggleSelect = (msgId: string) => {
    setSelected(prev => { const s = new Set(prev); s.has(msgId) ? s.delete(msgId) : s.add(msgId); return s; });
  };

  const selectAll = () => {
    const deletable = messages.filter(m => m.status === 'done' || m.status === 'failed');
    setSelected(new Set(deletable.map(m => m.id)));
  };

  const handleBatchDelete = async () => {
    for (const id of selected) {
      await wsApi(workspaceId, 'delete_message', { messageId: id });
      setDeletedIds(prev => new Set(prev).add(id));
    }
    setSelected(new Set());
  };

  const handleAbortAllPending = async () => {
    const pendingMsgs = messages.filter(m => m.status === 'pending');
    await Promise.all(pendingMsgs.map(m =>
      wsApi(workspaceId, 'abort_message', { messageId: m.id }).catch(() => {})
    ));
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.85)' }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="flex flex-col rounded-xl overflow-hidden shadow-2xl" style={{ width: '60vw', height: '50vh', border: '1px solid #30363d', background: '#0d1117' }}>
        <div className="flex items-center gap-2 px-4 py-2 border-b border-[#30363d] shrink-0">
          <span className="text-sm">📨</span>
          <span className="text-sm font-bold text-white">{agentLabel}</span>
          <div className="flex gap-1 ml-3">
            <button onClick={() => setTab('inbox')}
              className={`text-[9px] px-2 py-0.5 rounded ${tab === 'inbox' ? 'bg-[#21262d] text-white' : 'text-gray-500 hover:text-gray-300'}`}>
              Inbox ({inbox.length})
            </button>
            <button onClick={() => setTab('outbox')}
              className={`text-[9px] px-2 py-0.5 rounded ${tab === 'outbox' ? 'bg-[#21262d] text-white' : 'text-gray-500 hover:text-gray-300'}`}>
              Outbox ({outbox.length})
            </button>
          </div>
          {selected.size > 0 && (
            <div className="flex items-center gap-2 ml-3">
              <span className="text-[9px] text-gray-400">{selected.size} selected</span>
              <button onClick={handleBatchDelete}
                className="text-[8px] px-2 py-0.5 rounded bg-red-600/20 text-red-400 hover:bg-red-600/30">
                Delete selected
              </button>
              <button onClick={() => setSelected(new Set())}
                className="text-[8px] px-2 py-0.5 rounded bg-gray-600/20 text-gray-400 hover:bg-gray-600/30">
                Clear
              </button>
            </div>
          )}
          {selected.size === 0 && (
            <div className="flex items-center gap-2 ml-3">
              {messages.some(m => m.status === 'done' || m.status === 'failed') && (
                <button onClick={selectAll}
                  className="text-[8px] px-2 py-0.5 rounded text-gray-500 hover:text-gray-300">
                  Select all completed
                </button>
              )}
              {messages.some(m => m.status === 'pending') && (
                <button onClick={handleAbortAllPending}
                  className="text-[8px] px-2 py-0.5 rounded bg-red-600/20 text-red-400 hover:bg-red-600/30">
                  Abort all pending ({messages.filter(m => m.status === 'pending').length})
                </button>
              )}
            </div>
          )}
          <button onClick={onClose} className="text-gray-500 hover:text-white text-sm ml-auto">✕</button>
        </div>
        <div className="flex-1 overflow-auto p-3 space-y-1.5">
          {messages.length === 0 && (
            <div className="text-gray-600 text-center mt-8">No {tab} messages</div>
          )}
          {[...messages].reverse().map((msg, i) => {
            const isTicket = msg.category === 'ticket';
            const canSelect = msg.status === 'done' || msg.status === 'failed';
            return (
            <div key={i} className="flex items-start gap-2 px-3 py-2 rounded text-[10px]" style={{
              background: '#161b22',
              border: `1px solid ${isTicket ? '#6e40c9' : '#21262d'}`,
              borderLeft: isTicket ? '3px solid #a371f7' : undefined,
            }}>
              {canSelect && (
                <input type="checkbox" checked={selected.has(msg.id)} onChange={() => toggleSelect(msg.id)}
                  className="mt-1 shrink-0 accent-[#58a6ff]" />
              )}
              <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1 flex-wrap">
                <span className="text-[8px] text-gray-600">{new Date(msg.timestamp).toLocaleString()}</span>
                {tab === 'inbox' ? (
                  <span className="text-blue-400">← {getLabel(msg.from)}</span>
                ) : (
                  <span className="text-green-400">→ {getLabel(msg.to)}</span>
                )}
                {/* Category badge */}
                {isTicket && (
                  <span className="px-1 py-0.5 rounded text-[7px] bg-purple-500/20 text-purple-400">TICKET</span>
                )}
                {/* Action badge */}
                <span className={`px-1.5 py-0.5 rounded text-[8px] ${
                  msg.payload?.action === 'fix_request' || msg.payload?.action === 'bug_report' ? 'bg-red-500/20 text-red-400' :
                  msg.payload?.action === 'update_notify' || msg.payload?.action === 'request_complete' ? 'bg-blue-500/20 text-blue-400' :
                  msg.payload?.action === 'question' ? 'bg-yellow-500/20 text-yellow-400' :
                  'bg-gray-500/20 text-gray-400'
                }`}>{msg.payload?.action}</span>
                {/* Ticket status */}
                {isTicket && msg.ticketStatus && (
                  <span className={`text-[7px] px-1 rounded ${
                    msg.ticketStatus === 'open' ? 'bg-yellow-500/20 text-yellow-400' :
                    msg.ticketStatus === 'in_progress' ? 'bg-blue-500/20 text-blue-400' :
                    msg.ticketStatus === 'fixed' ? 'bg-green-500/20 text-green-400' :
                    msg.ticketStatus === 'verified' ? 'bg-green-600/20 text-green-300' :
                    msg.ticketStatus === 'closed' ? 'bg-gray-500/20 text-gray-400' :
                    'bg-gray-500/20 text-gray-400'
                  }`}>{msg.ticketStatus}</span>
                )}
                {/* Message delivery status */}
                <span className={`text-[7px] ${msg.status === 'done' ? 'text-green-500' : msg.status === 'running' ? 'text-blue-400' : msg.status === 'failed' ? 'text-red-500' : 'text-yellow-500'}`}>
                  {msg.status || 'pending'}
                </span>
                {/* Retry count for tickets */}
                {isTicket && (msg.ticketRetries || 0) > 0 && (
                  <span className="text-[7px] text-orange-400">retry {msg.ticketRetries}/{msg.maxRetries || 3}</span>
                )}
                {/* CausedBy trace */}
                {msg.causedBy && (
                  <span className="text-[7px] text-gray-600" title={`Triggered by message from ${getLabel(msg.causedBy.from)}`}>
                    ← {getLabel(msg.causedBy.from)}
                  </span>
                )}
                {/* Actions */}
                {msg.status === 'pending' && msg.type !== 'ack' && (
                  <button onClick={() => wsApi(workspaceId, 'abort_message', { messageId: msg.id })}
                    className="text-[7px] px-1.5 py-0.5 rounded bg-red-600/20 text-red-400 hover:bg-red-600/30 ml-auto">
                    ✕ Abort
                  </button>
                )}
                {(msg.status === 'done' || msg.status === 'failed') && msg.type !== 'ack' && (
                  <div className="flex gap-1 ml-auto">
                    <button onClick={() => wsApi(workspaceId, 'retry_message', { messageId: msg.id })}
                      className="text-[7px] px-1.5 py-0.5 rounded bg-orange-600/20 text-orange-400 hover:bg-orange-600/30">
                      {msg.status === 'done' ? '↻ Re-run' : '↻ Retry'}
                    </button>
                    <button onClick={() => handleDelete(msg.id)}
                      className="text-[7px] px-1.5 py-0.5 rounded bg-gray-600/20 text-gray-400 hover:bg-red-600/20 hover:text-red-400">
                      🗑
                    </button>
                  </div>
                )}
              </div>
              <div className="text-gray-300">{msg.payload?.content || ''}</div>
              {msg.payload?.files?.length > 0 && (
                <div className="text-[8px] text-gray-600 mt-1">Files: {msg.payload.files.join(', ')}</div>
              )}
              </div>
            </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function BusPanel({ busLog, agents, onClose }: {
  busLog: any[]; agents: AgentConfig[]; onClose: () => void;
}) {
  const labelMap = new Map(agents.map(a => [a.id, `${a.icon} ${a.label}`]));
  const getLabel = (id: string) => labelMap.get(id) || id;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.85)' }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="flex flex-col rounded-xl overflow-hidden shadow-2xl" style={{ width: '65vw', height: '55vh', border: '1px solid #30363d', background: '#0d1117' }}>
        <div className="flex items-center gap-2 px-4 py-2 border-b border-[#30363d] shrink-0">
          <span className="text-sm">📡</span>
          <span className="text-sm font-bold text-white">Agent Communication Logs</span>
          <span className="text-[9px] text-gray-500">{busLog.length} messages</span>
          <button onClick={onClose} className="text-gray-500 hover:text-white text-sm ml-auto">✕</button>
        </div>
        <div className="flex-1 overflow-auto p-3 space-y-1">
          {busLog.length === 0 && <div className="text-gray-600 text-center mt-8">No messages yet</div>}
          {[...busLog].reverse().map((msg, i) => (
            <div key={i} className="flex items-start gap-2 text-[10px] px-3 py-1.5 rounded"
              style={{ background: '#161b22', border: '1px solid #21262d' }}>
              <span className="text-gray-600 shrink-0 w-14">{new Date(msg.timestamp).toLocaleTimeString()}</span>
              <span className="text-blue-400 shrink-0">{getLabel(msg.from)}</span>
              <span className="text-gray-600">→</span>
              <span className="text-green-400 shrink-0">{msg.to === '_system' ? '📡 system' : getLabel(msg.to)}</span>
              <span className={`px-1 rounded text-[8px] ${
                msg.payload?.action === 'fix_request' ? 'bg-red-500/20 text-red-400' :
                msg.payload?.action === 'task_complete' ? 'bg-green-500/20 text-green-400' :
                msg.payload?.action === 'ack' ? 'bg-gray-500/20 text-gray-500' :
                'bg-blue-500/20 text-blue-400'
              }`}>{msg.payload?.action}</span>
              <span className="text-gray-400 truncate flex-1">{msg.payload?.content || ''}</span>
              {msg.status && msg.status !== 'done' && (
                <span className={`text-[7px] px-1 rounded ${
                  msg.status === 'done' ? 'text-green-500' : msg.status === 'failed' ? 'text-red-500' : 'text-yellow-500'
                }`}>{msg.status}</span>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Terminal Launch Dialog ───────────────────────────────

function TerminalLaunchDialog({ agent, workDir, sessName, projectPath, workspaceId, supportsSession, onLaunch, onCancel }: {
  agent: AgentConfig; workDir?: string; sessName: string; projectPath: string; workspaceId: string;
  supportsSession?: boolean;
  onLaunch: (resumeMode: boolean, sessionId?: string) => void; onCancel: () => void;
}) {
  const [sessions, setSessions] = useState<{ id: string; modified: string; size: number }[]>([]);
  const [showSessions, setShowSessions] = useState(false);
  // Use resolved supportsSession from API (defaults to true for backwards compat)
  const isClaude = supportsSession !== false;

  // Fetch recent sessions (only for claude-based agents)
  useEffect(() => {
    if (!isClaude) return;
    fetch(`/api/workspace/${workspaceId}/smith`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'sessions' }),
    }).then(r => r.json()).then(d => {
      if (d.sessions?.length) setSessions(d.sessions);
    }).catch(() => {});
  }, [workspaceId, isClaude]);

  const formatTime = (iso: string) => {
    const d = new Date(iso);
    const now = new Date();
    const diff = now.getTime() - d.getTime();
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    return d.toLocaleDateString();
  };

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1048576) return `${(bytes / 1024).toFixed(0)}KB`;
    return `${(bytes / 1048576).toFixed(1)}MB`;
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.75)' }}
      onClick={e => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="w-80 rounded-lg border border-[#30363d] p-4 shadow-xl" style={{ background: '#0d1117' }}>
        <div className="text-sm font-bold text-white mb-3">⌨️ {agent.label}</div>

        <div className="space-y-2">
          <button onClick={() => onLaunch(false)}
            className="w-full text-left px-3 py-2 rounded border border-[#30363d] hover:border-[#58a6ff] hover:bg-[#161b22] transition-colors">
            <div className="text-xs text-white font-semibold">{isClaude ? 'New Session' : 'Open Terminal'}</div>
            <div className="text-[9px] text-gray-500">{isClaude ? 'Start fresh claude session' : `Launch ${agent.agentId || 'agent'}`}</div>
          </button>

          {isClaude && sessions.length > 0 && (
            <button onClick={() => onLaunch(true)}
              className="w-full text-left px-3 py-2 rounded border border-[#30363d] hover:border-[#3fb950] hover:bg-[#161b22] transition-colors">
              <div className="text-xs text-white font-semibold">Resume Latest</div>
              <div className="text-[9px] text-gray-500">
                {sessions[0].id.slice(0, 8)} · {formatTime(sessions[0].modified)} · {formatSize(sessions[0].size)}
              </div>
            </button>
          )}

          {isClaude && sessions.length > 1 && (
            <button onClick={() => setShowSessions(!showSessions)}
              className="w-full text-[9px] text-gray-500 hover:text-white py-1">
              {showSessions ? '▼' : '▶'} More sessions ({sessions.length - 1})
            </button>
          )}

          {showSessions && sessions.slice(1).map(s => (
            <button key={s.id} onClick={() => onLaunch(true, s.id)}
              className="w-full text-left px-3 py-1.5 rounded border border-[#21262d] hover:border-[#30363d] hover:bg-[#161b22] transition-colors">
              <div className="flex items-center gap-2">
                <span className="text-[9px] text-gray-400 font-mono">{s.id.slice(0, 8)}</span>
                <span className="text-[8px] text-gray-600">{formatTime(s.modified)}</span>
                <span className="text-[8px] text-gray-600">{formatSize(s.size)}</span>
              </div>
            </button>
          ))}
        </div>

        <button onClick={onCancel}
          className="w-full mt-3 text-[9px] text-gray-500 hover:text-white">Cancel</button>
      </div>
    </div>
  );
}

// ─── Floating Terminal ────────────────────────────────────

function getWsUrl() {
  if (typeof window === 'undefined') return 'ws://localhost:8404';
  const p = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const h = window.location.hostname;
  if (h !== 'localhost' && h !== '127.0.0.1') return `${p}//${window.location.host}/terminal-ws`;
  const port = parseInt(window.location.port) || 8403;
  return `${p}//${h}:${port + 1}`;
}

function FloatingTerminal({ agentLabel, agentIcon, projectPath, agentCliId, cliCmd: cliCmdProp, cliType, workDir, preferredSessionName, existingSession, resumeMode, resumeSessionId, profileEnv, onSessionReady, onClose }: {
  agentLabel: string;
  agentIcon: string;
  projectPath: string;
  agentCliId: string;
  cliCmd?: string;               // resolved CLI binary (claude/codex/aider)
  cliType?: string;              // claude-code/codex/aider/generic
  workDir?: string;
  preferredSessionName?: string;
  existingSession?: string;
  resumeMode?: boolean;
  resumeSessionId?: string;
  profileEnv?: Record<string, string>;
  onSessionReady?: (name: string) => void;
  onClose: (killSession: boolean) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const sessionNameRef = useRef('');
  const [pos, setPos] = useState({ x: 80, y: 60 });
  const [size, setSize] = useState({ w: 750, h: 450 });
  const [showCloseDialog, setShowCloseDialog] = useState(false);
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);
  const resizeRef = useRef<{ startX: number; startY: number; origW: number; origH: number } | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let disposed = false;

    // Dynamic import xterm to avoid SSR issues
    Promise.all([
      import('@xterm/xterm'),
      import('@xterm/addon-fit'),
    ]).then(([{ Terminal }, { FitAddon }]) => {
      if (disposed) return;

      const term = new Terminal({
        cursorBlink: true, fontSize: 13,
        fontFamily: 'Menlo, Monaco, "Courier New", monospace',
        scrollback: 5000,
        theme: { background: '#0d1117', foreground: '#c9d1d9', cursor: '#58a6ff' },
      });
      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.open(el);
      setTimeout(() => { try { fitAddon.fit(); } catch {} }, 100);

      const ro = new ResizeObserver(() => { try { fitAddon.fit(); } catch {} });
      ro.observe(el);

      // Connect WebSocket — attach to existing or create new
      const ws = new WebSocket(getWsUrl());
      wsRef.current = ws;
      ws.onopen = () => {
        if (existingSession) {
          ws.send(JSON.stringify({ type: 'attach', sessionName: existingSession, cols: term.cols, rows: term.rows }));
        } else {
          // Use fixed session name so it survives refresh/suspend
          ws.send(JSON.stringify({ type: 'create', sessionName: preferredSessionName, cols: term.cols, rows: term.rows }));
        }
      };

      ws.onerror = () => {
        if (!disposed) term.write('\r\n\x1b[91m[Connection error]\x1b[0m\r\n');
      };
      ws.onclose = () => {
        if (!disposed) term.write('\r\n\x1b[90m[Disconnected]\x1b[0m\r\n');
      };

      let launched = false;
      ws.onmessage = (event) => {
        if (disposed) return;
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'output') { try { term.write(msg.data); } catch {} }
          else if (msg.type === 'error') {
            // Session no longer exists — fall back to creating a new one
            if (msg.message?.includes('no longer exists') || msg.message?.includes('not found')) {
              term.write(`\r\n\x1b[93m[Session lost — creating new one]\x1b[0m\r\n`);
              ws.send(JSON.stringify({ type: 'create', cols: term.cols, rows: term.rows }));
              // Clear existing session so next connected triggers CLI launch
              (existingSession as any) = undefined;
            } else {
              term.write(`\r\n\x1b[91m[${msg.message || 'error'}]\x1b[0m\r\n`);
            }
          }
          else if (msg.type === 'connected') {
            if (msg.sessionName) {
              sessionNameRef.current = msg.sessionName;
              // Save session name (on create or if session changed after fallback)
              onSessionReady?.(msg.sessionName);
            }
            if (launched) return;
            launched = true;
            if (existingSession) {
              // Force terminal redraw for attached session
              setTimeout(() => {
                if (!disposed && ws.readyState === WebSocket.OPEN) {
                  ws.send(JSON.stringify({ type: 'resize', cols: term.cols - 1, rows: term.rows }));
                  setTimeout(() => {
                    if (!disposed && ws.readyState === WebSocket.OPEN)
                      ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
                  }, 50);
                }
              }, 200);
              return;
            }
            const targetDir = workDir ? `${projectPath}/${workDir}` : projectPath;
            const cli = cliCmdProp || 'claude';

            const cdCmd = `mkdir -p "${targetDir}" && cd "${targetDir}"`;
            const isClaude = (cliType || 'claude-code') === 'claude-code';
            const resumeFlag = isClaude
              ? (resumeSessionId ? ` --resume ${resumeSessionId}` : resumeMode ? ' -c' : '')
              : '';
            const modelFlag = isClaude && profileEnv?.CLAUDE_MODEL ? ` --model ${profileEnv.CLAUDE_MODEL}` : '';
            // Remove CLAUDE_MODEL from env exports (passed via --model flag instead)
            const envWithoutModel = profileEnv ? Object.fromEntries(
              Object.entries(profileEnv).filter(([k]) => k !== 'CLAUDE_MODEL')
            ) : {};
            const envExportsClean = Object.keys(envWithoutModel).length > 0
              ? Object.entries(envWithoutModel).map(([k, v]) => `export ${k}="${v}"`).join(' && ') + ' && '
              : '';
            const cmd = `${envExportsClean}${cdCmd} && ${cli}${resumeFlag}${modelFlag}\n`;
            setTimeout(() => {
              if (!disposed && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input', data: cmd }));
            }, 300);
          }
        } catch {}
      };

      term.onData(data => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input', data }));
      });
      term.onResize(({ cols, rows }) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resize', cols, rows }));
      });

      return () => {
        disposed = true;
        ro.disconnect();
        ws.close();
        term.dispose();
      };
    });

    return () => { disposed = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div
      className="fixed z-50 bg-[#0d1117] border border-[#30363d] rounded-lg shadow-2xl flex flex-col overflow-hidden"
      style={{ left: pos.x, top: pos.y, width: size.w, height: size.h }}
    >
      {/* Draggable header */}
      <div
        className="flex items-center gap-2 px-3 py-1.5 bg-[#161b22] border-b border-[#30363d] cursor-move shrink-0 select-none"
        onMouseDown={(e) => {
          e.preventDefault();
          dragRef.current = { startX: e.clientX, startY: e.clientY, origX: pos.x, origY: pos.y };
          const onMove = (ev: MouseEvent) => {
            if (!dragRef.current) return;
            setPos({ x: Math.max(0, dragRef.current.origX + ev.clientX - dragRef.current.startX), y: Math.max(0, dragRef.current.origY + ev.clientY - dragRef.current.startY) });
          };
          const onUp = () => { dragRef.current = null; window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
          window.addEventListener('mousemove', onMove);
          window.addEventListener('mouseup', onUp);
        }}
      >
        <span className="text-sm">{agentIcon}</span>
        <span className="text-[11px] font-semibold text-white">{agentLabel}</span>
        <span className="text-[8px] text-gray-500">⌨️ manual terminal</span>
        <button onClick={() => setShowCloseDialog(true)} className="ml-auto text-gray-500 hover:text-white text-sm">✕</button>
      </div>

      {/* Terminal */}
      <div ref={containerRef} className="flex-1 min-h-0" style={{ background: '#0d1117' }} />

      {/* Resize handle */}
      <div
        className="absolute bottom-0 right-0 w-4 h-4 cursor-se-resize"
        onMouseDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
          resizeRef.current = { startX: e.clientX, startY: e.clientY, origW: size.w, origH: size.h };
          const onMove = (ev: MouseEvent) => {
            if (!resizeRef.current) return;
            setSize({ w: Math.max(400, resizeRef.current.origW + ev.clientX - resizeRef.current.startX), h: Math.max(250, resizeRef.current.origH + ev.clientY - resizeRef.current.startY) });
          };
          const onUp = () => { resizeRef.current = null; window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
          window.addEventListener('mousemove', onMove);
          window.addEventListener('mouseup', onUp);
        }}
      >
        <svg viewBox="0 0 16 16" className="w-3 h-3 absolute bottom-0.5 right-0.5 text-gray-600">
          <path d="M14 14L8 14L14 8Z" fill="currentColor" />
        </svg>
      </div>

      {/* Close confirmation dialog */}
      {showCloseDialog && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50" onClick={() => setShowCloseDialog(false)}>
          <div className="bg-[#161b22] border border-[#30363d] rounded-lg p-4 shadow-xl max-w-sm" onClick={e => e.stopPropagation()}>
            <h3 className="text-sm font-semibold text-white mb-2">Close Terminal — {agentLabel}</h3>
            <p className="text-xs text-gray-400 mb-3">
              This agent has an active terminal session.
            </p>
            <div className="flex gap-2">
              <button onClick={() => { setShowCloseDialog(false); onClose(false); }}
                className="flex-1 px-3 py-1.5 text-[11px] rounded bg-[#2a2a4a] text-gray-300 hover:bg-[#3a3a5a] hover:text-white">
                Suspend
                <span className="block text-[9px] text-gray-500 mt-0.5">Session keeps running</span>
              </button>
              <button onClick={() => {
                setShowCloseDialog(false);
                if (wsRef.current?.readyState === WebSocket.OPEN && sessionNameRef.current) {
                  wsRef.current.send(JSON.stringify({ type: 'kill', sessionName: sessionNameRef.current }));
                }
                onClose(true);
              }}
                className="flex-1 px-3 py-1.5 text-[11px] rounded bg-red-500/20 text-red-400 hover:bg-red-500/30">
                Kill Session
                <span className="block text-[9px] text-red-400/60 mt-0.5">End session, back to auto</span>
              </button>
            </div>
            <button onClick={() => setShowCloseDialog(false)}
              className="w-full mt-2 px-3 py-1 text-[10px] text-gray-500 hover:text-gray-300">
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── ReactFlow Input Node ────────────────────────────────

interface InputNodeData {
  config: AgentConfig;
  state: AgentState;
  onSubmit: (content: string) => void;
  onEdit: () => void;
  onRemove: () => void;
  [key: string]: unknown;
}

function InputFlowNode({ data }: NodeProps<Node<InputNodeData>>) {
  const { config, state, onSubmit, onEdit, onRemove } = data;
  const isDone = state?.taskStatus === 'done';
  const [text, setText] = useState('');
  const entries = config.entries || [];

  return (
    <div className="w-60 flex flex-col rounded-lg select-none"
      style={{ border: `1px solid ${isDone ? '#58a6ff60' : '#30363d50'}`, background: '#0d1117',
        boxShadow: isDone ? '0 0 10px #58a6ff15' : 'none' }}>
      <Handle type="source" position={Position.Right} style={{ background: '#58a6ff', width: 8, height: 8, border: 'none' }} />

      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2" style={{ borderBottom: '1px solid #21262d' }}>
        <span className="text-sm">{config.icon || '📝'}</span>
        <span className="text-xs font-semibold text-white flex-1">{config.label || 'Input'}</span>
        {entries.length > 0 && <span className="text-[8px] text-gray-600">{entries.length}</span>}
        <div className="w-2 h-2 rounded-full" style={{ background: isDone ? '#58a6ff' : '#484f58', boxShadow: isDone ? '0 0 6px #58a6ff' : 'none' }} />
      </div>

      {/* History entries (scrollable, compact) */}
      {entries.length > 0 && (
        <div className="max-h-24 overflow-auto px-3 py-1.5 space-y-1" style={{ borderBottom: '1px solid #21262d' }}
          onPointerDown={e => e.stopPropagation()}>
          {entries.map((e, i) => (
            <div key={i} className={`text-[9px] leading-relaxed ${i === entries.length - 1 ? 'text-gray-300' : 'text-gray-600'}`}>
              <span className="text-[7px] text-gray-700 mr-1">#{i + 1}</span>
              {e.content.length > 80 ? e.content.slice(0, 80) + '…' : e.content}
            </div>
          ))}
        </div>
      )}

      {/* New input */}
      <div className="px-3 py-2">
        <textarea value={text} onChange={e => setText(e.target.value)} rows={2}
          placeholder={entries.length > 0 ? 'Add new requirement or change...' : 'Describe requirements...'}
          className="w-full text-[10px] bg-[#0d1117] border border-[#21262d] rounded px-2 py-1.5 text-gray-300 placeholder-gray-600 focus:outline-none focus:border-[#58a6ff]/50 resize-none"
          onPointerDown={e => e.stopPropagation()} />
      </div>

      {/* Actions */}
      <div className="flex items-center gap-1 px-2 py-1.5" style={{ borderTop: '1px solid #21262d' }}>
        <button onPointerDown={e => e.stopPropagation()} onClick={e => {
          e.stopPropagation();
          if (!text.trim()) return;
          onSubmit(text.trim());
          setText('');
        }}
          className="text-[9px] px-2 py-0.5 rounded bg-[#238636]/20 text-[#3fb950] hover:bg-[#238636]/30 disabled:opacity-30"
          disabled={!text.trim()}>
          {entries.length > 0 ? '+ Add' : '✓ Submit'}
        </button>
        <div className="flex-1" />
        <button onPointerDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); onRemove(); }}
          className="text-[9px] text-gray-700 hover:text-red-400 px-1">✕</button>
      </div>
    </div>
  );
}

// ─── ReactFlow Agent Node ────────────────────────────────

interface AgentNodeData {
  config: AgentConfig;
  state: AgentState;
  colorIdx: number;
  previewLines: string[];
  onRun: () => void;
  onPause: () => void;
  onStop: () => void;
  onRetry: () => void;
  onEdit: () => void;
  onRemove: () => void;
  onMessage: () => void;
  onApprove: () => void;
  onShowLog: () => void;
  onShowMemory: () => void;
  onShowInbox: () => void;
  onOpenTerminal: () => void;
  inboxPending?: number;
  inboxFailed?: number;
  [key: string]: unknown;
}

function AgentFlowNode({ data }: NodeProps<Node<AgentNodeData>>) {
  const { config, state, colorIdx, previewLines, onRun, onPause, onStop, onRetry, onEdit, onRemove, onMessage, onApprove, onShowLog, onShowMemory, onShowInbox, onOpenTerminal, inboxPending = 0, inboxFailed = 0 } = data;
  const c = COLORS[colorIdx % COLORS.length];
  const smithStatus = state?.smithStatus || 'down';
  const taskStatus = state?.taskStatus || 'idle';
  const mode = state?.mode || 'auto';
  const smithInfo = SMITH_STATUS[smithStatus] || SMITH_STATUS.down;
  const taskInfo = TASK_STATUS[taskStatus] || TASK_STATUS.idle;
  const currentStep = state?.currentStep;
  const step = currentStep !== undefined ? config.steps[currentStep] : undefined;
  const isApprovalPending = taskStatus === 'idle' && smithStatus === 'active'; // approximation, actual check would use approvalQueue

  return (
    <div className="w-52 flex flex-col rounded-lg select-none"
      style={{ border: `1px solid ${c.border}${taskStatus === 'running' ? '90' : '40'}`, background: c.bg,
        boxShadow: taskInfo.glow ? `0 0 12px ${taskInfo.color}25` : smithInfo.glow ? `0 0 8px ${smithInfo.color}15` : 'none' }}>
      <Handle type="target" position={Position.Left} style={{ background: c.accent, width: 8, height: 8, border: 'none' }} />
      <Handle type="source" position={Position.Right} style={{ background: c.accent, width: 8, height: 8, border: 'none' }} />

      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2">
        <span className="text-sm">{config.icon}</span>
        <div className="flex-1 min-w-0">
          <div className="text-xs font-semibold text-white truncate">{config.label}</div>
          <div className="text-[8px]" style={{ color: c.accent }}>{config.backend === 'api' ? config.provider || 'api' : config.agentId || 'cli'}</div>
        </div>
        {/* Status: smith + mode + task */}
        <div className="flex flex-col items-end gap-0.5">
          <div className="flex items-center gap-1">
            <div className="w-1.5 h-1.5 rounded-full" style={{ background: smithInfo.color, boxShadow: smithInfo.glow ? `0 0 4px ${smithInfo.color}` : 'none' }} />
            <span className="text-[7px]" style={{ color: smithInfo.color }}>{smithInfo.label}</span>
          </div>
          <div className="flex items-center gap-1">
            <div className="w-1.5 h-1.5 rounded-full" style={{ background: mode === 'manual' ? '#d2a8ff' : '#30363d' }} />
            <span className="text-[7px]" style={{ color: mode === 'manual' ? '#d2a8ff' : '#6e7681' }}>{mode}</span>
          </div>
          <div className="flex items-center gap-1">
            <div className="w-1.5 h-1.5 rounded-full" style={{ background: taskInfo.color, boxShadow: taskInfo.glow ? `0 0 4px ${taskInfo.color}` : 'none' }} />
            <span className="text-[7px]" style={{ color: taskInfo.color }}>{taskInfo.label}</span>
          </div>
          {config.watch?.enabled && (
            <div className="flex items-center gap-1">
              <span className="text-[7px]" style={{ color: (state as any)?.lastWatchAlert ? '#f0883e' : '#6e7681' }}>
                {(state as any)?.lastWatchAlert ? '👁 alert' : '👁 watching'}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Current step */}
      {step && taskStatus === 'running' && (
        <div className="px-3 pb-1 text-[8px] text-yellow-400/80" style={{ borderTop: `1px solid ${c.border}15` }}>
          Step {(currentStep || 0) + 1}/{config.steps.length}: {step.label}
        </div>
      )}

      {/* Error */}
      {state?.error && (
        <div className="px-3 pb-1 text-[8px] text-red-400 truncate" style={{ borderTop: `1px solid ${c.border}15` }}>
          {state.error}
        </div>
      )}

      {/* Preview lines */}
      {previewLines.length > 0 && (
        <div className="px-3 pb-2 space-y-0.5 cursor-pointer" style={{ borderTop: `1px solid ${c.border}15` }}
          onPointerDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); onShowLog(); }}>
          {previewLines.map((line, i) => (
            <div key={i} className="text-[8px] text-gray-500 font-mono truncate">{line}</div>
          ))}
        </div>
      )}

      {/* Inbox — prominent, shows pending/failed counts */}
      {(inboxPending > 0 || inboxFailed > 0) && (
        <div className="px-2 py-1" style={{ borderTop: `1px solid ${c.border}15` }}>
          <button onPointerDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); onShowInbox(); }}
            className="w-full text-[9px] px-2 py-1 rounded flex items-center justify-center gap-1.5 bg-orange-600/15 text-orange-400 hover:bg-orange-600/25 border border-orange-600/30">
            📨 Inbox
            {inboxPending > 0 && <span className="px-1 rounded-full bg-yellow-600/30 text-yellow-400 text-[8px]">{inboxPending} pending</span>}
            {inboxFailed > 0 && <span className="px-1 rounded-full bg-red-600/30 text-red-400 text-[8px]">{inboxFailed} failed</span>}
          </button>
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center gap-1 px-2 py-1.5" style={{ borderTop: `1px solid ${c.border}15` }}>
        {taskStatus === 'running' && (
          <button onPointerDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); onStop(); }}
            className="text-[9px] px-1.5 py-0.5 rounded bg-red-600/20 text-red-400 hover:bg-red-600/30">■ Stop</button>
        )}
        {/* Message button — send instructions to agent */}
        {smithStatus === 'active' && taskStatus !== 'running' && (
          <button onPointerDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); onMessage(); }}
            className="text-[9px] px-1.5 py-0.5 rounded bg-blue-600/20 text-blue-400 hover:bg-blue-600/30">💬 Message</button>
        )}
        <div className="flex-1" />
        {taskStatus !== 'running' && (
          <button onPointerDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); onOpenTerminal(); }}
            className="text-[9px] text-gray-600 hover:text-green-400 px-1" title="Open terminal (manual mode)">⌨️</button>
        )}
        <button onPointerDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); onShowInbox(); }}
          className="text-[9px] text-gray-600 hover:text-orange-400 px-1" title="Messages (inbox/outbox)">📨</button>
        <button onPointerDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); onShowMemory(); }}
          className="text-[9px] text-gray-600 hover:text-purple-400 px-1" title="Memory">🧠</button>
        <button onPointerDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); onShowLog(); }}
          className="text-[9px] text-gray-600 hover:text-gray-300 px-1" title="Logs">📋</button>
        <button onPointerDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); onEdit(); }}
          className="text-[9px] text-gray-600 hover:text-blue-400 px-1">✏️</button>
        <button onPointerDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); onRemove(); }}
          className="text-[9px] text-gray-600 hover:text-red-400 px-1">✕</button>
      </div>
    </div>
  );
}

const nodeTypes = { agent: AgentFlowNode, input: InputFlowNode };

// ─── Main Workspace ──────────────────────────────────────

export interface WorkspaceViewHandle {
  focusAgent: (agentId: string) => void;
}

function WorkspaceViewInner({ projectPath, projectName, onClose }: {
  projectPath: string;
  projectName: string;
  onClose: () => void;
}, ref: React.Ref<WorkspaceViewHandle>) {
  const reactFlow = useReactFlow();
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [rfNodes, setRfNodes] = useState<Node<any>[]>([]);
  const [modal, setModal] = useState<{ mode: 'add' | 'edit'; initial: Partial<AgentConfig>; editId?: string } | null>(null);
  const [messageTarget, setMessageTarget] = useState<{ id: string; label: string } | null>(null);
  const [logTarget, setLogTarget] = useState<{ id: string; label: string } | null>(null);
  const [runPromptTarget, setRunPromptTarget] = useState<{ id: string; label: string } | null>(null);
  const [userInputRequest, setUserInputRequest] = useState<{ agentId: string; fromAgent: string; question: string } | null>(null);
  const [memoryTarget, setMemoryTarget] = useState<{ id: string; label: string } | null>(null);
  const [inboxTarget, setInboxTarget] = useState<{ id: string; label: string } | null>(null);
  const [showBusPanel, setShowBusPanel] = useState(false);
  const [floatingTerminals, setFloatingTerminals] = useState<{ agentId: string; label: string; icon: string; cliId: string; cliCmd?: string; cliType?: string; workDir?: string; tmuxSession?: string; sessionName: string; resumeMode?: boolean; resumeSessionId?: string; profileEnv?: Record<string, string> }[]>([]);
  const [termLaunchDialog, setTermLaunchDialog] = useState<{ agent: AgentConfig; sessName: string; workDir?: string; sessions: string[]; supportsSession?: boolean } | null>(null);

  // Expose focusAgent to parent
  useImperativeHandle(ref, () => ({
    focusAgent(agentId: string) {
      const node = rfNodes.find(n => n.id === agentId);
      if (node && node.measured?.width) {
        reactFlow.setCenter(
          node.position.x + (node.measured.width / 2),
          node.position.y + ((node.measured.height || 100) / 2),
          { zoom: 1.2, duration: 400 }
        );
        // Flash highlight via selection
        reactFlow.setNodes(nodes => nodes.map(n => ({ ...n, selected: n.id === agentId })));
        setTimeout(() => {
          reactFlow.setNodes(nodes => nodes.map(n => ({ ...n, selected: false })));
        }, 1500);
      }
    },
  }), [rfNodes, reactFlow]);

  // Initialize workspace
  useEffect(() => {
    ensureWorkspace(projectPath, projectName).then(setWorkspaceId).catch(() => {});
  }, [projectPath, projectName]);

  // SSE stream — server is the single source of truth
  const { agents, states, logPreview, busLog, daemonActive: daemonActiveFromStream, setDaemonActive: setDaemonActiveFromStream } = useWorkspaceStream(workspaceId, (event) => {
    if (event.type === 'user_input_request') {
      setUserInputRequest(event);
    }
  });

  // Auto-open floating terminals for manual agents on page load
  const autoOpenDone = useRef(false);
  useEffect(() => {
    if (autoOpenDone.current || agents.length === 0 || Object.keys(states).length === 0) return;
    autoOpenDone.current = true;
    const manualAgents = agents.filter(a =>
      a.type !== 'input' && states[a.id]?.mode === 'manual' && states[a.id]?.tmuxSession
    );
    if (manualAgents.length > 0) {
      const safeName = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').slice(0, 20);
      setFloatingTerminals(manualAgents.map(a => ({
        agentId: a.id,
        label: a.label,
        icon: a.icon,
        cliId: a.agentId || 'claude',
        workDir: a.workDir && a.workDir !== './' && a.workDir !== '.' ? a.workDir : undefined,
        tmuxSession: states[a.id].tmuxSession,
        sessionName: `mw-forge-${safeName(projectName)}-${safeName(a.label)}`,
      })));
    }
  }, [agents, states]);

  // Rebuild nodes when agents/states/preview change — preserve existing positions + dimensions
  useEffect(() => {
    setRfNodes(prev => {
      const prevMap = new Map(prev.map(n => [n.id, n]));
      return agents.map((agent, i) => {
        const existing = prevMap.get(agent.id);
        const base = {
          id: agent.id,
          position: existing?.position ?? { x: i * 260, y: 60 },
          ...(existing?.measured ? { measured: existing.measured } : {}),
          ...(existing?.width ? { width: existing.width, height: existing.height } : {}),
        };

        // Input node
        if (agent.type === 'input') {
          return {
            ...base,
            type: 'input' as const,
            data: {
              config: agent,
              state: states[agent.id] || { smithStatus: 'down', mode: 'auto', taskStatus: 'idle', artifacts: [] },
              onSubmit: (content: string) => {
                // Optimistic update
                wsApi(workspaceId!, 'complete_input', { agentId: agent.id, content });
              },
              onEdit: () => setModal({ mode: 'edit', initial: agent, editId: agent.id }),
              onRemove: () => {
                if (!confirm(`Remove "${agent.label}"?`)) return;
                wsApi(workspaceId!, 'remove', { agentId: agent.id });
              },
            } satisfies InputNodeData,
          };
        }

        // Agent node
        return {
          ...base,
          type: 'agent' as const,
          data: {
            config: agent,
            state: states[agent.id] || { smithStatus: 'down', mode: 'auto', taskStatus: 'idle', artifacts: [] },
            colorIdx: i,
            previewLines: logPreview[agent.id] || [],
            onRun: () => {
              wsApi(workspaceId!, 'run', { agentId: agent.id });
            },
            onPause: () => wsApi(workspaceId!, 'pause', { agentId: agent.id }),
            onStop: () => wsApi(workspaceId!, 'stop', { agentId: agent.id }),
            onRetry: () => wsApi(workspaceId!, 'retry', { agentId: agent.id }),
            onEdit: () => setModal({ mode: 'edit', initial: agent, editId: agent.id }),
            onRemove: () => {
              if (!confirm(`Remove "${agent.label}"?`)) return;
              wsApi(workspaceId!, 'remove', { agentId: agent.id });
            },
            onMessage: () => setMessageTarget({ id: agent.id, label: agent.label }),
            onApprove: () => wsApi(workspaceId!, 'approve', { agentId: agent.id }),
            onShowLog: () => setLogTarget({ id: agent.id, label: agent.label }),
            onShowMemory: () => setMemoryTarget({ id: agent.id, label: agent.label }),
            onShowInbox: () => setInboxTarget({ id: agent.id, label: agent.label }),
            inboxPending: busLog.filter(m => m.to === agent.id && m.status === 'pending' && m.type !== 'ack').length,
            inboxFailed: busLog.filter(m => m.to === agent.id && m.status === 'failed' && m.type !== 'ack').length,
            onOpenTerminal: async () => {
              if (!workspaceId) return;
              // Use current state via setState callback to avoid stale closure
              let alreadyOpen = false;
              setFloatingTerminals(prev => { alreadyOpen = prev.some(t => t.agentId === agent.id); return prev; });
              if (alreadyOpen) return;

              const agentState = states[agent.id];
              const existingTmux = agentState?.tmuxSession;

              // Build fixed session name: mw-forge-{project}-{agentLabel}
              const safeName = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').slice(0, 20);
              const sessName = `mw-forge-${safeName(projectName)}-${safeName(agent.label)}`;
              const workDir = agent.workDir && agent.workDir !== './' && agent.workDir !== '.'
                ? agent.workDir : undefined;

              // If already manual with a tmux session, just reopen (attach)
              if (agentState?.mode === 'manual' && existingTmux) {
                setFloatingTerminals(prev => [...prev, {
                  agentId: agent.id, label: agent.label, icon: agent.icon,
                  cliId: agent.agentId || 'claude', workDir,
                  tmuxSession: existingTmux, sessionName: sessName,
                }]);
                return;
              }

              // Resolve terminal launch info to determine supportsSession
              const resolveRes = await wsApi(workspaceId, 'open_terminal', { agentId: agent.id, resolveOnly: true }).catch(() => ({})) as any;
              const supportsSession = resolveRes?.supportsSession ?? true;

              // Show launch dialog with resolved info
              setTermLaunchDialog({ agent, sessName, workDir, sessions: [], supportsSession });
            },
          } satisfies AgentNodeData,
        };
      });
    });
  }, [agents, states, logPreview, workspaceId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Derive edges from dependsOn
  const rfEdges = useMemo(() => {
    const edges: any[] = [];
    for (const agent of agents) {
      for (const depId of agent.dependsOn) {
        const depState = states[depId];
        const targetState = states[agent.id];
        const depTask = depState?.taskStatus || 'idle';
        const targetTask = targetState?.taskStatus || 'idle';
        const isFlowing = depTask === 'running' || targetTask === 'running';
        const isCompleted = depTask === 'done';
        const color = isFlowing ? '#58a6ff70' : isCompleted ? '#58a6ff40' : '#30363d60';

        // Find last bus message between these two agents
        const lastMsg = [...busLog].reverse().find(m =>
          (m.from === depId && m.to === agent.id) || (m.from === agent.id && m.to === depId)
        );
        const edgeLabel = lastMsg?.payload?.action && lastMsg.payload.action !== 'task_complete' && lastMsg.payload.action !== 'ack'
          ? `${lastMsg.payload.action}${lastMsg.payload.content ? ': ' + lastMsg.payload.content.slice(0, 30) : ''}`
          : undefined;

        edges.push({
          id: `${depId}-${agent.id}`,
          source: depId,
          target: agent.id,
          animated: isFlowing,
          label: edgeLabel,
          labelStyle: { fill: '#8b949e', fontSize: 8 },
          labelBgStyle: { fill: '#0d1117', fillOpacity: 0.8 },
          labelBgPadding: [4, 2] as [number, number],
          style: { stroke: color, strokeWidth: isFlowing ? 2 : isCompleted ? 1.5 : 1 },
          markerEnd: { type: MarkerType.ArrowClosed, color },
        });
      }
    }
    return edges;
  }, [agents, states]);

  // Let ReactFlow manage all node changes (position, dimensions, selection, etc.)
  const onNodesChange = useCallback((changes: NodeChange[]) => {
    setRfNodes(prev => applyNodeChanges(changes, prev) as Node<AgentNodeData>[]);
  }, []);

  const handleAddAgent = async (cfg: Omit<AgentConfig, 'id'>) => {
    if (!workspaceId) return;
    const config: AgentConfig = { ...cfg, id: `${cfg.label.toLowerCase().replace(/\s+/g, '-')}-${Date.now()}` };
    // Optimistic update — show immediately
    setModal(null);
    await wsApi(workspaceId, 'add', { config });
  };

  const handleEditAgent = async (cfg: Omit<AgentConfig, 'id'>) => {
    if (!workspaceId || !modal?.editId) return;
    const config: AgentConfig = { ...cfg, id: modal.editId };
    // Optimistic update
    setModal(null);
    await wsApi(workspaceId, 'update', { agentId: modal.editId, config });
  };

  const handleAddInput = async () => {
    if (!workspaceId) return;
    const config: AgentConfig = {
      id: `input-${Date.now()}`, label: 'Requirements', icon: '📝',
      type: 'input', content: '', entries: [], role: '', backend: 'cli',
      dependsOn: [], outputs: [], steps: [],
    };
    await wsApi(workspaceId, 'add', { config });
  };

  const handleCreatePipeline = async () => {
    if (!workspaceId) return;
    // Create pipeline via API — server uses presets with full prompts
    const res = await fetch(`/api/workspace/${workspaceId}/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'create_pipeline' }),
    });
    const data = await res.json();
    if (!res.ok && data.error) alert(`Error: ${data.error}`);
  };

  const handleExportTemplate = async () => {
    if (!workspaceId) return;
    try {
      const res = await fetch(`/api/workspace?export=${workspaceId}`);
      const template = await res.json();
      // Download as JSON file
      const blob = new Blob([JSON.stringify(template, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `workspace-template-${projectName.replace(/\s+/g, '-')}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      alert('Export failed');
    }
  };

  const handleImportTemplate = async (file: File) => {
    if (!workspaceId) return;
    try {
      const text = await file.text();
      const template = JSON.parse(text);
      await fetch('/api/workspace', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectPath, projectName, template }),
      });
      // Reload page to pick up new workspace
      window.location.reload();
    } catch {
      alert('Import failed — invalid template file');
    }
  };

  const handleRunAll = () => { if (workspaceId) wsApi(workspaceId, 'run_all'); };
  const handleStartDaemon = async () => {
    if (!workspaceId) return;
    const result = await wsApi(workspaceId, 'start_daemon');
    if (result.ok) setDaemonActiveFromStream(true);
  };
  const handleStopDaemon = async () => {
    if (!workspaceId) return;
    const result = await wsApi(workspaceId, 'stop_daemon');
    if (result.ok) setDaemonActiveFromStream(false);
  };

  return (
    <div className="flex-1 flex flex-col min-h-0" style={{ background: '#080810' }}>
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-[#2a2a3a] shrink-0">
        <button onClick={onClose} className="text-gray-400 hover:text-white text-sm">←</button>
        <span className="text-xs font-bold text-white">Workspace</span>
        <span className="text-[9px] text-gray-500">{projectName}</span>
        {agents.length > 0 && !daemonActiveFromStream && (
          <>
            <button onClick={handleRunAll}
              className="text-[8px] px-2 py-0.5 rounded bg-green-600/20 text-green-400 hover:bg-green-600/30 ml-2">
              ▶ Run All
            </button>
            <button onClick={handleStartDaemon}
              className="text-[8px] px-2 py-0.5 rounded bg-emerald-600/20 text-emerald-400 hover:bg-emerald-600/30">
              ⚡ Start Daemon
            </button>
          </>
        )}
        {daemonActiveFromStream && (
          <>
            <span className="text-[8px] px-2 py-0.5 rounded bg-green-600/30 text-green-400 ml-2 animate-pulse">
              ● Daemon Active
            </span>
            <button onClick={handleStopDaemon}
              className="text-[8px] px-2 py-0.5 rounded bg-red-600/20 text-red-400 hover:bg-red-600/30">
              ■ Stop
            </button>
          </>
        )}
        <div className="ml-auto flex items-center gap-2">
          <button onClick={() => setShowBusPanel(true)}
            className={`text-[8px] px-2 py-0.5 rounded border border-[#30363d] hover:border-[#58a6ff]/60 ${busLog.length > 0 ? 'text-[#58a6ff]' : 'text-gray-500'}`}>
            📡 Logs{busLog.length > 0 ? ` (${busLog.length})` : ''}
          </button>
          {agents.length > 0 && (
            <button onClick={handleExportTemplate}
              className="text-[8px] px-2 py-0.5 rounded border border-[#30363d] text-gray-500 hover:text-white hover:border-[#58a6ff]/60">
              📤 Export
            </button>
          )}
          <button onClick={handleAddInput}
            className="text-[8px] px-2 py-0.5 rounded border border-[#30363d] text-gray-400 hover:text-white hover:border-[#58a6ff]/60">
            📝 + Input
          </button>
          <button onClick={() => setModal({ mode: 'add', initial: {} })}
            className="text-[8px] px-2 py-0.5 rounded border border-[#30363d] text-gray-400 hover:text-white hover:border-[#58a6ff]/60">
            + Add Agent
          </button>
        </div>
      </div>

      {/* Graph area */}
      {agents.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-3">
          <span className="text-3xl">🚀</span>
          <div className="text-sm text-gray-400">Add agents to start</div>
          <div className="flex gap-2 mt-2 flex-wrap justify-center">
            {PRESET_AGENTS.map((p, i) => (
              <button key={i} onClick={() => setModal({ mode: 'add', initial: p })}
                className="text-[10px] px-3 py-1.5 rounded border border-[#30363d] text-gray-300 hover:text-white hover:border-[#58a6ff]/60 flex items-center gap-1">
                {p.icon} {p.label}
              </button>
            ))}
          </div>
          <div className="flex gap-2 mt-1">
            <button onClick={() => setModal({ mode: 'add', initial: {} })}
              className="text-[10px] px-3 py-1.5 rounded border border-dashed border-[#30363d] text-gray-500 hover:text-white hover:border-[#58a6ff]/60">
              ⚙️ Custom
            </button>
            <button onClick={handleCreatePipeline}
              className="text-[10px] px-3 py-1.5 rounded border border-[#238636] text-[#3fb950] hover:bg-[#238636]/20">
              🚀 Dev Pipeline
            </button>
            <label className="text-[10px] px-3 py-1.5 rounded border border-dashed border-[#30363d] text-gray-500 hover:text-white hover:border-[#58a6ff]/60 cursor-pointer">
              📥 Import
              <input type="file" accept=".json" className="hidden" onChange={e => {
                const file = e.target.files?.[0];
                if (file) handleImportTemplate(file);
                e.target.value = '';
              }} />
            </label>
          </div>
        </div>
      ) : (
        <div className="flex-1 min-h-0">
          <ReactFlow
            nodes={rfNodes}
            edges={rfEdges}
            onNodesChange={onNodesChange}
            nodeTypes={nodeTypes}
            fitView
            fitViewOptions={{ padding: 0.3 }}
            minZoom={0.3}
            maxZoom={2}
            proOptions={{ hideAttribution: true }}
          >
            <Background color="#1a1a2e" gap={20} size={1} />
            <Controls style={{ background: '#0d1117', border: '1px solid #30363d' }} showInteractive={false} />
          </ReactFlow>
        </div>
      )}

      {/* Config modal */}
      {modal && (
        <AgentConfigModal
          initial={modal.initial}
          mode={modal.mode}
          existingAgents={agents}
          projectPath={projectPath}
          onConfirm={modal.mode === 'add' ? handleAddAgent : handleEditAgent}
          onCancel={() => setModal(null)}
        />
      )}

      {/* Run prompt dialog (for agents with no dependencies) */}
      {runPromptTarget && workspaceId && (
        <RunPromptDialog
          agentLabel={runPromptTarget.label}
          onRun={input => {
            wsApi(workspaceId, 'run', { agentId: runPromptTarget.id, input: input || undefined });
            setRunPromptTarget(null);
          }}
          onCancel={() => setRunPromptTarget(null)}
        />
      )}

      {/* Message dialog */}
      {messageTarget && workspaceId && (
        <MessageDialog
          agentLabel={messageTarget.label}
          onSend={msg => {
            wsApi(workspaceId, 'message', { agentId: messageTarget.id, content: msg });
            setMessageTarget(null);
          }}
          onCancel={() => setMessageTarget(null)}
        />
      )}

      {/* Log panel */}
      {logTarget && workspaceId && (
        <LogPanel
          agentId={logTarget.id}
          agentLabel={logTarget.label}
          workspaceId={workspaceId}
          onClose={() => setLogTarget(null)}
        />
      )}

      {/* Bus message panel */}
      {showBusPanel && (
        <BusPanel busLog={busLog} agents={agents} onClose={() => setShowBusPanel(false)} />
      )}

      {/* Memory panel */}
      {memoryTarget && workspaceId && (
        <MemoryPanel
          agentId={memoryTarget.id}
          agentLabel={memoryTarget.label}
          workspaceId={workspaceId}
          onClose={() => setMemoryTarget(null)}
        />
      )}

      {/* Inbox panel */}
      {inboxTarget && workspaceId && (
        <InboxPanel
          agentId={inboxTarget.id}
          agentLabel={inboxTarget.label}
          busLog={busLog}
          agents={agents}
          workspaceId={workspaceId}
          onClose={() => setInboxTarget(null)}
        />
      )}

      {/* Terminal launch dialog */}
      {termLaunchDialog && workspaceId && (
        <TerminalLaunchDialog
          agent={termLaunchDialog.agent}
          workDir={termLaunchDialog.workDir}
          sessName={termLaunchDialog.sessName}
          projectPath={projectPath}
          workspaceId={workspaceId}
          supportsSession={termLaunchDialog.supportsSession}
          onLaunch={async (resumeMode, sessionId) => {
            const { agent, sessName, workDir } = termLaunchDialog;
            setTermLaunchDialog(null);
            const res = await wsApi(workspaceId, 'open_terminal', { agentId: agent.id });
            if (res.ok) {
              setFloatingTerminals(prev => [...prev, {
                agentId: agent.id, label: agent.label, icon: agent.icon,
                cliId: agent.agentId || 'claude',
                cliCmd: res.cliCmd || 'claude',
                cliType: res.cliType || 'claude-code',
                workDir,
                sessionName: sessName, resumeMode, resumeSessionId: sessionId,
                profileEnv: {
                  ...(res.env || {}),
                  ...(res.model ? { CLAUDE_MODEL: res.model } : {}),
                  FORGE_AGENT_ID: agent.id,
                  FORGE_WORKSPACE_ID: workspaceId,
                  FORGE_PORT: String(window.location.port || 8403),
                },
              }]);
            }
          }}
          onCancel={() => setTermLaunchDialog(null)}
        />
      )}

      {/* Floating terminals for manual agents */}
      {floatingTerminals.map(ft => (
        <FloatingTerminal
          key={ft.agentId}
          agentLabel={ft.label}
          agentIcon={ft.icon}
          projectPath={projectPath}
          agentCliId={ft.cliId}
          cliCmd={ft.cliCmd}
          cliType={ft.cliType}
          workDir={ft.workDir}
          preferredSessionName={ft.sessionName}
          existingSession={ft.tmuxSession}
          resumeMode={ft.resumeMode}
          resumeSessionId={ft.resumeSessionId}
          profileEnv={ft.profileEnv}
          onSessionReady={(name) => {
            if (workspaceId) {
              wsApi(workspaceId, 'set_tmux_session', { agentId: ft.agentId, sessionName: name });
            }
            setFloatingTerminals(prev => prev.map(t => t.agentId === ft.agentId ? { ...t, tmuxSession: name } : t));
          }}
          onClose={() => {
            setFloatingTerminals(prev => prev.filter(t => t.agentId !== ft.agentId));
            if (workspaceId) {
              wsApi(workspaceId, 'close_terminal', { agentId: ft.agentId });
            }
          }}
        />
      ))}

      {/* User input request from agent (via bus) */}
      {userInputRequest && workspaceId && (
        <RunPromptDialog
          agentLabel={`${agents.find(a => a.id === userInputRequest.fromAgent)?.label || 'Agent'} asks`}
          onRun={input => {
            // Send response to the requesting agent's target (Input node)
            wsApi(workspaceId, 'complete_input', {
              agentId: userInputRequest.agentId,
              content: input || userInputRequest.question,
            });
            setUserInputRequest(null);
          }}
          onCancel={() => setUserInputRequest(null)}
        />
      )}
    </div>
  );
}

const WorkspaceViewWithRef = forwardRef(WorkspaceViewInner);

// Wrap with ReactFlowProvider so useReactFlow works
export default forwardRef<WorkspaceViewHandle, { projectPath: string; projectName: string; onClose: () => void }>(
  function WorkspaceView(props, ref) {
    return (
      <ReactFlowProvider>
        <WorkspaceViewWithRef {...props} ref={ref} />
      </ReactFlowProvider>
    );
  }
);
