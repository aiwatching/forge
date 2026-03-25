'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  addEdge,
  useNodesState,
  useEdgesState,
  Handle,
  Position,
  type Node,
  type Edge,
  type Connection,
  type NodeProps,
  MarkerType,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

// ─── Types ────────────────────────────────────────────────

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

export interface PhaseOutput {
  name: string;
  label: string;
  icon: string;
  role: string;
  agentId: string;
  inputArtifactTypes: string[];
  outputArtifactName: string;
  outputArtifactType: string;
  waitForHuman: boolean;
  dependsOn: string[];  // phase names this depends on (from edges)
}

// ─── Colors ──────────────────────────────────────────────

const ROLE_COLORS: Record<string, { bg: string; border: string; accent: string }> = {
  pm:       { bg: '#1a2a1a', border: '#22c55e', accent: '#4ade80' },
  engineer: { bg: '#1e2a4a', border: '#3b82f6', accent: '#60a5fa' },
  qa:       { bg: '#2a1e4a', border: '#8b5cf6', accent: '#a78bfa' },
  reviewer: { bg: '#3a2a1e', border: '#f97316', accent: '#fb923c' },
  devops:   { bg: '#1e3a3a', border: '#06b6d4', accent: '#22d3ee' },
  security: { bg: '#3a1e2a', border: '#ec4899', accent: '#f472b6' },
  docs:     { bg: '#2a2a1e', border: '#eab308', accent: '#facc15' },
  custom:   { bg: '#1a1a2a', border: '#6b7280', accent: '#9ca3af' },
};

function getColor(presetId: string) {
  return ROLE_COLORS[presetId] || ROLE_COLORS.custom;
}

// ─── Custom Node ─────────────────────────────────────────

interface RoleNodeData {
  label: string;
  icon: string;
  presetId: string;
  agentId: string;
  role: string;
  waitForHuman: boolean;
  outputArtifactName: string;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
  [key: string]: unknown;
}

function RoleNode({ id, data }: NodeProps<Node<RoleNodeData>>) {
  const c = getColor(data.presetId);
  return (
    <div className="rounded-xl shadow-lg" style={{ background: c.bg, border: `2px solid ${c.border}`, minWidth: 200 }}>
      <Handle type="target" position={Position.Top} className="!w-3 !h-3" style={{ background: c.accent }} />

      <div className="px-3 py-2 flex items-center gap-2" style={{ borderBottom: `1px solid ${c.border}40` }}>
        <span className="text-sm">{data.icon}</span>
        <span className="text-[11px] font-bold text-white">{data.label}</span>
        <span className="text-[8px] px-1 py-0.5 rounded" style={{ background: c.accent + '30', color: c.accent }}>
          {data.agentId}
        </span>
        {data.waitForHuman && <span className="text-[7px] px-1 py-0.5 rounded bg-yellow-500/20 text-yellow-400">⏸</span>}
        <div className="ml-auto flex gap-1">
          <button onClick={() => data.onEdit(id)} className="text-[9px] hover:text-white" style={{ color: c.accent }}>edit</button>
          <button onClick={() => data.onDelete(id)} className="text-[9px] text-red-400 hover:text-red-300">×</button>
        </div>
      </div>

      <div className="px-3 py-1.5">
        <div className="text-[8px] text-gray-500 line-clamp-2">{data.role.slice(0, 80)}{data.role.length > 80 ? '...' : ''}</div>
        {data.outputArtifactName && (
          <div className="text-[7px] mt-1" style={{ color: c.accent }}>📄 {data.outputArtifactName}</div>
        )}
      </div>

      <Handle type="source" position={Position.Bottom} className="!w-3 !h-3" style={{ background: c.accent }} />
    </div>
  );
}

const nodeTypes = { role: RoleNode };

// ─── Edit Modal ──────────────────────────────────────────

