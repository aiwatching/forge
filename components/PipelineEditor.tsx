'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
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

// ─── Custom Node ──────────────────────────────────────────

interface NodeData {
  label: string;
  project: string;
  prompt: string;
  outputs: { name: string; extract: string }[];
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
  [key: string]: unknown;
}

function PipelineNode({ id, data }: NodeProps<Node<NodeData>>) {
  return (
    <div className="bg-[#1e1e3a] border border-[#3a3a5a] rounded-lg shadow-lg min-w-[180px]">
      <Handle type="target" position={Position.Top} className="!bg-[var(--accent)] !w-3 !h-3" />

      <div className="px-3 py-2 border-b border-[#3a3a5a] flex items-center gap-2">
        <span className={`text-[8px] px-1 py-0.5 rounded font-medium ${
          (data as any).mode === 'shell' ? 'bg-yellow-500/20 text-yellow-400' : 'bg-purple-500/20 text-purple-400'
        }`}>{(data as any).mode === 'shell' ? 'shell' : ((data as any).agent || 'default')}</span>
        <span className="text-xs font-semibold text-white">{data.label}</span>
        <div className="ml-auto flex gap-1">
          <button onClick={() => data.onEdit(id)} className="text-[9px] text-[var(--accent)] hover:text-white">edit</button>
          <button onClick={() => data.onDelete(id)} className="text-[9px] text-red-400 hover:text-red-300">x</button>
        </div>
      </div>

      <div className="px-3 py-1.5 space-y-0.5">
        {data.project && <div className="text-[9px] text-[var(--accent)]">{data.project}</div>}
        <div className="text-[9px] text-gray-400 truncate max-w-[200px]">{data.prompt.slice(0, 60) || 'No prompt'}{data.prompt.length > 60 ? '...' : ''}</div>
        {data.outputs.length > 0 && (
          <div className="text-[8px] text-green-400">
            outputs: {data.outputs.map(o => o.name).join(', ')}
          </div>
        )}
      </div>

      <Handle type="source" position={Position.Bottom} className="!bg-[var(--accent)] !w-3 !h-3" />
    </div>
  );
}

const nodeTypes = { pipeline: PipelineNode };

// ─── Node Edit Modal ──────────────────────────────────────

