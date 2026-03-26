'use client';

import { useState, useEffect, useCallback, useMemo, useRef, forwardRef, useImperativeHandle } from 'react';
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
  dependsOn: string[]; outputs: string[];
  steps: { id: string; label: string; prompt: string }[];
  requiresApproval?: boolean;
}

interface AgentState {
  status: string; currentStep?: number;
  artifacts: { type: string; path?: string; summary?: string }[];
  error?: string; lastCheckpoint?: number;
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

const STATUS_MAP: Record<string, { label: string; color: string; glow?: boolean }> = {
  idle: { label: 'idle', color: '#30363d' },
  running: { label: 'running', color: '#3fb950', glow: true },
  paused: { label: 'paused', color: '#d29922' },
  waiting_approval: { label: 'waiting', color: '#d29922', glow: true },
  done: { label: 'done', color: '#58a6ff' },
  failed: { label: 'failed', color: '#f85149' },
  interrupted: { label: 'interrupted', color: '#8b949e' },
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
          return;
        }

        if (event.type === 'status') {
          setStates(prev => ({
            ...prev,
            [event.agentId]: {
              ...prev[event.agentId],
              status: event.status,
              // Clear error when status changes to non-error state
              ...(event.status !== 'failed' ? { error: undefined } : {}),
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
            [event.agentId]: { ...prev[event.agentId], status: 'failed', error: event.error },
          }));
        }

        if (event.type === 'bus_message') {
          setBusLog(prev => [...prev, event.message]);
        }

        // Server pushed updated agents list (after add/remove/update)
        if (event.type === 'agents_changed') {
          setAgents(event.agents || []);
        }

        // Forward special events to the component
        if (event.type === 'user_input_request' || event.type === 'workspace_complete') {
          onEventRef.current?.(event);
        }
      } catch {}
    };

    return () => es.close();
  }, [workspaceId]);

  return { agents, states, logPreview, busLog, setAgents };
}

// ─── Agent Config Modal ──────────────────────────────────

