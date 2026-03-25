'use client';

import { useState, useEffect, useMemo, useRef } from 'react';
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
import type { TaskLogEntry } from '@/src/types';

// ─── Colors ──────────────────────────────────────────────

const PALETTE = [
  { bg: '#1e2a4a', border: '#3b82f6', accent: '#60a5fa', running: '#fbbf24' },
  { bg: '#2a1e4a', border: '#8b5cf6', accent: '#a78bfa', running: '#fbbf24' },
  { bg: '#1e3a2a', border: '#22c55e', accent: '#4ade80', running: '#fbbf24' },
  { bg: '#3a2a1e', border: '#f97316', accent: '#fb923c', running: '#fbbf24' },
];

// ─── Task stream hook ────────────────────────────────────

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

// ─── Custom Nodes ────────────────────────────────────────

interface AgentNodeData {
  agentId: string;
  agent: string;
  role: string;
  colorIdx: number;
  status: 'idle' | 'running' | 'done' | 'failed';
  lastContent: string;
  taskId?: string;
  round: number;
  [key: string]: unknown;
}

function AgentExecutionNode({ data }: NodeProps<Node<AgentNodeData>>) {
  const p = PALETTE[data.colorIdx % PALETTE.length];
  const isRunning = data.status === 'running';
  const log = useTaskStream(data.taskId, isRunning);
  const logEndRef = useRef<HTMLDivElement>(null);
  useEffect(() => { logEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [log]);

  const borderColor = isRunning ? p.running : data.status === 'done' ? p.accent : data.status === 'failed' ? '#ef4444' : p.border;

  return (
    <div
      className={`rounded-xl shadow-lg ${isRunning ? 'ring-2 ring-yellow-400/40' : ''}`}
      style={{ background: p.bg, border: `2px solid ${borderColor}`, width: 280, minHeight: 120 }}
    >
      <Handle type="target" position={Position.Top} className="!w-3 !h-3" style={{ background: p.accent }} />

      {/* Header */}
      <div className="px-3 py-2 flex items-center gap-2" style={{ borderBottom: `1px solid ${p.border}` }}>
        <span className="text-[8px] px-1.5 py-0.5 rounded font-bold" style={{ background: `${p.accent}30`, color: p.accent }}>{data.agent}</span>
        <span className="text-xs font-bold text-white">{data.agentId}</span>
        {isRunning && <span className="text-[8px] text-yellow-400 animate-pulse ml-auto">● R{data.round}</span>}
        {data.status === 'done' && <span className="text-[8px] text-green-400 ml-auto">✓ R{data.round}</span>}
        {data.status === 'failed' && <span className="text-[8px] text-red-400 ml-auto">✗</span>}
        {data.status === 'idle' && <span className="text-[8px] text-gray-500 ml-auto">idle</span>}
      </div>

      {/* Role */}
      <div className="px-3 pt-1">
        <div className="text-[8px] text-gray-500 line-clamp-1">{data.role}</div>
      </div>

      {/* Content area — live log or last output */}
      <div className="px-3 py-2">
        {isRunning ? (
          <div className="max-h-[100px] overflow-y-auto text-[8px] font-mono space-y-0.5">
            {log.length === 0 ? (
              <div className="text-gray-500 italic">Starting...</div>
            ) : (
              log.slice(-15).map((entry, i) => (
                <div key={i} className={
                  entry.type === 'result' ? 'text-green-400' :
                  entry.subtype === 'error' ? 'text-red-400' :
                  entry.type === 'system' ? 'text-yellow-500/60' :
                  'text-gray-400'
                }>
                  {entry.type === 'assistant' && entry.subtype === 'tool_use'
                    ? `⚙ ${entry.tool || 'tool'}`
                    : entry.content.slice(0, 80)}{entry.content.length > 80 ? '...' : ''}
                </div>
              ))
            )}
            <div ref={logEndRef} />
          </div>
        ) : data.lastContent ? (
          <div className="text-[8px] text-gray-400 max-h-[80px] overflow-y-auto whitespace-pre-wrap line-clamp-5">
            {data.lastContent.slice(0, 300)}{data.lastContent.length > 300 ? '...' : ''}
          </div>
        ) : (
          <div className="text-[8px] text-gray-600 italic">Waiting for input...</div>
        )}
      </div>

      <Handle type="source" position={Position.Bottom} className="!w-3 !h-3" style={{ background: p.accent }} />
    </div>
  );
}

interface PromptNodeData { prompt: string; [key: string]: unknown }

function PromptExecutionNode({ data }: NodeProps<Node<PromptNodeData>>) {
  return (
    <div className="bg-[#1a2a1a] border-2 border-green-500/50 rounded-xl shadow-lg" style={{ width: 260 }}>
      <div className="px-3 py-2 border-b border-green-500/30 flex items-center gap-2">
        <span className="text-green-400 text-sm">▶</span>
        <span className="text-[10px] font-bold text-green-300">Initial Prompt</span>
      </div>
      <div className="px-3 py-2 text-[9px] text-gray-400 whitespace-pre-wrap line-clamp-3">{data.prompt}</div>
      <Handle type="source" position={Position.Bottom} className="!bg-green-400 !w-3 !h-3" />
    </div>
  );
}

interface StatusNodeData { label: string; status: string; round: number; maxRounds: number; [key: string]: unknown }

function StatusNode({ data }: NodeProps<Node<StatusNodeData>>) {
  const color = data.status === 'done' ? '#22c55e' : data.status === 'failed' ? '#ef4444' : data.status === 'running' ? '#fbbf24' : '#6b7280';
  return (
    <div className="rounded-xl shadow-lg" style={{ background: '#1a1a2a', border: `2px solid ${color}`, width: 200 }}>
      <Handle type="target" position={Position.Top} className="!w-3 !h-3" style={{ background: color }} />
      <div className="px-3 py-3 text-center">
        <div className="text-[10px] font-bold" style={{ color }}>{data.label}</div>
        <div className="text-[8px] text-gray-500 mt-0.5">R{data.round}/{data.maxRounds} · {data.status}</div>
      </div>
    </div>
  );
}

const executionNodeTypes = {
  agentExec: AgentExecutionNode,
  promptExec: PromptExecutionNode,
  statusExec: StatusNode,
};

// ─── Build graph from pipeline state ─────────────────────

function buildExecutionGraph(pipeline: any): { nodes: Node[]; edges: Edge[] } {
  const conv = pipeline.conversation;
  if (!conv) return { nodes: [], edges: [] };

  const config = conv.config;
  const messages = conv.messages || [];
  const agents = config.agents || [];
  const nodes: Node[] = [];
  const edges: Edge[] = [];

  const centerX = 300;
  const agentSpacing = 320;
  const totalWidth = (agents.length - 1) * agentSpacing;
  const startX = centerX - totalWidth / 2;

  // 1. Prompt node
  nodes.push({
    id: 'prompt',
    type: 'promptExec',
    position: { x: centerX - 130, y: 20 },
    data: { prompt: config.initialPrompt },
    draggable: true,
  });

  // 2. Agent nodes — with execution state
  agents.forEach((a: any, i: number) => {
    const agentMsgs = messages.filter((m: any) => m.agentId === a.id);
    const lastMsg = [...agentMsgs].reverse()[0];
    const status = lastMsg?.status === 'running' ? 'running' :
                   agentMsgs.some((m: any) => m.status === 'done') ? 'done' :
                   lastMsg?.status === 'failed' ? 'failed' : 'idle';
    const lastDone = [...agentMsgs].reverse().find((m: any) => m.status === 'done');

    nodes.push({
      id: `agent-${a.id}`,
      type: 'agentExec',
      position: { x: startX + i * agentSpacing - 140, y: 180 },
      data: {
        agentId: a.id,
        agent: a.agent,
        role: a.role || '',
        colorIdx: i,
        status,
        lastContent: lastDone?.content || '',
        taskId: lastMsg?.status === 'running' ? lastMsg.taskId : undefined,
        round: lastMsg?.round || 0,
      },
      draggable: true,
    });

    // Prompt → Agent
    edges.push({
      id: `prompt-agent-${a.id}`,
      source: 'prompt',
      target: `agent-${a.id}`,
      markerEnd: { type: MarkerType.ArrowClosed, color: '#22c55e' },
      style: { stroke: '#22c55e', strokeWidth: 2 },
      animated: status === 'running' || (i === 0 && pipeline.status === 'running' && !messages.length),
    });
  });

  // 3. Data flow edges between agents
  for (let i = 0; i < agents.length - 1; i++) {
    const fromId = agents[i].id;
    const toId = agents[i + 1].id;
    const fromMsgs = messages.filter((m: any) => m.agentId === fromId && m.status === 'done');
    const toMsgs = messages.filter((m: any) => m.agentId === toId);
    const isFlowing = fromMsgs.length > 0 && toMsgs.length > 0;
    const isActive = messages.some((m: any) => m.agentId === toId && m.status === 'running');
    const p = PALETTE[i % PALETTE.length];

    edges.push({
      id: `flow-${fromId}-${toId}`,
      source: `agent-${fromId}`,
      target: `agent-${toId}`,
      markerEnd: { type: MarkerType.ArrowClosed, color: p.accent },
      style: { stroke: p.accent, strokeWidth: 2, strokeDasharray: '6 3' },
      animated: isActive,
      label: isFlowing ? `context (R${Math.max(...fromMsgs.map((m: any) => m.round))})` : 'context →',
      labelStyle: { fill: p.accent, fontSize: 9, fontWeight: 600 },
      type: 'smoothstep',
    });
  }

  // 4. Loop back edge (last → first for next round)
  if (agents.length >= 2 && config.maxRounds > 1) {
    const lastAgent = agents[agents.length - 1];
    const firstAgent = agents[0];
    const lastDone = messages.filter((m: any) => m.agentId === lastAgent.id && m.status === 'done');
    const isLooping = lastDone.length > 0 && conv.currentRound > 1;

    edges.push({
      id: `loop-back`,
      source: `agent-${lastAgent.id}`,
      target: `agent-${firstAgent.id}`,
      markerEnd: { type: MarkerType.ArrowClosed, color: '#f97316' },
      style: { stroke: '#f97316', strokeWidth: 2, strokeDasharray: '8 4', opacity: isLooping ? 1 : 0.3 },
      animated: isLooping && pipeline.status === 'running',
      label: isLooping ? `round ${conv.currentRound}` : 'next round',
      labelStyle: { fill: '#f97316', fontSize: 9, fontWeight: 600 },
      type: 'smoothstep',
    });
  }

  // 5. Status node
  nodes.push({
    id: 'status',
    type: 'statusExec',
    position: { x: centerX - 100, y: 480 },
    data: {
      label: pipeline.status === 'done' ? 'Complete' : pipeline.status === 'failed' ? 'Failed' : pipeline.status === 'cancelled' ? 'Cancelled' : 'Running...',
      status: pipeline.status,
      round: conv.currentRound,
      maxRounds: config.maxRounds,
    },
    draggable: true,
  });

  // Agents → Status
  agents.forEach((a: any) => {
    edges.push({
      id: `agent-${a.id}-status`,
      source: `agent-${a.id}`,
      target: 'status',
      style: { stroke: '#6b7280', strokeWidth: 1, opacity: 0.3 },
      type: 'smoothstep',
    });
  });

  return { nodes, edges };
}

// ─── Main Component ──────────────────────────────────────

export default function ConversationGraphView({ pipeline }: { pipeline: any }) {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

  // Rebuild graph when pipeline updates
  useEffect(() => {
    const graph = buildExecutionGraph(pipeline);
    setNodes(graph.nodes);
    setEdges(graph.edges);
  }, [pipeline, setNodes, setEdges]);

  return (
    <div style={{ width: '100%', height: '100%', minHeight: 400 }} className="relative">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodeTypes={executionNodeTypes}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        nodesConnectable={false}
        style={{ background: '#0a0a1a' }}
        minZoom={0.3}
        maxZoom={2}
      >
        <Background color="#1a1a3a" gap={20} />
        <Controls />
      </ReactFlow>

      {/* Legend */}
      <div className="absolute bottom-4 left-4 bg-[#0a0a1a]/90 border border-[#3a3a5a] rounded-lg p-2.5 space-y-1 backdrop-blur-sm">
        <div className="text-[7px] font-bold text-gray-400 uppercase">Legend</div>
        <div className="flex items-center gap-2 text-[7px] text-gray-400">
          <span className="w-2 h-2 rounded-full bg-yellow-400 inline-block" /> Running
        </div>
        <div className="flex items-center gap-2 text-[7px] text-gray-400">
          <span className="w-2 h-2 rounded-full bg-green-400 inline-block" /> Done
        </div>
        <div className="flex items-center gap-2 text-[7px] text-gray-400">
          <span className="w-3 h-0.5 inline-block" style={{ borderBottom: '2px dashed #f97316' }} /> Round loop
        </div>
      </div>
    </div>
  );
}
