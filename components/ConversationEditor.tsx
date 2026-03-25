'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  Handle,
  Position,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  type NodeProps,
  MarkerType,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import YAML from 'yaml';

// ─── Color palette ────────────────────────────────────────

const AGENT_PALETTE = [
  { bg: '#1e2a4a', border: '#3b5998', accent: '#6b8cce', badge: 'bg-blue-500/20 text-blue-400' },
  { bg: '#2a1e4a', border: '#6b3fa0', accent: '#a07bd6', badge: 'bg-purple-500/20 text-purple-400' },
  { bg: '#1e3a2a', border: '#3a8a5a', accent: '#5ebd7e', badge: 'bg-green-500/20 text-green-400' },
  { bg: '#3a2a1e', border: '#a06030', accent: '#d09060', badge: 'bg-orange-500/20 text-orange-400' },
  { bg: '#3a1e2a', border: '#a03060', accent: '#d06090', badge: 'bg-pink-500/20 text-pink-400' },
];

// ─── Custom Nodes ─────────────────────────────────────────

interface PromptNodeData { label: string; prompt: string; [key: string]: unknown }
interface AgentNodeData { label: string; agentId: string; agent: string; role: string; colorIndex: number; [key: string]: unknown }
interface StopNodeData { label: string; condition: string; maxRounds: number; [key: string]: unknown }
interface ForgeNodeData { label: string; [key: string]: unknown }

function PromptNode({ data }: NodeProps<Node<PromptNodeData>>) {
  return (
    <div className="bg-[#1a2a1a] border-2 border-green-500/50 rounded-xl shadow-lg min-w-[220px] max-w-[300px]">
      <div className="px-4 py-2 border-b border-green-500/30 flex items-center gap-2">
        <span className="text-green-400 text-sm">▶</span>
        <span className="text-xs font-bold text-green-300">{data.label}</span>
      </div>
      <div className="px-4 py-2">
        <div className="text-[9px] text-gray-400 whitespace-pre-wrap line-clamp-3">{data.prompt || 'No prompt'}</div>
      </div>
      <Handle type="source" position={Position.Bottom} className="!bg-green-400 !w-3 !h-3" />
    </div>
  );
}

function AgentNode({ data }: NodeProps<Node<AgentNodeData>>) {
  const palette = AGENT_PALETTE[data.colorIndex % AGENT_PALETTE.length];
  return (
    <div
      className="rounded-xl shadow-lg min-w-[200px] max-w-[260px]"
      style={{ background: palette.bg, border: `2px solid ${palette.border}` }}
    >
      <Handle type="target" position={Position.Top} className="!w-3 !h-3" style={{ background: palette.accent }} />

      <div className="px-4 py-2 flex items-center gap-2" style={{ borderBottom: `1px solid ${palette.border}` }}>
        <span className={`text-[8px] px-1.5 py-0.5 rounded font-bold ${palette.badge}`}>{data.agent}</span>
        <span className="text-xs font-bold text-white">{data.agentId}</span>
      </div>
      <div className="px-4 py-2">
        <div className="text-[9px] text-gray-400 line-clamp-3">{data.role || 'No role defined'}</div>
      </div>

      <Handle type="source" position={Position.Bottom} className="!w-3 !h-3" style={{ background: palette.accent }} />
    </div>
  );
}

function ForgeNode({ data }: NodeProps<Node<ForgeNodeData>>) {
  return (
    <div className="bg-[#1a1a3a] border-2 border-[#7c5bf0]/60 rounded-xl shadow-lg min-w-[180px]">
      <Handle type="target" position={Position.Top} className="!bg-[#7c5bf0] !w-3 !h-3" />
      <div className="px-4 py-3 flex items-center gap-2 justify-center">
        <span className="text-[#7c5bf0] text-sm">⚡</span>
        <span className="text-xs font-bold text-[#7c5bf0]">{data.label}</span>
      </div>
      <Handle type="source" position={Position.Bottom} className="!bg-[#7c5bf0] !w-3 !h-3" />
    </div>
  );
}