function AgentConfigModal({ initial, mode, existingAgents, onConfirm, onCancel }: {
  initial: Partial<AgentConfig>;
  mode: 'add' | 'edit';
  existingAgents: AgentConfig[];
  onConfirm: (cfg: Omit<AgentConfig, 'id'>) => void;
  onCancel: () => void;
}) {
  const [label, setLabel] = useState(initial.label || '');
  const [icon, setIcon] = useState(initial.icon || '🤖');
  const [role, setRole] = useState(initial.role || '');
  const [backend, setBackend] = useState<'api' | 'cli'>(initial.backend === 'api' ? 'api' : 'cli');
  const [agentId, setAgentId] = useState(initial.agentId || 'claude');
  const [outputs, setOutputs] = useState((initial.outputs || []).join(', '));
  const [selectedDeps, setSelectedDeps] = useState<Set<string>>(new Set(initial.dependsOn || []));
  const [stepsText, setStepsText] = useState(
    (initial.steps || []).map(s => `${s.label}: ${s.prompt}`).join('\n') || ''
  );

  const applyPreset = (p: Omit<AgentConfig, 'id'>) => {
    setLabel(p.label); setIcon(p.icon); setRole(p.role);
    setBackend(p.backend); setAgentId(p.agentId || 'claude');
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

          {/* Agent CLI */}
          {backend === 'cli' && (
            <div className="flex flex-col gap-1">
              <label className="text-[9px] text-gray-500 uppercase">Agent CLI</label>
              <div className="flex gap-1">
                {['claude', 'codex', 'aider'].map(cmd => (
                  <button key={cmd} onClick={() => setAgentId(cmd)}
                    className={`text-[9px] px-2 py-1 rounded border ${agentId === cmd ? 'border-[#58a6ff] text-[#58a6ff] bg-[#58a6ff]/10' : 'border-[#30363d] text-gray-400 hover:text-white'}`}>
                    {cmd}
                  </button>
                ))}
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

          {/* Outputs */}
          <div className="flex flex-col gap-1">
            <label className="text-[9px] text-gray-500 uppercase">Outputs (file paths)</label>
            <input value={outputs} onChange={e => setOutputs(e.target.value)} placeholder="docs/prd.md, src/"
              className="text-xs bg-[#161b22] border border-[#30363d] rounded px-2 py-1 text-white focus:outline-none focus:border-[#58a6ff]" />
          </div>

          {/* Steps */}
          <div className="flex flex-col gap-1">
            <label className="text-[9px] text-gray-500 uppercase">Steps (one per line — Label: Prompt)</label>
            <textarea value={stepsText} onChange={e => setStepsText(e.target.value)} rows={4}
              placeholder="Analyze: Read docs and identify requirements&#10;Write: Write PRD to docs/prd.md&#10;Review: Review and improve"
              className="text-xs bg-[#161b22] border border-[#30363d] rounded px-2 py-1 text-white focus:outline-none focus:border-[#58a6ff] resize-none font-mono" />
          </div>
        </div>

        <div className="flex justify-end gap-2 mt-4">
          <button onClick={onCancel} className="text-xs px-3 py-1.5 rounded border border-[#30363d] text-gray-400 hover:text-white">Cancel</button>
          <button disabled={!label.trim()} onClick={() => {
            onConfirm({
              label: label.trim(), icon: icon.trim() || '🤖', role: role.trim(),
              backend, agentId, dependsOn: Array.from(selectedDeps),
              outputs: outputs.split(',').map(s => s.trim()).filter(Boolean),
              steps: parseSteps(),
            });
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

function LogPanel({ agentId, agentLabel, workspaceId, onClose }: {
  agentId: string; agentLabel: string; workspaceId: string; onClose: () => void;
}) {
  const [logs, setLogs] = useState<any[]>([]);
  const [filter, setFilter] = useState<'all' | 'messages' | 'summaries'>('all');
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch(`/api/workspace/${workspaceId}/agents`).then(r => r.json()).then(data => {
      const state = data.states?.[agentId];
      if (state?.history) setLogs(state.history);
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
          <button onClick={onClose} className="text-gray-500 hover:text-white text-sm ml-auto">✕</button>
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
                    <span className="break-all">{entry.content}</span>
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
              {msg.status && msg.status !== 'delivered' && (
                <span className={`text-[7px] px-1 rounded ${
                  msg.status === 'acked' ? 'text-green-500' : msg.status === 'failed' ? 'text-red-500' : 'text-yellow-500'
                }`}>{msg.status}</span>
              )}
            </div>
          ))}
        </div>
      </div>
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
  const isDone = state?.status === 'done';
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
  [key: string]: unknown;
}

function AgentFlowNode({ data }: NodeProps<Node<AgentNodeData>>) {
  const { config, state, colorIdx, previewLines, onRun, onPause, onStop, onRetry, onEdit, onRemove, onMessage, onApprove, onShowLog, onShowMemory } = data;
  const c = COLORS[colorIdx % COLORS.length];
  const status = state?.status || 'idle';
  const statusInfo = STATUS_MAP[status] || STATUS_MAP.idle;
  const currentStep = state?.currentStep;
  const step = currentStep !== undefined ? config.steps[currentStep] : undefined;

  return (
    <div className="w-52 flex flex-col rounded-lg select-none"
      style={{ border: `1px solid ${c.border}${status === 'running' ? '90' : '40'}`, background: c.bg,
        boxShadow: statusInfo.glow ? `0 0 12px ${statusInfo.color}25` : 'none' }}>
      <Handle type="target" position={Position.Left} style={{ background: c.accent, width: 8, height: 8, border: 'none' }} />
      <Handle type="source" position={Position.Right} style={{ background: c.accent, width: 8, height: 8, border: 'none' }} />

      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2">
        <span className="text-sm">{config.icon}</span>
        <div className="flex-1 min-w-0">
          <div className="text-xs font-semibold text-white truncate">{config.label}</div>
          <div className="text-[8px]" style={{ color: c.accent }}>{config.backend === 'api' ? config.provider || 'api' : config.agentId || 'cli'}</div>
        </div>
        {/* Status badge */}
        <div className="flex items-center gap-1">
          <div className="w-2 h-2 rounded-full" style={{ background: statusInfo.color, boxShadow: statusInfo.glow ? `0 0 6px ${statusInfo.color}` : 'none' }} />
          <span className="text-[7px]" style={{ color: statusInfo.color }}>{statusInfo.label}</span>
        </div>
      </div>

      {/* Current step */}
      {step && status === 'running' && (
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

      {/* Actions */}
      <div className="flex items-center gap-1 px-2 py-1.5" style={{ borderTop: `1px solid ${c.border}15` }}>
        {(status === 'idle' || status === 'done') && (
          <button onPointerDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); onRun(); }}
            className="text-[9px] px-1.5 py-0.5 rounded bg-green-600/20 text-green-400 hover:bg-green-600/30">
            {status === 'done' ? '↻ Re-run' : '▶ Run'}
          </button>
        )}
        {status === 'running' && <>
          <button onPointerDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); onPause(); }}
            className="text-[9px] px-1.5 py-0.5 rounded bg-yellow-600/20 text-yellow-400 hover:bg-yellow-600/30">⏸</button>
          <button onPointerDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); onStop(); }}
            className="text-[9px] px-1.5 py-0.5 rounded bg-red-600/20 text-red-400 hover:bg-red-600/30">■</button>
        </>}
        {status === 'paused' && (
          <button onPointerDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); onRun(); }}
            className="text-[9px] px-1.5 py-0.5 rounded bg-green-600/20 text-green-400 hover:bg-green-600/30">▶ Resume</button>
        )}
        {status === 'waiting_approval' && (
          <button onPointerDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); onApprove(); }}
            className="text-[9px] px-1.5 py-0.5 rounded bg-yellow-600/20 text-yellow-400 hover:bg-yellow-600/30 animate-pulse">✓ Approve</button>
        )}
        {(status === 'failed' || status === 'interrupted') && (
          <button onPointerDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); onRetry(); }}
            className="text-[9px] px-1.5 py-0.5 rounded bg-orange-600/20 text-orange-400 hover:bg-orange-600/30">↻ Retry</button>
        )}
        {/* Message button — always visible except when idle */}
        {status !== 'idle' && (
          <button onPointerDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); onMessage(); }}
            className="text-[9px] px-1.5 py-0.5 rounded bg-blue-600/20 text-blue-400 hover:bg-blue-600/30">💬</button>
        )}
        <div className="flex-1" />
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
  const [showBusPanel, setShowBusPanel] = useState(false);

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
  const { agents, states, logPreview, busLog } = useWorkspaceStream(workspaceId, (event) => {
    if (event.type === 'user_input_request') {
      setUserInputRequest(event);
    }
  });

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
              state: states[agent.id] || { status: 'idle', artifacts: [] },
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
            state: states[agent.id] || { status: 'idle', artifacts: [] },
            colorIdx: i,
            previewLines: logPreview[agent.id] || [],
            onRun: () => {
              const s = states[agent.id]?.status;
              if (s === 'paused') {
                wsApi(workspaceId!, 'resume', { agentId: agent.id });
              } else {
                wsApi(workspaceId!, 'run', { agentId: agent.id });
              }
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
        const depStatus = depState?.status || 'idle';
        const targetStatus = targetState?.status || 'idle';
        const isFlowing = depStatus === 'running' || targetStatus === 'running';
        const isCompleted = depStatus === 'done';
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

  return (
    <div className="flex-1 flex flex-col min-h-0" style={{ background: '#080810' }}>
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-[#2a2a3a] shrink-0">
        <button onClick={onClose} className="text-gray-400 hover:text-white text-sm">←</button>
        <span className="text-xs font-bold text-white">Workspace</span>
        <span className="text-[9px] text-gray-500">{projectName}</span>
        {agents.length > 0 && (
          <button onClick={handleRunAll}
            className="text-[8px] px-2 py-0.5 rounded bg-green-600/20 text-green-400 hover:bg-green-600/30 ml-2">
            ▶ Run All
          </button>
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
