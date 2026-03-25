'use client';

import { useState, useEffect, useCallback } from 'react';

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

interface PhaseConfig {
  id: string;       // unique key
  presetId: string;  // preset id or 'custom'
  label: string;
  icon: string;
  role: string;
  agentId: string;
  inputArtifactTypes: string[];
  outputArtifactName: string;
  outputArtifactType: string;
  waitForHuman: boolean;
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
  const [phases, setPhases] = useState<PhaseConfig[]>([]);

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

  // Initialize default phases from presets
  useEffect(() => {
    if (presets.length > 0 && phases.length === 0) {
      const defaults = ['pm', 'engineer', 'qa', 'reviewer'];
      setPhases(defaults.map((pid, i) => {
        const p = presets.find(pr => pr.id === pid);
        return p ? presetToPhase(p, `phase-${i}`) : null;
      }).filter(Boolean) as PhaseConfig[]);
    }
  }, [presets]); // eslint-disable-line react-hooks/exhaustive-deps

  const presetToPhase = (p: RolePreset, id?: string): PhaseConfig => ({
    id: id || `phase-${Date.now()}`,
    presetId: p.id,
    label: p.label,
    icon: p.icon,
    role: p.role,
    agentId: 'claude',
    inputArtifactTypes: p.inputArtifactTypes,
    outputArtifactName: p.outputArtifactName,
    outputArtifactType: p.outputArtifactType,
    waitForHuman: p.waitForHuman || false,
  });

  const addPhase = (preset: RolePreset) => {
    setPhases(prev => [...prev, presetToPhase(preset)]);
  };

  const removePhase = (id: string) => {
    setPhases(prev => prev.filter(p => p.id !== id));
  };

  const movePhase = (id: string, dir: -1 | 1) => {
    setPhases(prev => {
      const idx = prev.findIndex(p => p.id === id);
      if (idx < 0) return prev;
      const newIdx = idx + dir;
      if (newIdx < 0 || newIdx >= prev.length) return prev;
      const next = [...prev];
      [next[idx], next[newIdx]] = [next[newIdx], next[idx]];
      return next;
    });
  };

  const updatePhase = (id: string, updates: Partial<PhaseConfig>) => {
    setPhases(prev => prev.map(p => p.id === id ? { ...p, ...updates } : p));
  };