function StopNode({ data }: NodeProps<Node<StopNodeData>>) {
  return (
    <div className="bg-[#2a1a1a] border-2 border-red-500/50 rounded-xl shadow-lg min-w-[200px]">
      <Handle type="target" position={Position.Top} className="!bg-red-400 !w-3 !h-3" />
      <div className="px-4 py-2 border-b border-red-500/30 flex items-center gap-2">
        <span className="text-red-400 text-sm">■</span>
        <span className="text-xs font-bold text-red-300">{data.label}</span>
      </div>
      <div className="px-4 py-2 space-y-0.5">
        {data.condition && <div className="text-[9px] text-gray-400">{data.condition}</div>}
        <div className="text-[8px] text-gray-500">Max {data.maxRounds} rounds</div>
      </div>
    </div>
  );
}

const nodeTypes = {
  prompt: PromptNode,
  agent: AgentNode,
  forge: ForgeNode,
  stop: StopNode,
};

// ─── Parse YAML → ReactFlow nodes/edges ───────────────────

interface ConvParsed {
  name: string;
  description?: string;
  input?: Record<string, string>;
  agents: { id: string; agent: string; role: string; project?: string }[];
  maxRounds: number;
  stopCondition?: string;
  initialPrompt: string;
}

function parseConvYaml(raw: string): ConvParsed | null {
  try {
    const p = YAML.parse(raw);
    if (!p || p.type !== 'conversation') return null;
    return {
      name: p.name || 'unnamed',
      description: p.description,
      input: p.input,
      agents: p.agents || [],
      maxRounds: p.max_rounds || p.maxRounds || 10,
      stopCondition: p.stop_condition || p.stopCondition || '',
      initialPrompt: p.initial_prompt || p.initialPrompt || '',
    };
  } catch { return null; }
}

