'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import type { TaskLogEntry } from '@/src/types';

// ─── Types ────────────────────────────────────────────────

interface Artifact {
  id: string;
  type: string;
  name: string;
  content: string;
  producedBy: string;
  createdAt: string;
}

interface DeliveryPhase {
  name: string;
  status: string;
  agentRole: string;
  agentId: string;
  taskIds: string[];
  outputArtifactIds: string[];
  interactions: { from: string; message: string; timestamp: string }[];
  startedAt?: string;
  completedAt?: string;
  error?: string;
  _label?: string;
  _icon?: string;
  _waitForHuman?: boolean;
  _outputArtifactName?: string;
  _requires?: string[];
  _produces?: string[];
}

interface Delivery {
  id: string;
  title: string;
  status: string;
  input: { prUrl?: string; description?: string; project: string; projectPath: string };
  phases: DeliveryPhase[];
  currentPhaseIndex: number;
  artifacts?: Artifact[];
  createdAt: string;
  completedAt?: string;
}

// ─── Phase config ─────────────────────────────────────────

const PHASE_COLORS = ['#22c55e', '#3b82f6', '#a855f7', '#f97316', '#ec4899', '#06b6d4', '#eab308'];

const PHASE_META_DEFAULTS: Record<string, { icon: string; label: string }> = {
  analyze:   { icon: '📋', label: 'PM - Analyze' },
  implement: { icon: '🔨', label: 'Engineer - Implement' },
  test:      { icon: '🧪', label: 'QA - Test' },
  review:    { icon: '🔍', label: 'Reviewer - Review' },
  pm:        { icon: '📋', label: 'PM - Analyze' },
  engineer:  { icon: '🔨', label: 'Engineer - Implement' },
  qa:        { icon: '🧪', label: 'QA - Test' },
  reviewer:  { icon: '🔍', label: 'Reviewer - Review' },
  devops:    { icon: '🚀', label: 'DevOps - Deploy' },
  security:  { icon: '🔒', label: 'Security Audit' },
  docs:      { icon: '📝', label: 'Tech Writer - Docs' },
};

function getPhaseMeta(phase: DeliveryPhase, index: number) {
  const defaults = PHASE_META_DEFAULTS[phase.name] || { icon: '⚙', label: phase.name };
  return {
    icon: phase._icon || defaults.icon,
    label: phase._label || defaults.label,
    color: PHASE_COLORS[index % PHASE_COLORS.length],
  };
}

// ─── Task SSE stream ──────────────────────────────────────

function useTaskStream(taskId: string | undefined, isRunning: boolean) {
  const [log, setLog] = useState<TaskLogEntry[]>([]);
  useEffect(() => {
    if (!taskId || !isRunning) { setLog([]); return; }
    const es = new EventSource(`/api/tasks/${taskId}/stream`);
    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'log') setLog(prev => [...prev, data.entry]);
        else if (data.type === 'complete' && data.task) setLog(data.task.log);
      } catch {}
    };
    es.onerror = () => es.close();
    return () => es.close();
  }, [taskId, isRunning]);
  return log;
}

// ─── Phase Terminal Panel ─────────────────────────────────