function EditModal({ node, agents, onSave, onClose }: {
  node: { id: string; label: string; icon: string; presetId: string; agentId: string; role: string; waitForHuman: boolean; outputArtifactName: string };
  agents: { id: string; name: string }[];
  onSave: (data: typeof node) => void;
  onClose: () => void;
}) {
  const [form, setForm] = useState({ ...node });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div className="bg-[#1a1a2a] border border-[#3a3a5a] rounded-xl p-4 w-[420px] space-y-3" onClick={e => e.stopPropagation()}>
        <div className="text-sm font-bold text-white flex items-center gap-2">
          <span>{form.icon}</span> Edit Role
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="text-[9px] text-gray-400">Label</label>
            <input value={form.label} onChange={e => setForm(f => ({ ...f, label: e.target.value }))}
              className="w-full text-xs bg-[#0d1117] border border-[#30363d] rounded px-2 py-1.5 text-white" />
          </div>
          <div>
            <label className="text-[9px] text-gray-400">Agent</label>
            <select value={form.agentId} onChange={e => setForm(f => ({ ...f, agentId: e.target.value }))}
              className="w-full text-xs bg-[#0d1117] border border-[#30363d] rounded px-2 py-1.5 text-white">
              {agents.map(a => <option key={a.id} value={a.id}>{a.name || a.id}</option>)}
            </select>
          </div>
        </div>

        <div>
          <label className="text-[9px] text-gray-400">Role Description (system prompt)</label>
          <textarea value={form.role} onChange={e => setForm(f => ({ ...f, role: e.target.value }))}
            className="w-full text-xs bg-[#0d1117] border border-[#30363d] rounded px-2 py-1.5 text-gray-300 resize-none"
            rows={4} />
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="text-[9px] text-gray-400">Output artifact</label>
            <input value={form.outputArtifactName} onChange={e => setForm(f => ({ ...f, outputArtifactName: e.target.value }))}
              className="w-full text-xs bg-[#0d1117] border border-[#30363d] rounded px-2 py-1.5 text-gray-300" />
          </div>
          <div className="flex items-end pb-1">
            <label className="flex items-center gap-1.5 text-[10px] text-gray-400 cursor-pointer">
              <input type="checkbox" checked={form.waitForHuman} onChange={e => setForm(f => ({ ...f, waitForHuman: e.target.checked }))}
                className="accent-yellow-500" />
              Require approval
            </label>
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <button onClick={onClose} className="text-xs px-3 py-1 text-gray-400 hover:text-white">Cancel</button>
          <button onClick={() => onSave(form)} className="text-xs px-3 py-1 bg-green-600 text-white rounded hover:opacity-90">Save</button>
        </div>
      </div>
    </div>
  );
}

// ─── Main Component ──────────────────────────────────────

