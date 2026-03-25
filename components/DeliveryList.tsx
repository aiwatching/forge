'use client';

import { useState, useEffect, useCallback, lazy, Suspense } from 'react';
import type { PhaseOutput } from './DeliveryFlowEditor';

const DeliveryFlowEditor = lazy(() => import('./DeliveryFlowEditor'));

interface DeliveryItem {
  id: string;
  title: string;
  status: string;
  input: { project: string; prUrl?: string; description?: string };
  currentPhaseIndex: number;
  phases: { name: string; status: string; _label?: string; _icon?: string }[];
  createdAt: string;
  completedAt?: string;
}

interface RolePreset {
  id: string;
  label: string;
  icon: string;
  role: string;
  inputArtifactTypes: string[];
  outputArtifactName: string;
  outputArtifactType: string;
  waitForHuman?: boolean;
}

const PHASE_ICONS: Record<string, string> = {
  analyze: '📋', implement: '🔨', test: '🧪', review: '🔍',
  pm: '📋', engineer: '🔨', qa: '🧪', reviewer: '🔍',
  devops: '🚀', security: '🔒', docs: '📝',
};

export default function DeliveryList({ projects, onOpen }: {
  projects: { name: string; path: string }[];
  onOpen: (id: string) => void;
}) {
  const [deliveries, setDeliveries] = useState<DeliveryItem[]>([]);
  const [presets, setPresets] = useState<RolePreset[]>([]);
  const [agents, setAgents] = useState<{ id: string; name: string; detected?: boolean }[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ project: '', title: '', description: '', prUrl: '' });
  const [flowPhases, setFlowPhases] = useState<PhaseOutput[]>([]);

  const fetchList = useCallback(async () => {
    try {
      const res = await fetch('/api/delivery');
      if (res.ok) setDeliveries(await res.json());
    } catch {}
  }, []);

  useEffect(() => {
    fetchList();
    const timer = setInterval(fetchList, 5000);
    return () => clearInterval(timer);
  }, [fetchList]);

  // Load presets + agents when create form opens
  useEffect(() => {
    if (!showCreate) return;
    fetch('/api/delivery?type=presets').then(r => r.json()).then(setPresets).catch(() => {});
    fetch('/api/agents').then(r => r.json()).then(d => setAgents(d.agents || [])).catch(() => {});
  }, [showCreate]);

  const handleCreate = async () => {
    if (!form.project || !form.description || flowPhases.length === 0) return;
    setCreating(true);
    try {
      const proj = projects.find(p => p.name === form.project);
      if (!proj) { alert('Project not found'); setCreating(false); return; }
      const res = await fetch('/api/delivery', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: form.title || form.description.slice(0, 50),
          project: proj.name,
          projectPath: proj.path,
          description: form.description,
          prUrl: form.prUrl || undefined,
          phases: flowPhases.map(p => ({
            name: p.name,
            label: p.label,
            icon: p.icon,
            role: p.role,
            agentId: p.agentId,
            inputArtifactTypes: p.inputArtifactTypes,
            outputArtifactName: p.outputArtifactName,
            outputArtifactType: p.outputArtifactType,
            waitForHuman: p.waitForHuman,
          })),
        }),
      });
      const data = await res.json();
      if (data.id) onOpen(data.id);
    } catch { alert('Failed to create delivery'); }
    setCreating(false);
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this delivery?')) return;
    await fetch(`/api/delivery/${id}`, { method: 'DELETE' });
    fetchList();
  };

  return (
    <div className="flex-1 flex flex-col" style={{ background: '#0a0a1a' }}>
      {/* Header */}
      <div className="px-4 py-3 border-b border-[#2a2a3a] flex items-center gap-3">
        <span className="text-sm font-bold text-white">Delivery</span>
        <span className="text-[9px] text-gray-500">Multi-agent software delivery</span>
        <button
          onClick={() => setShowCreate(v => !v)}
          className="text-[10px] px-3 py-1 bg-[var(--accent)] text-white rounded hover:opacity-90 ml-auto"
        >+ New Delivery</button>
      </div>

      {/* Create form */}
      {showCreate && (
        <div className="border-b border-[#2a2a3a] bg-[#0d1117]">
          <div className="px-4 py-3 space-y-3">
            {/* Basic info */}
            <div className="grid grid-cols-2 gap-2">
              <select
                value={form.project}
                onChange={e => setForm(f => ({ ...f, project: e.target.value }))}
                className="text-xs bg-[#161b22] border border-[#30363d] rounded px-2 py-1.5 text-gray-300"
              >
                <option value="">Select project...</option>
                {projects.map(p => <option key={p.name} value={p.name}>{p.name}</option>)}
              </select>
              <input
                value={form.title}
                onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
                placeholder="Title (optional)"
                className="text-xs bg-[#161b22] border border-[#30363d] rounded px-2 py-1.5 text-gray-300 focus:outline-none"
              />
            </div>
            <textarea
              value={form.description}
              onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
              placeholder="Task description — what needs to be built or fixed..."
              className="w-full text-xs bg-[#161b22] border border-[#30363d] rounded px-2 py-1.5 text-gray-300 resize-none focus:outline-none"
              rows={2}
            />
            <input
              value={form.prUrl}
              onChange={e => setForm(f => ({ ...f, prUrl: e.target.value }))}
              placeholder="PR URL (optional)"
              className="w-full text-xs bg-[#161b22] border border-[#30363d] rounded px-2 py-1.5 text-gray-300 focus:outline-none"
            />

            {/* Flow editor — drag & connect agent roles */}
            {presets.length > 0 && (
              <Suspense fallback={<div className="h-[350px] flex items-center justify-center text-[9px] text-gray-500">Loading editor...</div>}>
                <DeliveryFlowEditor
                  presets={presets}
                  agents={agents}
                  onChange={setFlowPhases}
                />
              </Suspense>
            )}

            {/* Actions */}
            <div className="flex gap-2">
              <button onClick={handleCreate} disabled={creating || !form.project || !form.description || flowPhases.length === 0}
                className="text-[10px] px-3 py-1.5 bg-green-600 text-white rounded hover:opacity-90 disabled:opacity-50">
                {creating ? 'Creating...' : `Start Delivery (${flowPhases.length} agents)`}
              </button>
              <button onClick={() => setShowCreate(false)} className="text-[10px] text-gray-400 hover:text-white">Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* List */}
      <div className="flex-1 overflow-y-auto">
        {deliveries.length === 0 && !showCreate ? (
          <div className="flex flex-col items-center justify-center h-full text-center gap-2">
            <span className="text-3xl">🚀</span>
            <div className="text-sm text-gray-400">No deliveries yet</div>
            <div className="text-[10px] text-gray-600">Create one to start a multi-agent delivery pipeline</div>
          </div>
        ) : (
          deliveries.map(d => (
            <button
              key={d.id}
              onClick={() => onOpen(d.id)}
              className="w-full text-left px-4 py-3 border-b border-[#2a2a3a] hover:bg-[#161b22] transition-colors"
            >
              <div className="flex items-center gap-2">
                <span className={`text-[9px] px-1.5 py-0.5 rounded ${
                  d.status === 'running' ? 'bg-yellow-500/20 text-yellow-400' :
                  d.status === 'done' ? 'bg-green-500/20 text-green-400' :
                  d.status === 'failed' ? 'bg-red-500/20 text-red-400' :
                  'bg-gray-500/20 text-gray-400'
                }`}>{d.status}</span>
                <span className="text-[11px] font-semibold text-white">{d.title}</span>
                <span className="text-[9px] text-gray-500">{d.input.project}</span>
                <div className="flex gap-0.5 ml-auto">
                  {d.phases.map(p => (
                    <span key={p.name} className={`text-[8px] ${
                      p.status === 'done' ? 'opacity-100' :
                      p.status === 'running' || p.status === 'waiting_human' ? 'opacity-100 animate-pulse' :
                      'opacity-30'
                    }`}>{p._icon || PHASE_ICONS[p.name] || '⚙'}</span>
                  ))}
                </div>
                <span className="text-[8px] text-gray-600 ml-2">
                  {new Date(d.createdAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                </span>
                <button
                  onClick={(e) => { e.stopPropagation(); handleDelete(d.id); }}
                  className="text-[8px] text-gray-600 hover:text-red-400 ml-1"
                >×</button>
              </div>
              {d.input.description && (
                <div className="text-[9px] text-gray-500 mt-1 truncate">{d.input.description}</div>
              )}
            </button>
          ))
        )}
      </div>
    </div>
  );
}