function buildFlowGraph(conv: ConvParsed): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const agentCount = conv.agents.length;

  // Layout constants
  const centerX = 300;
  const startY = 30;
  const agentSpacing = 220;
  const verticalGap = 140;

  // 1. Initial Prompt node
  nodes.push({
    id: 'prompt',
    type: 'prompt',
    position: { x: centerX - 110, y: startY },
    data: { label: 'Initial Prompt', prompt: conv.initialPrompt },
    draggable: true,
  });

  // 2. Forge broker node
  const forgeY = startY + verticalGap;
  nodes.push({
    id: 'forge',
    type: 'forge',
    position: { x: centerX - 90, y: forgeY },
    data: { label: 'Forge Broker' },
    draggable: true,
  });

  edges.push({
    id: 'prompt-forge',
    source: 'prompt',
    target: 'forge',
    markerEnd: { type: MarkerType.ArrowClosed, color: '#5ebd7e' },
    style: { stroke: '#5ebd7e', strokeWidth: 2 },
    animated: true,
    label: 'start',
    labelStyle: { fill: '#888', fontSize: 9 },
  });

  // 3. Agent nodes — spread horizontally
  const agentY = forgeY + verticalGap;
  const totalWidth = (agentCount - 1) * agentSpacing;
  const agentStartX = centerX - totalWidth / 2;

  conv.agents.forEach((a, i) => {
    const x = agentStartX + i * agentSpacing - 100;
    nodes.push({
      id: `agent-${a.id}`,
      type: 'agent',
      position: { x, y: agentY },
      data: { label: a.id, agentId: a.id, agent: a.agent, role: a.role, colorIndex: i },
      draggable: true,
    });

    // Forge → Agent (send prompt)
    edges.push({
      id: `forge-agent-${a.id}`,
      source: 'forge',
      target: `agent-${a.id}`,
      markerEnd: { type: MarkerType.ArrowClosed, color: AGENT_PALETTE[i % AGENT_PALETTE.length].accent },
      style: { stroke: AGENT_PALETTE[i % AGENT_PALETTE.length].accent, strokeWidth: 2 },
      animated: true,
      label: `send R${i + 1}`,
      labelStyle: { fill: '#888', fontSize: 8 },
    });

    // Agent → Forge (response back) — curved
    edges.push({
      id: `agent-${a.id}-forge`,
      source: `agent-${a.id}`,
      target: 'forge',
      markerEnd: { type: MarkerType.ArrowClosed, color: AGENT_PALETTE[i % AGENT_PALETTE.length].accent },
      style: { stroke: AGENT_PALETTE[i % AGENT_PALETTE.length].accent, strokeWidth: 1, strokeDasharray: '6 3' },
      animated: true,
      label: 'response',
      labelStyle: { fill: '#666', fontSize: 8 },
      type: 'smoothstep',
    });
  });

  // 4. Inter-agent data flow edges (Agent A output → Agent B input via Forge)
  if (agentCount >= 2) {
    for (let i = 0; i < agentCount - 1; i++) {
      const from = conv.agents[i];
      const to = conv.agents[i + 1];
      edges.push({
        id: `flow-${from.id}-${to.id}`,
        source: `agent-${from.id}`,
        target: `agent-${to.id}`,
        markerEnd: { type: MarkerType.ArrowClosed, color: '#7c5bf0' },
        style: { stroke: '#7c5bf0', strokeWidth: 2, strokeDasharray: '4 4' },
        animated: true,
        label: 'context →',
        labelStyle: { fill: '#7c5bf0', fontSize: 9, fontWeight: 600 },
        type: 'smoothstep',
      });
    }
    // Loop back: last agent → first agent (next round)
    if (conv.maxRounds > 1) {
      edges.push({
        id: `loop-${conv.agents[agentCount - 1].id}-${conv.agents[0].id}`,
        source: `agent-${conv.agents[agentCount - 1].id}`,
        target: `agent-${conv.agents[0].id}`,
        markerEnd: { type: MarkerType.ArrowClosed, color: '#d09060' },
        style: { stroke: '#d09060', strokeWidth: 2, strokeDasharray: '8 4' },
        animated: true,
        label: `next round`,
        labelStyle: { fill: '#d09060', fontSize: 9, fontWeight: 600 },
        type: 'smoothstep',
      });
    }
  }

  // 5. Stop condition node
  const stopY = agentY + verticalGap + 20;
  nodes.push({
    id: 'stop',
    type: 'stop',
    position: { x: centerX - 100, y: stopY },
    data: { label: 'Stop Condition', condition: conv.stopCondition || 'max rounds reached', maxRounds: conv.maxRounds },
    draggable: true,
  });

  // All agents → stop
  conv.agents.forEach((a, i) => {
    edges.push({
      id: `agent-${a.id}-stop`,
      source: `agent-${a.id}`,
      target: 'stop',
      markerEnd: { type: MarkerType.ArrowClosed, color: '#ef4444' },
      style: { stroke: '#ef4444', strokeWidth: 1, opacity: 0.4 },
      label: 'DONE?',
      labelStyle: { fill: '#666', fontSize: 7 },
      type: 'smoothstep',
    });
  });

  return { nodes, edges };
}

// ─── Main Component ───────────────────────────────────────