export default function DeliveryFlowEditor({ presets, agents, initialPhases, onChange }: {
  presets: RolePreset[];
  agents: { id: string; name: string }[];
  initialPhases?: PhaseOutput[];
  onChange: (phases: PhaseOutput[]) => void;
}) {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<RoleNodeData>>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const nextId = useRef(1);

  // Initialize with defaults
  useEffect(() => {
    if (nodes.length > 0) return;
    const defaults = initialPhases || presets.filter(p => ['pm', 'engineer', 'qa', 'reviewer'].includes(p.id));
    const initNodes: Node<RoleNodeData>[] = defaults.map((p, i) => {
      const preset = 'presetId' in p ? p : presets.find(pr => pr.id === (p as any).name) || p;
      const presetId = (preset as any).presetId || (preset as any).id || 'custom';
      return {
        id: `role-${i}`,
        type: 'role',
        position: { x: 100 + (i % 2) * 280, y: 50 + Math.floor(i / 2) * 180 },
        data: {
          label: (preset as any).label || (preset as any).name || `Role ${i}`,
          icon: (preset as any).icon || '⚙',
          presetId,
          agentId: (p as any).agentId || 'claude',
          role: (preset as any).role || '',
          waitForHuman: (preset as any).waitForHuman || false,
          outputArtifactName: (preset as any).outputArtifactName || 'output.md',
          onEdit: (id: string) => setEditing(id),
          onDelete: (id: string) => handleDelete(id),
        },
      };
    });

    // Auto-connect sequentially
    const initEdges: Edge[] = [];
    for (let i = 0; i < initNodes.length - 1; i++) {
      const c = getColor(initNodes[i].data.presetId);
      initEdges.push({
        id: `${initNodes[i].id}-${initNodes[i + 1].id}`,
        source: initNodes[i].id,
        target: initNodes[i + 1].id,
        markerEnd: { type: MarkerType.ArrowClosed, color: c.accent },
        style: { stroke: c.accent, strokeWidth: 2 },
        animated: true,
      });
    }

    nextId.current = initNodes.length;
    setNodes(initNodes);
    setEdges(initEdges);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Emit changes whenever nodes/edges change
  useEffect(() => {
    if (nodes.length === 0) return;
    const output = buildOutput(nodes, edges);
    onChange(output);
  }, [nodes, edges]); // eslint-disable-line react-hooks/exhaustive-deps

  const onConnect = useCallback((params: Connection) => {
    const sourceNode = nodes.find(n => n.id === params.source);
    const c = sourceNode ? getColor(sourceNode.data.presetId) : ROLE_COLORS.custom;
    setEdges(eds => addEdge({
      ...params,
      markerEnd: { type: MarkerType.ArrowClosed, color: c.accent },
      style: { stroke: c.accent, strokeWidth: 2 },
      animated: true,
    }, eds));
  }, [nodes, setEdges]);

  const handleAddPreset = (preset: RolePreset) => {
    const id = `role-${nextId.current++}`;
    const c = getColor(preset.id);
    setNodes(nds => [...nds, {
      id,
      type: 'role',
      position: { x: 100 + (nds.length % 3) * 240, y: 50 + Math.floor(nds.length / 3) * 180 },
      data: {
        label: preset.label,
        icon: preset.icon,
        presetId: preset.id,
        agentId: 'claude',
        role: preset.role,
        waitForHuman: preset.waitForHuman || false,
        outputArtifactName: preset.outputArtifactName,
        onEdit: (nid: string) => setEditing(nid),
        onDelete: (nid: string) => handleDelete(nid),
      },
    }]);
  };

  const handleAddCustom = () => {
    const id = `role-${nextId.current++}`;
    setNodes(nds => [...nds, {
      id,
      type: 'role',
      position: { x: 100 + (nds.length % 3) * 240, y: 50 + Math.floor(nds.length / 3) * 180 },
      data: {
        label: 'Custom Agent',
        icon: '⚙',
        presetId: 'custom',
        agentId: 'claude',
        role: '',
        waitForHuman: false,
        outputArtifactName: 'output.md',
        onEdit: (nid: string) => setEditing(nid),
        onDelete: (nid: string) => handleDelete(nid),
      },
    }]);
    setEditing(id);
  };

  const handleDelete = useCallback((id: string) => {
    setNodes(nds => nds.filter(n => n.id !== id));
    setEdges(eds => eds.filter(e => e.source !== id && e.target !== id));
  }, [setNodes, setEdges]);

  const handleSaveEdit = (data: { id: string; label: string; icon: string; presetId: string; agentId: string; role: string; waitForHuman: boolean; outputArtifactName: string }) => {
    setNodes(nds => nds.map(n => {
      if (n.id !== data.id) return n;
      return { ...n, data: { ...n.data, ...data } };
    }));
    setEditing(null);
  };

  const editingNode = editing ? nodes.find(n => n.id === editing) : null;

  return (
    <div className="flex flex-col" style={{ height: 350 }}>
      {/* Toolbar: add from presets */}
      <div className="flex items-center gap-1 px-2 py-1.5 border-b border-[#30363d] bg-[#0d1117] shrink-0 flex-wrap">
        <span className="text-[9px] text-gray-500 mr-1">Add:</span>
        {presets.map(p => (
          <button key={p.id} onClick={() => handleAddPreset(p)}
            className="text-[8px] px-1.5 py-0.5 rounded border border-[#30363d] text-gray-400 hover:text-white hover:border-[var(--accent)] flex items-center gap-0.5">
            <span>{p.icon}</span> {p.label}
          </button>
        ))}
        <button onClick={handleAddCustom}
          className="text-[8px] px-1.5 py-0.5 rounded border border-dashed border-[#30363d] text-gray-500 hover:text-white hover:border-[var(--accent)]">
          + Custom
        </button>
        <span className="text-[7px] text-gray-600 ml-auto">Drag to connect · Click edit to configure</span>
      </div>

      {/* ReactFlow canvas */}
      <div className="flex-1">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          nodeTypes={nodeTypes}
          fitView
          fitViewOptions={{ padding: 0.3 }}
          deleteKeyCode="Delete"
          style={{ background: '#0a0a1a' }}
          minZoom={0.4}
          maxZoom={2}
        >
          <Background color="#1a1a3a" gap={20} />
          <Controls />
        </ReactFlow>
      </div>

      {/* Edit modal */}
      {editingNode && (
        <EditModal
          node={{
            id: editingNode.id,
            label: editingNode.data.label,
            icon: editingNode.data.icon,
            presetId: editingNode.data.presetId,
            agentId: editingNode.data.agentId,
            role: editingNode.data.role,
            waitForHuman: editingNode.data.waitForHuman,
            outputArtifactName: editingNode.data.outputArtifactName,
          }}
          agents={agents}
          onSave={handleSaveEdit}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

// ─── Build output from graph ─────────────────────────────

function buildOutput(nodes: Node<RoleNodeData>[], edges: Edge[]): PhaseOutput[] {
  // Topological sort by edges
  const adjList = new Map<string, string[]>();
  const inDegree = new Map<string, number>();

  for (const n of nodes) {
    adjList.set(n.id, []);
    inDegree.set(n.id, 0);
  }
  for (const e of edges) {
    adjList.get(e.source)?.push(e.target);
    inDegree.set(e.target, (inDegree.get(e.target) || 0) + 1);
  }

  const sorted: string[] = [];
  const queue = [...nodes.filter(n => (inDegree.get(n.id) || 0) === 0).map(n => n.id)];
  while (queue.length > 0) {
    const id = queue.shift()!;
    sorted.push(id);
    for (const next of adjList.get(id) || []) {
      const deg = (inDegree.get(next) || 1) - 1;
      inDegree.set(next, deg);
      if (deg === 0) queue.push(next);
    }
  }
  // Add any remaining (disconnected)
  for (const n of nodes) {
    if (!sorted.includes(n.id)) sorted.push(n.id);
  }

  return sorted.map(id => {
    const node = nodes.find(n => n.id === id)!;
    const deps = edges.filter(e => e.target === id).map(e => {
      const src = nodes.find(n => n.id === e.source);
      return src?.data.presetId || e.source;
    });

    return {
      name: node.data.presetId === 'custom' ? `custom-${id}` : node.data.presetId,
      label: node.data.label,
      icon: node.data.icon,
      role: node.data.role,
      agentId: node.data.agentId,
      inputArtifactTypes: [], // derived from edges at runtime
      outputArtifactName: node.data.outputArtifactName,
      outputArtifactType: 'custom',
      waitForHuman: node.data.waitForHuman,
      dependsOn: deps,
    };
  });
}