  const handleCreate = async () => {
    if (!form.project || !form.description || phases.length === 0) return;
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
          phases: phases.map((p, i) => ({
            name: p.presetId === 'custom' ? `custom-${i}` : p.presetId,
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

  const [editingPhase, setEditingPhase] = useState<string | null>(null);

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

            {/* Phase composer */}
            <div>
              <div className="flex items-center gap-2 mb-2">
                <span className="text-[10px] font-bold text-gray-300">Agent Roles</span>
                <span className="text-[8px] text-gray-500">drag to reorder · click to edit</span>
              </div>

              {/* Current phases */}
              <div className="space-y-1.5 mb-2">
                {phases.map((phase, i) => (
                  <div key={phase.id} className="flex items-center gap-1.5 group">
                    {/* Reorder */}
                    <div className="flex flex-col gap-0 text-[8px] text-gray-600">
                      <button onClick={() => movePhase(phase.id, -1)} className="hover:text-white leading-none" disabled={i === 0}>▲</button>
                      <button onClick={() => movePhase(phase.id, 1)} className="hover:text-white leading-none" disabled={i === phases.length - 1}>▼</button>
                    </div>

                    {/* Phase card */}
                    <div
                      onClick={() => setEditingPhase(editingPhase === phase.id ? null : phase.id)}
                      className={`flex-1 flex items-center gap-2 px-2 py-1.5 rounded border cursor-pointer transition-colors ${
                        editingPhase === phase.id ? 'border-[var(--accent)] bg-[var(--accent)]/5' : 'border-[#30363d] hover:border-[#484f58] bg-[#161b22]'
                      }`}
                    >
                      <span className="text-sm">{phase.icon}</span>
                      <span className="text-[10px] font-medium text-gray-200">{phase.label}</span>
                      <span className="text-[8px] px-1 py-0.5 rounded bg-blue-500/20 text-blue-400">{phase.agentId}</span>
                      {phase.waitForHuman && <span className="text-[7px] px-1 py-0.5 rounded bg-yellow-500/20 text-yellow-400">approval</span>}
                      <span className="text-[8px] text-gray-600 ml-auto truncate max-w-[200px]">{phase.role.slice(0, 50)}...</span>
                    </div>

                    {/* Remove */}
                    <button onClick={() => removePhase(phase.id)} className="text-[9px] text-gray-600 hover:text-red-400 opacity-0 group-hover:opacity-100">×</button>

                    {/* Flow arrow */}
                    {i < phases.length - 1 && (
                      <div className="absolute right-0 translate-x-full text-gray-600 text-[8px]">→</div>
                    )}
                  </div>
                ))}
              </div>

              {/* Phase edit panel */}
              {editingPhase && (() => {
                const phase = phases.find(p => p.id === editingPhase);
                if (!phase) return null;
                return (
                  <div className="border border-[#30363d] rounded p-2 mb-2 bg-[#161b22] space-y-1.5">
                    <div className="grid grid-cols-2 gap-1.5">
                      <input value={phase.label} onChange={e => updatePhase(phase.id, { label: e.target.value })}
                        className="text-[10px] bg-[#0d1117] border border-[#30363d] rounded px-1.5 py-1 text-gray-300" placeholder="Label" />
                      <select value={phase.agentId} onChange={e => updatePhase(phase.id, { agentId: e.target.value })}
                        className="text-[10px] bg-[#0d1117] border border-[#30363d] rounded px-1.5 py-1 text-gray-300">
                        {agents.map(a => <option key={a.id} value={a.id}>{a.name || a.id}</option>)}
                      </select>
                    </div>
                    <textarea value={phase.role} onChange={e => updatePhase(phase.id, { role: e.target.value })}
                      className="w-full text-[9px] bg-[#0d1117] border border-[#30363d] rounded px-1.5 py-1 text-gray-300 resize-none" rows={2} placeholder="Role description..." />
                    <div className="flex items-center gap-3">
                      <label className="flex items-center gap-1 text-[9px] text-gray-400 cursor-pointer">
                        <input type="checkbox" checked={phase.waitForHuman} onChange={e => updatePhase(phase.id, { waitForHuman: e.target.checked })} className="accent-yellow-500" />
                        Require approval
                      </label>
                      <input value={phase.outputArtifactName} onChange={e => updatePhase(phase.id, { outputArtifactName: e.target.value })}
                        className="text-[9px] bg-[#0d1117] border border-[#30363d] rounded px-1.5 py-0.5 text-gray-400 w-32" placeholder="output.md" />
                    </div>
                  </div>
                );
              })()}

              {/* Add from preset */}
              <div className="flex flex-wrap gap-1">
                {presets.map(p => (
                  <button
                    key={p.id}
                    onClick={() => addPhase(p)}
                    className="text-[9px] px-2 py-1 rounded border border-[#30363d] text-gray-400 hover:text-white hover:border-[var(--accent)] transition-colors flex items-center gap-1"
                  >
                    <span>{p.icon}</span> {p.label}
                  </button>
                ))}
                <button
                  onClick={() => {
                    const id = `phase-${Date.now()}`;
                    setPhases(prev => [...prev, {
                      id, presetId: 'custom', label: 'Custom Agent', icon: '⚙',
                      role: '', agentId: 'claude', inputArtifactTypes: [],
                      outputArtifactName: 'output.md', outputArtifactType: 'custom',
                      waitForHuman: false,
                    }]);
                    setEditingPhase(id);
                  }}
                  className="text-[9px] px-2 py-1 rounded border border-dashed border-[#30363d] text-gray-500 hover:text-white hover:border-[var(--accent)]"
                >+ Custom</button>
              </div>
            </div>

            {/* Actions */}
            <div className="flex gap-2">
              <button onClick={handleCreate} disabled={creating || !form.project || !form.description || phases.length === 0}
                className="text-[10px] px-3 py-1.5 bg-green-600 text-white rounded hover:opacity-90 disabled:opacity-50">
                {creating ? 'Creating...' : `Start Delivery (${phases.length} agents)`}
              </button>
              <button onClick={() => { setShowCreate(false); setEditingPhase(null); }} className="text-[10px] text-gray-400 hover:text-white">Cancel</button>
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