export default function ConversationEditor({ initialYaml, onSave, onClose }: {
  initialYaml: string;
  onSave: (yaml: string) => void;
  onClose: () => void;
}) {
  const [yamlText, setYamlText] = useState(initialYaml);
  const [error, setError] = useState('');
  const [showYaml, setShowYaml] = useState(false);
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

  const parsed = useMemo(() => parseConvYaml(yamlText), [yamlText]);

  // Rebuild graph when YAML changes
  useEffect(() => {
    if (!parsed) { setNodes([]); setEdges([]); return; }
    const graph = buildFlowGraph(parsed);
    setNodes(graph.nodes);
    setEdges(graph.edges);
  }, [parsed, setNodes, setEdges]);

  const validate = (text: string): string => {
    try {
      const p = YAML.parse(text);
      if (!p.name) return 'Missing "name"';
      if (p.type !== 'conversation') return 'type must be "conversation"';
      if (!p.agents || !Array.isArray(p.agents) || p.agents.length < 2) return 'Need at least 2 agents';
      for (const a of p.agents) {
        if (!a.id) return 'Agent missing "id"';
        if (!a.agent) return `Agent "${a.id}" missing "agent"`;
      }
      if (!p.initial_prompt && !p.initialPrompt) return 'Missing "initial_prompt"';
      return '';
    } catch (e: any) {
      return `YAML error: ${e.message}`;
    }
  };

  const handleSave = () => {
    const err = validate(yamlText);
    if (err) { setError(err); return; }
    onSave(yamlText);
  };

  return (
    <div className="flex-1 flex flex-col min-h-0" style={{ background: '#0a0a1a' }}>
      {/* Top bar */}
      <div className="h-10 border-b border-[#3a3a5a] flex items-center px-4 gap-3 shrink-0">
        <span className="text-xs font-bold text-white">Conversation Editor</span>
        {parsed && <span className="text-[10px] text-gray-400 font-mono">{parsed.name}</span>}
        {parsed && (
          <span className="text-[8px] px-1.5 py-0.5 rounded bg-purple-500/20 text-purple-400">
            {parsed.agents.length} agents · {parsed.maxRounds} rounds
          </span>
        )}
        <div className="flex-1" />
        {error && <span className="text-[9px] text-red-400 truncate max-w-[250px]">{error}</span>}
        <button
          onClick={() => setShowYaml(v => !v)}
          className={`text-[10px] px-2 py-0.5 rounded border ${showYaml ? 'border-[#7c5bf0] text-[#7c5bf0]' : 'border-[#3a3a5a] text-gray-400'} hover:text-white`}
        >{showYaml ? 'Graph' : 'YAML'}</button>
        <button onClick={handleSave} className="text-xs px-3 py-1 bg-green-600 text-white rounded hover:opacity-90">Save</button>
        <button
          onClick={() => { if (!yamlText || yamlText === initialYaml || confirm('Discard changes?')) onClose(); }}
          className="text-xs px-3 py-1 text-gray-400 hover:text-white"
        >Close</button>
      </div>

      {/* Content */}
      {showYaml ? (
        <textarea
          value={yamlText}
          onChange={e => { setYamlText(e.target.value); setError(''); }}
          className="flex-1 p-4 text-xs font-mono bg-[#0a0a1a] text-gray-300 resize-none focus:outline-none leading-relaxed"
          spellCheck={false}
        />
      ) : (
        <div className="flex-1 relative">
          {parsed ? (
            <ReactFlow
              nodes={nodes}
              edges={edges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              nodeTypes={nodeTypes}
              fitView
              fitViewOptions={{ padding: 0.3 }}
              nodesConnectable={false}
              style={{ background: '#0a0a1a' }}
              minZoom={0.3}
              maxZoom={2}
            >
              <Background color="#1a1a3a" gap={20} />
              <Controls />
            </ReactFlow>
          ) : (
            <div className="flex-1 flex items-center justify-center h-full">
              <div className="text-center space-y-2">
                <div className="text-sm text-gray-500">Invalid or empty conversation YAML</div>
                <button
                  onClick={() => setShowYaml(true)}
                  className="text-xs px-3 py-1 bg-[#7c5bf0] text-white rounded hover:opacity-90"
                >Edit YAML</button>
              </div>
            </div>
          )}

          {/* Floating legend */}
          {parsed && (
            <div className="absolute bottom-4 left-4 bg-[#0a0a1a]/90 border border-[#3a3a5a] rounded-lg p-3 space-y-1.5 backdrop-blur-sm">
              <div className="text-[8px] font-bold text-gray-400 uppercase">Legend</div>
              <div className="flex items-center gap-2 text-[8px] text-gray-400">
                <span className="w-3 h-0.5 bg-green-500 inline-block" /> Initial prompt
              </div>
              <div className="flex items-center gap-2 text-[8px] text-gray-400">
                <span className="w-3 h-0.5 bg-[#7c5bf0] inline-block" style={{ borderBottom: '2px dashed #7c5bf0' }} /> Context flow
              </div>
              <div className="flex items-center gap-2 text-[8px] text-gray-400">
                <span className="w-3 h-0.5 bg-orange-500 inline-block" style={{ borderBottom: '2px dashed #d09060' }} /> Next round loop
              </div>
              <div className="flex items-center gap-2 text-[8px] text-gray-400">
                <span className="w-3 h-0.5 bg-red-500/40 inline-block" /> Stop check
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