function PhaseTerminal({ phase, phaseIndex, deliveryId, artifacts }: {
  phase: DeliveryPhase;
  phaseIndex: number;
  deliveryId: string;
  artifacts: Artifact[];
}) {
  const meta = getPhaseMeta(phase, phaseIndex);
  const isRunning = phase.status === 'running';
  const lastTaskId = phase.taskIds[phase.taskIds.length - 1];
  const log = useTaskStream(lastTaskId, isRunning);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [log, phase.interactions]);

  const handleSend = async () => {
    if (!input.trim() || sending) return;
    setSending(true);
    await fetch(`/api/delivery/${deliveryId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'send', phase: phase.name, message: input }),
    });
    setInput('');
    setSending(false);
  };

  const phaseArtifacts = artifacts.filter(a => phase.outputArtifactIds.includes(a.id));

  return (
    <div className="flex flex-col min-h-0 border rounded-lg overflow-hidden" style={{ borderColor: meta.color + '60' }}>
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-1.5 shrink-0" style={{ background: meta.color + '15', borderBottom: `1px solid ${meta.color}30` }}>
        <span className="text-sm">{meta.icon}</span>
        <span className="text-[10px] font-bold text-white">{meta.label}</span>
        <span className="text-[8px] px-1.5 py-0.5 rounded" style={{ background: meta.color + '30', color: meta.color }}>{phase.agentId}</span>
        {isRunning && <span className="text-[8px] text-yellow-400 animate-pulse ml-auto">● running</span>}
        {phase.status === 'done' && <span className="text-[8px] text-green-400 ml-auto">✓ done</span>}
        {phase.status === 'waiting_human' && <span className="text-[8px] text-yellow-300 ml-auto animate-pulse">⏸ waiting approval</span>}
        {phase.status === 'failed' && <span className="text-[8px] text-red-400 ml-auto">✗ failed</span>}
        {phase.status === 'pending' && <span className="text-[8px] text-gray-500 ml-auto">○ pending</span>}
      </div>

      {/* Terminal body */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-2 font-mono text-[11px] leading-[1.6]" style={{ background: '#0d1117', color: '#c9d1d9', minHeight: 80 }}>
        {phase.status === 'pending' && (
          <div className="text-gray-600">Waiting for previous phase...</div>
        )}

        {/* Interactions (user messages) */}
        {phase.interactions.map((inter, i) => (
          <div key={i} className="text-yellow-300 text-[10px] mb-1">
            <span className="text-yellow-500">▸ [{inter.from}]</span> {inter.message}
          </div>
        ))}

        {/* Live log */}
        {isRunning && (
          <>
            {lastTaskId && <div className="text-gray-500 text-[9px] mb-1">$ task:{lastTaskId}</div>}
            {log.length === 0 ? (
              <div className="text-gray-600 animate-pulse">Starting...</div>
            ) : (
              log.slice(-40).map((entry, i) => <LogLine key={i} entry={entry} color={meta.color} />)
            )}
            <span className="inline-block w-2 h-4 bg-gray-400 animate-pulse" />
          </>
        )}

        {/* Done — show output artifacts */}
        {(phase.status === 'done' || phase.status === 'waiting_human') && phaseArtifacts.length > 0 && (
          <div className="mt-1">
            {phaseArtifacts.map(a => (
              <details key={a.id} className="mb-1">
                <summary className="text-[9px] cursor-pointer" style={{ color: meta.color }}>
                  📄 {a.name} ({a.content.length} chars)
                </summary>
                <pre className="text-[9px] text-gray-400 mt-1 whitespace-pre-wrap max-h-[150px] overflow-y-auto bg-black/30 rounded p-2">
                  {a.content.slice(0, 3000)}{a.content.length > 3000 ? '\n[...]' : ''}
                </pre>
              </details>
            ))}
          </div>
        )}

        {phase.error && <div className="text-red-400 text-[10px] mt-1">{phase.error}</div>}
      </div>

      {/* Input bar */}
      {(phase.status === 'running' || phase.status === 'done' || phase.status === 'waiting_human') && (
        <div className="flex items-center gap-1 px-2 py-1 shrink-0" style={{ background: '#161b22', borderTop: `1px solid ${meta.color}20` }}>
          <span className="text-[10px] font-mono" style={{ color: meta.color }}>$</span>
          <input
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleSend()}
            placeholder={`Send to ${phase.name}...`}
            className="flex-1 bg-transparent text-[10px] font-mono text-gray-300 focus:outline-none placeholder:text-gray-600"
          />
          {input.trim() && (
            <button onClick={handleSend} disabled={sending} className="text-[8px] px-1.5 py-0.5 rounded"
              style={{ background: meta.color + '30', color: meta.color }}>Send</button>
          )}
        </div>
      )}
    </div>
  );
}

function LogLine({ entry, color }: { entry: TaskLogEntry; color: string }) {
  if (entry.type === 'system' && entry.subtype === 'init') return <div className="text-gray-600 text-[9px]">{entry.content}</div>;
  if (entry.type === 'assistant' && entry.subtype === 'tool_use') {
    return <div className="text-[10px]"><span style={{ color }}>⚙</span> <span className="text-blue-400">{entry.tool || 'tool'}</span> <span className="text-gray-600">{entry.content.slice(0, 80)}{entry.content.length > 80 ? '...' : ''}</span></div>;
  }
  if (entry.type === 'result') return <div className="text-green-400 text-[10px]">{entry.content.slice(0, 200)}</div>;
  if (entry.subtype === 'error') return <div className="text-red-400 text-[10px]">{entry.content}</div>;
  return <div className="text-[10px]" style={{ color: '#c9d1d9' }}>{entry.content.slice(0, 200)}{entry.content.length > 200 ? '...' : ''}</div>;
}

// ─── Phase Timeline ───────────────────────────────────────

function PhaseTimeline({ phases, currentIndex }: { phases: DeliveryPhase[]; currentIndex: number }) {
  return (
    <div className="space-y-1">
      {phases.map((phase, i) => {
        const meta = getPhaseMeta(phase, i);
        const isCurrent = i === currentIndex && phase.status !== 'done';
        return (
          <div key={phase.name} className="flex items-center gap-2">
            <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs shrink-0 ${
              phase.status === 'done' ? 'bg-green-500/20' :
              phase.status === 'running' ? 'bg-yellow-500/20 ring-2 ring-yellow-400/40' :
              phase.status === 'waiting_human' ? 'bg-yellow-500/20 ring-2 ring-yellow-300/40' :
              phase.status === 'failed' ? 'bg-red-500/20' :
              'bg-gray-500/10'
            }`}>
              {phase.status === 'done' ? '✓' : phase.status === 'failed' ? '✗' : meta.icon}
            </div>
            <div className="flex-1 min-w-0">
              <div className={`text-[10px] font-medium ${isCurrent ? 'text-white' : 'text-gray-400'}`}>{meta.label}</div>
              <div className="text-[8px] text-gray-600">{phase.status}{phase.taskIds.length > 0 ? ` · ${phase.taskIds.length} task${phase.taskIds.length > 1 ? 's' : ''}` : ''}</div>
            </div>
            {/* Connector line */}
            {i < phases.length - 1 && (
              <div className="absolute left-3 mt-8 w-px h-2" style={{ background: phase.status === 'done' ? '#22c55e40' : '#333' }} />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── Artifact Sidebar ─────────────────────────────────────

function ArtifactList({ artifacts }: { artifacts: Artifact[] }) {
  const [expanded, setExpanded] = useState<string | null>(null);

  if (artifacts.length === 0) return <div className="text-[9px] text-gray-500 p-2">No artifacts yet</div>;

  return (
    <div className="space-y-1">
      {artifacts.map(a => (
        <div key={a.id} className="border border-[var(--border)] rounded overflow-hidden">
          <button
            onClick={() => setExpanded(expanded === a.id ? null : a.id)}
            className="w-full text-left px-2 py-1.5 hover:bg-[var(--bg-tertiary)] flex items-center gap-1.5"
          >
            <span className="text-[9px]">📄</span>
            <span className="text-[9px] text-[var(--text-primary)] font-medium truncate flex-1">{a.name}</span>
            <span className="text-[7px] text-gray-500">{a.producedBy}</span>
          </button>
          {expanded === a.id && (
            <pre className="px-2 py-1.5 text-[8px] text-gray-400 whitespace-pre-wrap max-h-[200px] overflow-y-auto bg-black/20 border-t border-[var(--border)]">
              {a.content.slice(0, 5000)}{a.content.length > 5000 ? '\n[...]' : ''}
            </pre>
          )}
        </div>
      ))}
    </div>
  );
}

// ─── Data Flow SVG ────────────────────────────────────────

function DataFlowOverlay({ phases }: { phases: DeliveryPhase[] }) {
  // Simple horizontal flow indicator showing artifact passing
  const donePhases = phases.filter(p => p.status === 'done').length;

  return (
    <div className="flex items-center gap-1 px-2">
      {phases.map((phase, i) => {
        const meta = getPhaseMeta(phase, i);
        const isDone = phase.status === 'done';
        const isRunning = phase.status === 'running' || phase.status === 'waiting_human';
        return (
          <div key={phase.name} className="flex items-center gap-1">
            <div className="text-[9px] px-1.5 py-0.5 rounded" style={{
              background: isDone ? meta.color + '20' : isRunning ? meta.color + '15' : 'transparent',
              color: isDone ? meta.color : isRunning ? meta.color : '#555',
              border: `1px solid ${isDone ? meta.color + '40' : isRunning ? meta.color + '30' : '#333'}`,
            }}>
              {meta.icon} {phase.name}
            </div>
            {i < phases.length - 1 && (
              <svg width="24" height="12" viewBox="0 0 24 12" className="shrink-0">
                <line x1="0" y1="6" x2="18" y2="6" stroke={isDone ? meta.color : '#333'} strokeWidth="1.5"
                  strokeDasharray={isRunning ? '3 2' : 'none'}>
                  {isRunning && <animate attributeName="stroke-dashoffset" from="10" to="0" dur="0.6s" repeatCount="indefinite" />}
                </line>
                <polygon points="16,2 24,6 16,10" fill={isDone ? meta.color : '#333'} opacity={isDone ? 0.8 : 0.3} />
              </svg>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── Human Approval Panel ─────────────────────────────────

function ApprovalPanel({ deliveryId, artifacts, onRefresh }: { deliveryId: string; artifacts: Artifact[]; onRefresh: () => void }) {
  const [feedback, setFeedback] = useState('');
  const [acting, setActing] = useState(false);
  const reqArtifact = artifacts.find(a => a.type === 'requirements' || a.name.includes('requirement') || a.producedBy === 'analyze');

  const act = async (action: 'approve' | 'reject') => {
    setActing(true);
    await fetch(`/api/delivery/${deliveryId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, feedback: feedback || undefined }),
    });
    setFeedback('');
    setActing(false);
    onRefresh();
  };

  return (
    <div className="border-2 border-yellow-500/40 rounded-lg p-3 bg-yellow-500/5 space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-yellow-400 text-sm">⏸</span>
        <span className="text-[11px] font-bold text-yellow-300">Requirements Review Required</span>
      </div>
      {reqArtifact && (
        <pre className="text-[9px] text-gray-300 whitespace-pre-wrap max-h-[200px] overflow-y-auto bg-black/30 rounded p-2">
          {reqArtifact.content.slice(0, 5000)}
        </pre>
      )}
      <textarea
        value={feedback}
        onChange={e => setFeedback(e.target.value)}
        placeholder="Optional feedback or changes..."
        className="w-full text-[10px] bg-black/20 border border-yellow-500/20 rounded p-2 text-gray-300 resize-none focus:outline-none focus:border-yellow-500/40"
        rows={2}
      />
      <div className="flex gap-2">
        <button onClick={() => act('approve')} disabled={acting}
          className="text-[10px] px-3 py-1 bg-green-600 text-white rounded hover:opacity-90 disabled:opacity-50">
          ✓ Approve & Continue
        </button>
        <button onClick={() => act('reject')} disabled={acting || !feedback.trim()}
          className="text-[10px] px-3 py-1 bg-red-600/80 text-white rounded hover:opacity-90 disabled:opacity-50">
          ✗ Reject & Redo
        </button>
      </div>
    </div>
  );
}

// ─── Grid Flow Overlay (SVG arrows between panels) ────────

function GridFlowOverlay({ phases }: { phases: DeliveryPhase[] }) {
  // Draw arrows based on actual _requires/_produces relationships, not sequential order
  const cols = phases.length <= 2 ? 2 : phases.length <= 4 ? 2 : 3;
  const rows = Math.ceil(phases.length / cols);
  const cellW = 1000 / cols;
  const cellH = 500 / rows;

  function cellCenter(i: number): [number, number] {
    const col = i % cols;
    const row = Math.floor(i / cols);
    return [col * cellW + cellW / 2, row * cellH + cellH / 2];
  }

  // Build producer map: artifact name → phase index
  const producerMap = new Map<string, number>();
  phases.forEach((p, i) => {
    const produces = p._produces || [p._outputArtifactName || `${p.name}-output.md`];
    for (const name of produces) {
      producerMap.set(name, i);
    }
  });

  // Build arrows from requires → producer
  interface Arrow {
    id: string; x1: number; y1: number; x2: number; y2: number;
    active: boolean; done: boolean; color: string; label: string;
  }
  const arrows: Arrow[] = [];

  phases.forEach((phase, targetIdx) => {
    const requires = phase._requires || [];
    for (const reqName of requires) {
      const sourceIdx = producerMap.get(reqName);
      if (sourceIdx === undefined || sourceIdx === targetIdx) continue;

      const [sx, sy] = cellCenter(sourceIdx);
      const [tx, ty] = cellCenter(targetIdx);
      const dx = tx - sx, dy = ty - sy;
      const len = Math.sqrt(dx * dx + dy * dy) || 1;
      const offset = 80;

      const sourceDone = phases[sourceIdx].status === 'done';
      const targetActive = phase.status === 'running' || phase.status === 'waiting_human';

      arrows.push({
        id: `flow-${sourceIdx}-${targetIdx}-${reqName}`,
        x1: sx + (dx / len) * offset,
        y1: sy + (dy / len) * offset,
        x2: tx - (dx / len) * offset,
        y2: ty - (dy / len) * offset,
        active: sourceDone && targetActive,
        done: sourceDone,
        color: PHASE_COLORS[sourceIdx % PHASE_COLORS.length],
        label: reqName,
      });
    }
  });

  return (
    <svg className="absolute inset-0 w-full h-full pointer-events-none z-10" viewBox="0 0 1000 500" preserveAspectRatio="none">
      <defs>
        {PHASE_COLORS.map((c, i) => (
          <marker key={i} id={`darrow-${i}`} markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
            <polygon points="0 0, 8 3, 0 6" fill={c} />
          </marker>
        ))}
      </defs>
      {arrows.map(a => {
        const opacity = a.active ? 1 : a.done ? 0.5 : 0.12;
        const markerIdx = PHASE_COLORS.indexOf(a.color) >= 0 ? PHASE_COLORS.indexOf(a.color) : 0;
        return (
          <g key={a.id}>
            <line
              x1={a.x1} y1={a.y1} x2={a.x2} y2={a.y2}
              stroke={a.color} strokeWidth={a.active ? 3 : 2}
              strokeDasharray={a.active ? '8 4' : a.done ? '0' : '4 4'}
              opacity={opacity}
              markerEnd={`url(#darrow-${markerIdx % PHASE_COLORS.length})`}
            >
              {a.active && <animate attributeName="stroke-dashoffset" from="24" to="0" dur="0.8s" repeatCount="indefinite" />}
            </line>
            {/* Artifact name label on the line */}
            {(a.active || a.done) && (
              <text
                x={(a.x1 + a.x2) / 2}
                y={(a.y1 + a.y2) / 2 - 5}
                fill={a.color}
                fontSize="9"
                textAnchor="middle"
                opacity={Math.min(opacity + 0.3, 1)}
              >📄 {a.label}</text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

// ─── Main Component ───────────────────────────────────────

export default function DeliveryWorkspace({ deliveryId, onClose }: {
  deliveryId: string;
  onClose: () => void;
}) {
  const [delivery, setDelivery] = useState<Delivery | null>(null);

  const fetchDelivery = useCallback(async () => {
    const res = await fetch(`/api/delivery/${deliveryId}`);
    if (res.ok) setDelivery(await res.json());
  }, [deliveryId]);

  // Initial load + polling
  useEffect(() => {
    fetchDelivery();
    const timer = setInterval(fetchDelivery, 3000);
    return () => clearInterval(timer);
  }, [fetchDelivery]);

  if (!delivery) {
    return <div className="flex-1 flex items-center justify-center text-xs text-gray-500">Loading delivery...</div>;
  }

  const waitingPhase = delivery.phases.find(p => p.status === 'waiting_human');
  const needsApproval = !!waitingPhase;
  const artifacts = delivery.artifacts || [];

  return (
    <div className="flex-1 flex flex-col min-h-0" style={{ background: '#0a0a1a' }}>
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-2 border-b border-[#2a2a3a] shrink-0">
        <button onClick={onClose} className="text-gray-400 hover:text-white text-sm">←</button>
        <span className="text-sm font-bold text-white">{delivery.title}</span>
        <span className={`text-[8px] px-1.5 py-0.5 rounded ${
          delivery.status === 'running' ? 'bg-yellow-500/20 text-yellow-400' :
          delivery.status === 'done' ? 'bg-green-500/20 text-green-400' :
          delivery.status === 'failed' ? 'bg-red-500/20 text-red-400' :
          'bg-gray-500/20 text-gray-400'
        }`}>{delivery.status}</span>
        <span className="text-[9px] text-gray-500">{delivery.input.project}</span>
        <div className="flex-1" />
        <DataFlowOverlay phases={delivery.phases} />
        <div className="flex-1" />
        {delivery.status === 'running' && (
          <button onClick={async () => {
            await fetch(`/api/delivery/${deliveryId}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action: 'cancel' }),
            });
            fetchDelivery();
          }} className="text-[9px] px-2 py-0.5 text-red-400 border border-red-400/30 rounded hover:bg-red-400 hover:text-white">
            Cancel
          </button>
        )}
      </div>

      {/* Body: sidebar + workspace */}
      <div className="flex-1 flex min-h-0">
        {/* Left sidebar: phases + artifacts */}
        <aside className="w-[200px] shrink-0 border-r border-[#2a2a3a] flex flex-col overflow-hidden">
          <div className="px-3 py-2 border-b border-[#2a2a3a]">
            <div className="text-[9px] text-gray-500 uppercase font-bold mb-2">Phases</div>
            <PhaseTimeline phases={delivery.phases} currentIndex={delivery.currentPhaseIndex} />
          </div>
          <div className="px-3 py-2 flex-1 overflow-y-auto">
            <div className="text-[9px] text-gray-500 uppercase font-bold mb-2">Artifacts ({artifacts.length})</div>
            <ArtifactList artifacts={artifacts} />
          </div>
        </aside>

        {/* Main: all 4 agent terminals always visible */}
        <main className="flex-1 flex flex-col gap-2 p-2 min-h-0 overflow-hidden">
          {/* Approval panel overlay */}
          {needsApproval && (
            <ApprovalPanel deliveryId={deliveryId} artifacts={artifacts} onRefresh={fetchDelivery} />
          )}

          {/* 2x2 grid with flow overlay — all phases always shown */}
          <div className="flex-1 relative min-h-0">
            {/* Flow arrows overlay */}
            <GridFlowOverlay phases={delivery.phases} />
            {/* Agent panels */}
            <div className={`absolute inset-0 grid gap-2 ${
              delivery.phases.length <= 2 ? 'grid-cols-2 grid-rows-1' :
              delivery.phases.length <= 4 ? 'grid-cols-2 grid-rows-2' :
              delivery.phases.length <= 6 ? 'grid-cols-3 grid-rows-2' :
              'grid-cols-3 grid-rows-3'
            }`}>
              {delivery.phases.map((phase, i) => (
                <PhaseTerminal
                  key={phase.name}
                  phase={phase}
                  phaseIndex={i}
                  deliveryId={deliveryId}
                  artifacts={artifacts}
                />
              ))}
            </div>
          </div>

          {/* Status bar */}
          {delivery.status !== 'running' && (
            <div className={`text-center py-1.5 rounded text-[10px] font-mono shrink-0 ${
              delivery.status === 'done' ? 'bg-green-500/5 text-green-400 border border-green-500/30' :
              delivery.status === 'failed' ? 'bg-red-500/5 text-red-400 border border-red-500/30' :
              'bg-gray-500/5 text-gray-400 border border-gray-500/30'
            }`}>
              Delivery {delivery.status}
              {delivery.completedAt && ` — ${new Date(delivery.completedAt).toLocaleString()}`}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