function NodeEditModal({ node, projects, agents, onSave, onClose }: {
  node: { id: string; project: string; prompt: string; agent?: string; mode?: string; outputs: { name: string; extract: string }[] };
  projects: { name: string; root: string }[];
  agents: { id: string; name: string }[];
  onSave: (data: { id: string; project: string; prompt: string; agent?: string; mode?: string; outputs: { name: string; extract: string }[] }) => void;
  onClose: () => void;
}) {
  const [id, setId] = useState(node.id);
  const [project, setProject] = useState(node.project);
  const [prompt, setPrompt] = useState(node.prompt);
  const [agent, setAgent] = useState(node.agent || '');
  const [mode, setMode] = useState(node.mode || 'claude');
  const [outputs, setOutputs] = useState(node.outputs);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="bg-[#1e1e3a] border border-[#3a3a5a] rounded-lg shadow-xl w-[450px] max-h-[80vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="px-4 py-3 border-b border-[#3a3a5a]">
          <h3 className="text-sm font-semibold text-white">Edit Node</h3>
        </div>
        <div className="p-4 space-y-3">
          <div>
            <label className="text-[10px] text-gray-400 block mb-1">Node ID</label>
            <input
              value={id}
              onChange={e => setId(e.target.value.replace(/\s+/g, '_'))}
              className="w-full text-xs bg-[#12122a] border border-[#3a3a5a] rounded px-2 py-1.5 text-white focus:outline-none focus:border-[var(--accent)] font-mono"
            />
          </div>
          <div>
            <label className="text-[10px] text-gray-400 block mb-1">Project</label>
            <select
              value={project}
              onChange={e => setProject(e.target.value)}
              className="w-full text-xs bg-[#12122a] border border-[#3a3a5a] rounded px-2 py-1.5 text-white"
            >
              <option value="">Select project...</option>
              {[...new Set(projects.map(p => p.root))].map(root => (
                <optgroup key={root} label={root.split('/').pop() || root}>
                  {projects.filter(p => p.root === root).map((p, i) => (
                    <option key={`${p.name}-${i}`} value={p.name}>{p.name}</option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>
          <div className="flex gap-2">
            <div className="flex-1">
              <label className="text-[10px] text-gray-400 block mb-1">Mode</label>
              <select
                value={mode}
                onChange={e => setMode(e.target.value)}
                className="w-full text-xs bg-[#12122a] border border-[#3a3a5a] rounded px-2 py-1.5 text-white"
              >
                <option value="claude">Agent</option>
                <option value="shell">Shell</option>
              </select>
            </div>
            {mode !== 'shell' && (
              <div className="flex-1">
                <label className="text-[10px] text-gray-400 block mb-1">Agent</label>
                <select
                  value={agent}
                  onChange={e => setAgent(e.target.value)}
                  className="w-full text-xs bg-[#12122a] border border-[#3a3a5a] rounded px-2 py-1.5 text-white"
                >
                  <option value="">Default</option>
                  {agents.map(a => (
                    <option key={a.id} value={a.id}>{a.name}</option>
                  ))}
                </select>
              </div>
            )}
          </div>
          <div>
            <label className="text-[10px] text-gray-400 block mb-1">Prompt</label>
            <textarea
              value={prompt}
              onChange={e => setPrompt(e.target.value)}
              rows={6}
              className="w-full text-xs bg-[#12122a] border border-[#3a3a5a] rounded px-2 py-1.5 text-white focus:outline-none focus:border-[var(--accent)] font-mono resize-y"
              placeholder="Use {{nodes.xxx.outputs.yyy}} to reference upstream outputs"
            />
          </div>
          <div>
            <label className="text-[10px] text-gray-400 block mb-1">Outputs</label>
            {outputs.map((o, i) => (
              <div key={i} className="flex gap-2 mb-1">
                <input
                  value={o.name}
                  onChange={e => { const n = [...outputs]; n[i] = { ...n[i], name: e.target.value }; setOutputs(n); }}
                  placeholder="output name"
                  className="flex-1 text-xs bg-[#12122a] border border-[#3a3a5a] rounded px-2 py-1 text-white font-mono"
                />
                <select
                  value={o.extract}
                  onChange={e => { const n = [...outputs]; n[i] = { ...n[i], extract: e.target.value }; setOutputs(n); }}
                  className="text-xs bg-[#12122a] border border-[#3a3a5a] rounded px-2 py-1 text-white"
                >
                  <option value="result">result</option>
                  <option value="git_diff">git_diff</option>
                </select>
                <button onClick={() => setOutputs(outputs.filter((_, j) => j !== i))} className="text-red-400 text-xs">x</button>
              </div>
            ))}
            <button
              onClick={() => setOutputs([...outputs, { name: '', extract: 'result' }])}
              className="text-[9px] text-[var(--accent)] hover:text-white"
            >
              + Add output
            </button>
          </div>
        </div>
        <div className="px-4 py-3 border-t border-[#3a3a5a] flex gap-2 justify-end">
          <button onClick={onClose} className="text-xs px-3 py-1 text-gray-400 hover:text-white">Cancel</button>
          <button
            onClick={() => onSave({ id, project, prompt, agent: agent || undefined, mode, outputs: outputs.filter(o => o.name) })}
            className="text-xs px-3 py-1 bg-[var(--accent)] text-white rounded hover:opacity-90"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Main Editor ──────────────────────────────────────────

export default function PipelineEditor({ onSave, onClose, initialYaml }: {
  onSave: (yaml: string) => void;
  onClose: () => void;
  initialYaml?: string;
}) {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<NodeData>>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [editingNode, setEditingNode] = useState<{ id: string; project: string; prompt: string; agent?: string; mode?: string; outputs: { name: string; extract: string }[] } | null>(null);
  const [workflowName, setWorkflowName] = useState('');
  const [availableAgents, setAvailableAgents] = useState<{ id: string; name: string }[]>([]);
  const [workflowDesc, setWorkflowDesc] = useState('');
  const [varsProject, setVarsProject] = useState('');
  const [projects, setProjects] = useState<{ name: string; root: string }[]>([]);
  const nextNodeId = useRef(1);

  useEffect(() => {
    fetch('/api/projects').then(r => r.json())
      .then((p: { name: string; root: string }[]) => { if (Array.isArray(p)) setProjects(p); })
      .catch(() => {});
    fetch('/api/agents').then(r => r.json())
      .then(data => setAvailableAgents((data.agents || []).filter((a: any) => a.enabled)))
      .catch(() => {});
  }, []);

  // Load initial YAML if provided
  useEffect(() => {
    if (!initialYaml) return;
    try {
      const parsed = require('yaml').parse(initialYaml);
      if (parsed.name) setWorkflowName(parsed.name);
      if (parsed.description) setWorkflowDesc(parsed.description);
      if (parsed.vars?.project) setVarsProject(parsed.vars.project);

      const nodeEntries = Object.entries(parsed.nodes || {});
      const newNodes: Node<NodeData>[] = [];
      const newEdges: Edge[] = [];

      nodeEntries.forEach(([id, def]: [string, any], idx) => {
        newNodes.push({
          id,
          type: 'pipeline',
          position: { x: 250, y: idx * 150 + 50 },
          data: {
            label: id,
            project: def.project || '',
            prompt: def.prompt || '',
            outputs: (def.outputs || []).map((o: any) => ({ name: o.name, extract: o.extract || 'result' })),
            onEdit: (nid: string) => handleEditNode(nid),
            onDelete: (nid: string) => handleDeleteNode(nid),
          },
        });

        for (const dep of (def.depends_on || [])) {
          newEdges.push({
            id: `${dep}-${id}`,
            source: dep,
            target: id,
            markerEnd: { type: MarkerType.ArrowClosed },
            style: { stroke: '#7c5bf0' },
          });
        }
      });

      setNodes(newNodes);
      setEdges(newEdges);
      nextNodeId.current = nodeEntries.length + 1;
    } catch {}
  }, [initialYaml]);

  const onConnect = useCallback((params: Connection) => {
    setEdges(eds => addEdge({
      ...params,
      markerEnd: { type: MarkerType.ArrowClosed },
      style: { stroke: '#7c5bf0' },
    }, eds));
  }, [setEdges]);

  const handleAddNode = useCallback(() => {
    const id = `step_${nextNodeId.current++}`;
    const newNode: Node<NodeData> = {
      id,
      type: 'pipeline',
      position: { x: 250, y: nodes.length * 150 + 50 },
      data: {
        label: id,
        project: varsProject ? '{{vars.project}}' : '',
        prompt: '',
        outputs: [],
        onEdit: (nid: string) => handleEditNode(nid),
        onDelete: (nid: string) => handleDeleteNode(nid),
      },
    };
    setNodes(nds => [...nds, newNode]);
  }, [nodes.length, varsProject, setNodes]);

  const handleEditNode = useCallback((id: string) => {
    setNodes(nds => {
      const node = nds.find(n => n.id === id);
      if (node) {
        setEditingNode({
          id: node.id,
          project: node.data.project,
          prompt: node.data.prompt,
          outputs: node.data.outputs,
        });
      }
      return nds;
    });
  }, [setNodes]);

  const handleDeleteNode = useCallback((id: string) => {
    setNodes(nds => nds.filter(n => n.id !== id));
    setEdges(eds => eds.filter(e => e.source !== id && e.target !== id));
  }, [setNodes, setEdges]);

  const handleSaveNode = useCallback((data: { id: string; project: string; prompt: string; agent?: string; mode?: string; outputs: { name: string; extract: string }[] }) => {
    setNodes(nds => nds.map(n => {
      if (n.id === editingNode?.id) {
        return {
          ...n,
          id: data.id,
          data: {
            ...n.data,
            label: data.id,
            project: data.project,
            prompt: data.prompt,
            agent: data.agent,
            mode: data.mode,
            outputs: data.outputs,
          },
        };
      }
      return n;
    }));
    // Update edges if id changed
    if (editingNode && data.id !== editingNode.id) {
      setEdges(eds => eds.map(e => ({
        ...e,
        id: e.id.replace(editingNode.id, data.id),
        source: e.source === editingNode.id ? data.id : e.source,
        target: e.target === editingNode.id ? data.id : e.target,
      })));
    }
    setEditingNode(null);
  }, [editingNode, setNodes, setEdges]);

  // Generate YAML from current state
  const generateYaml = useCallback(() => {
    const workflow: any = {
      name: workflowName,
      description: workflowDesc || undefined,
      vars: varsProject ? { project: varsProject } : undefined,
      nodes: {} as any,
    };

    for (const node of nodes) {
      const deps = edges.filter(e => e.target === node.id).map(e => e.source);
      const nodeDef: any = {
        project: node.data.project,
        prompt: node.data.prompt,
      };
      if ((node.data as any).mode === 'shell') nodeDef.mode = 'shell';
      if ((node.data as any).agent) nodeDef.agent = (node.data as any).agent;
      if (deps.length > 0) nodeDef.depends_on = deps;
      if (node.data.outputs.length > 0) nodeDef.outputs = node.data.outputs;
      workflow.nodes[node.id] = nodeDef;
    }

    const YAML = require('yaml');
    return YAML.stringify(workflow);
  }, [nodes, edges, workflowName, workflowDesc, varsProject]);

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-[#0a0a1a]">
      {/* Top bar */}
      <div className="h-10 border-b border-[#3a3a5a] flex items-center px-4 gap-3 shrink-0">
        <span className="text-xs font-semibold text-white">Pipeline Editor</span>
        <input
          value={workflowName}
          onChange={e => setWorkflowName(e.target.value)}
          className="text-xs bg-[#12122a] border border-[#3a3a5a] rounded px-2 py-0.5 text-white font-mono w-40"
          placeholder="Workflow name"
        />
        <input
          value={workflowDesc}
          onChange={e => setWorkflowDesc(e.target.value)}
          className="text-xs bg-[#12122a] border border-[#3a3a5a] rounded px-2 py-0.5 text-gray-400 flex-1"
          placeholder="Description (optional)"
        />
        <input
          value={varsProject}
          onChange={e => setVarsProject(e.target.value)}
          className="text-xs bg-[#12122a] border border-[#3a3a5a] rounded px-2 py-0.5 text-white font-mono w-32"
          placeholder="Default project"
        />
        <button
          onClick={handleAddNode}
          className="text-xs px-3 py-1 bg-[var(--accent)] text-white rounded hover:opacity-90"
        >
          + Node
        </button>
        <button
          onClick={() => onSave(generateYaml())}
          className="text-xs px-3 py-1 bg-green-600 text-white rounded hover:opacity-90"
        >
          Save
        </button>
        <button
          onClick={() => {
            if (confirm('Discard unsaved changes?')) onClose();
          }}
          className="text-xs px-3 py-1 text-gray-400 hover:text-white"
        >
          Cancel
        </button>
      </div>

      {/* Flow canvas */}
      <div className="flex-1">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          nodeTypes={nodeTypes}
          fitView
          deleteKeyCode="Delete"
          style={{ background: '#0a0a1a' }}
        >
          <Background color="#1a1a3a" gap={20} />
          <Controls />
        </ReactFlow>
      </div>

      {/* Edit modal */}
      {editingNode && (
        <NodeEditModal
          node={editingNode}
          projects={projects}
          agents={availableAgents}
          onSave={handleSaveNode}
          onClose={() => setEditingNode(null)}
        />
      )}
    </div>
  );
}
