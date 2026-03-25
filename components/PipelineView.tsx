'use client';

import { useState, useEffect, useCallback, useRef, lazy, Suspense } from 'react';
import { useSidebarResize } from '@/hooks/useSidebarResize';
import type { TaskLogEntry } from '@/src/types';

const PipelineEditor = lazy(() => import('./PipelineEditor'));
const ConversationEditor = lazy(() => import('./ConversationEditor'));

// ─── Live Task Log Hook ──────────────────────────────────
// Subscribes to SSE stream for a running task, returns live log entries
function useTaskStream(taskId: string | undefined, isRunning: boolean) {
  const [log, setLog] = useState<TaskLogEntry[]>([]);
  const [status, setStatus] = useState<string>('');

  useEffect(() => {
    if (!taskId || !isRunning) { setLog([]); return; }

    const es = new EventSource(`/api/tasks/${taskId}/stream`);
    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'log') setLog(prev => [...prev, data.entry]);
        else if (data.type === 'status') setStatus(data.status);
        else if (data.type === 'complete' && data.task) setLog(data.task.log);
      } catch {}
    };
    es.onerror = () => es.close();
    return () => es.close();
  }, [taskId, isRunning]);

  return { log, status };
}

// ─── Compact log renderer ─────────────────────────────────
function LiveLog({ log, maxHeight = 200 }: { log: TaskLogEntry[]; maxHeight?: number }) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [log]);

  if (log.length === 0) return <div className="text-[10px] text-[var(--text-secondary)] italic">Starting...</div>;

  return (
    <div className="overflow-y-auto text-[9px] font-mono leading-relaxed space-y-0.5" style={{ maxHeight }}>
      {log.slice(-50).map((entry, i) => (
        <div key={i} className={
          entry.type === 'result' ? 'text-green-400' :
          entry.subtype === 'error' ? 'text-red-400' :
          entry.type === 'system' ? 'text-yellow-400/70' :
          'text-[var(--text-secondary)]'
        }>
          {entry.type === 'assistant' && entry.subtype === 'tool_use'
            ? `⚙ ${entry.tool || 'tool'}: ${entry.content.slice(0, 80)}${entry.content.length > 80 ? '...' : ''}`
            : entry.content.slice(0, 200)}{entry.content.length > 200 ? '...' : ''}
        </div>
      ))}
      <div ref={endRef} />
    </div>
  );
}

interface WorkflowNode {
  id: string;
  project: string;
  prompt: string;
  mode?: 'claude' | 'shell';
  agent?: string;
  branch?: string;
  dependsOn: string[];
  outputs: { name: string; extract: string }[];
  routes: { condition: string; next: string }[];
  maxIterations: number;
}

interface Workflow {
  name: string;
  type?: 'dag' | 'conversation';
  description?: string;
  builtin?: boolean;
  vars: Record<string, string>;
  input: Record<string, string>;
  nodes: Record<string, WorkflowNode>;
  conversation?: {
    agents: { id: string; agent: string; role: string }[];
    maxRounds: number;
    stopCondition?: string;
    initialPrompt: string;
  };
}

interface PipelineNodeState {
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
  taskId?: string;
  outputs: Record<string, string>;
  iterations: number;
  startedAt?: string;
  completedAt?: string;
  error?: string;
}

interface ConversationMessage {
  round: number;
  agentId: string;
  agentName: string;
  content: string;
  timestamp: string;
  taskId?: string;
  status: 'pending' | 'running' | 'done' | 'failed';
}

interface Pipeline {
  id: string;
  workflowName: string;
  type?: 'dag' | 'conversation';
  status: 'running' | 'done' | 'failed' | 'cancelled';
  input: Record<string, string>;
  vars: Record<string, string>;
  nodes: Record<string, PipelineNodeState>;
  nodeOrder: string[];
  createdAt: string;
  completedAt?: string;
  conversation?: {
    config: {
      agents: { id: string; agent: string; role: string; project?: string }[];
      maxRounds: number;
      stopCondition?: string;
      initialPrompt: string;
    };
    messages: ConversationMessage[];
    currentRound: number;
    currentAgentIndex: number;
  };
}

const STATUS_ICON: Record<string, string> = {
  pending: '⏳',
  running: '🔄',
  done: '✅',
  failed: '❌',
  skipped: '⏭',
};

const STATUS_COLOR: Record<string, string> = {
  pending: 'text-gray-400',
  running: 'text-yellow-400',
  done: 'text-green-400',
  failed: 'text-red-400',
  skipped: 'text-gray-500',
};

// ─── DAG Node Card with live logs ─────────────────────────

function DagNodeCard({ nodeId, node, nodeDef, onViewTask }: {
  nodeId: string;
  node: PipelineNodeState;
  nodeDef?: WorkflowNode;
  onViewTask?: (taskId: string) => void;
}) {
  const isRunning = node.status === 'running';
  const { log } = useTaskStream(node.taskId, isRunning);

  return (
    <div className={`border rounded-lg p-3 ${
      isRunning ? 'border-yellow-500/50 bg-yellow-500/5' :
      node.status === 'done' ? 'border-green-500/30 bg-green-500/5' :
      node.status === 'failed' ? 'border-red-500/30 bg-red-500/5' :
      'border-[var(--border)]'
    }`}>
      <div className="flex items-center gap-2">
        <span className={STATUS_COLOR[node.status]}>{STATUS_ICON[node.status]}</span>
        <span className="text-xs font-semibold text-[var(--text-primary)]">{nodeId}</span>
        {nodeDef && nodeDef.mode !== 'shell' && (
          <span className="text-[8px] px-1 rounded bg-purple-500/20 text-purple-400">{nodeDef.agent || 'default'}</span>
        )}
        {node.taskId && (
          <button onClick={() => onViewTask?.(node.taskId!)} className="text-[9px] text-[var(--accent)] font-mono hover:underline">
            task:{node.taskId}
          </button>
        )}
        {node.iterations > 1 && <span className="text-[9px] text-yellow-400">iter {node.iterations}</span>}
        <span className="text-[9px] text-[var(--text-secondary)] ml-auto">{node.status}</span>
      </div>

      {/* Live log for running nodes */}
      {isRunning && (
        <div className="mt-2 p-2 bg-[var(--bg-tertiary)] rounded">
          <LiveLog log={log} maxHeight={160} />
        </div>
      )}

      {node.error && <div className="text-[10px] text-red-400 mt-1">{node.error}</div>}

      {/* Outputs */}
      {Object.keys(node.outputs).length > 0 && (
        <div className="mt-2 space-y-1">
          {Object.entries(node.outputs).map(([key, val]) => (
            <details key={key} className="text-[10px]">
              <summary className="cursor-pointer text-[var(--accent)]">output: {key} ({val.length} chars)</summary>
              <pre className="mt-1 p-2 bg-[var(--bg-tertiary)] rounded text-[9px] text-[var(--text-secondary)] max-h-32 overflow-auto whitespace-pre-wrap">
                {val.slice(0, 1000)}{val.length > 1000 ? '...' : ''}
              </pre>
            </details>
          ))}
        </div>
      )}

      {node.startedAt && (
        <div className="text-[8px] text-[var(--text-secondary)] mt-1">
          {`Started: ${new Date(node.startedAt).toLocaleTimeString()}`}
          {node.completedAt && ` · Done: ${new Date(node.completedAt).toLocaleTimeString()}`}
        </div>
      )}
    </div>
  );
}

// ─── Agent color palette for conversation bubbles ────────
const AGENT_COLORS = [
  { bg: 'bg-blue-500/10', border: 'border-blue-500/30', badge: 'bg-blue-500/20 text-blue-400', dot: 'text-blue-400' },
  { bg: 'bg-purple-500/10', border: 'border-purple-500/30', badge: 'bg-purple-500/20 text-purple-400', dot: 'text-purple-400' },
  { bg: 'bg-green-500/10', border: 'border-green-500/30', badge: 'bg-green-500/20 text-green-400', dot: 'text-green-400' },
  { bg: 'bg-orange-500/10', border: 'border-orange-500/30', badge: 'bg-orange-500/20 text-orange-400', dot: 'text-orange-400' },
  { bg: 'bg-pink-500/10', border: 'border-pink-500/30', badge: 'bg-pink-500/20 text-pink-400', dot: 'text-pink-400' },
];

function ConversationMessageBubble({ msg, colors, agentDef, isLeft, onViewTask }: {
  msg: ConversationMessage; colors: typeof AGENT_COLORS[0]; agentDef?: { id: string; role: string };
  isLeft: boolean; onViewTask?: (taskId: string) => void;
}) {
  const isRunning = msg.status === 'running';
  const { log } = useTaskStream(msg.taskId, isRunning);

  return (
    <div className={`flex ${isLeft ? 'justify-start' : 'justify-end'}`}>
      <div className={`max-w-[85%] border rounded-lg p-3 ${colors.bg} ${colors.border}`}>
        {/* Agent header */}
        <div className="flex items-center gap-2 mb-1.5">
          <span className={`text-[9px] px-1.5 py-0.5 rounded font-medium ${colors.badge}`}>{msg.agentName}</span>
          <span className="text-[8px] text-[var(--text-secondary)]">
            {msg.agentId}{agentDef?.role ? ` — ${agentDef.role.slice(0, 40)}${agentDef.role.length > 40 ? '...' : ''}` : ''}
          </span>
          {isRunning && <span className="text-[8px] text-yellow-400 animate-pulse">● running</span>}
          <span className="text-[8px] text-[var(--text-secondary)] ml-auto">R{msg.round}</span>
        </div>

        {/* Content */}
        {isRunning ? (
          <LiveLog log={log} maxHeight={250} />
        ) : msg.status === 'failed' ? (
          <div className="text-[10px] text-red-400">{msg.content || 'Failed'}</div>
        ) : (
          <div className="text-[10px] text-[var(--text-primary)] whitespace-pre-wrap leading-relaxed">
            {msg.content.slice(0, 3000)}{msg.content.length > 3000 ? '\n\n[... truncated]' : ''}
          </div>
        )}

        {/* Footer */}
        <div className="flex items-center gap-2 mt-1.5">
          {msg.taskId && (
            <button onClick={() => onViewTask?.(msg.taskId!)} className="text-[8px] text-[var(--accent)] font-mono hover:underline">
              task:{msg.taskId}
            </button>
          )}
          <span className="text-[7px] text-[var(--text-secondary)] ml-auto">{new Date(msg.timestamp).toLocaleTimeString()}</span>
        </div>
      </div>
    </div>
  );
}

const ConversationGraphView = lazy(() => import('./ConversationGraphView'));

function ConversationView({ pipeline, onViewTask }: { pipeline: Pipeline; onViewTask?: (taskId: string) => void }) {
  const conv = pipeline.conversation!;
  const { config, messages, currentRound } = conv;
  const [injectText, setInjectText] = useState('');
  const [injectTarget, setInjectTarget] = useState(config.agents[0]?.id || '');
  const [injecting, setInjecting] = useState(false);
  const [viewMode, setViewMode] = useState<'graph' | 'chat'>('graph');
  const scrollRef = useRef<HTMLDivElement>(null);

  // Assign stable colors per agent
  const agentColorMap: Record<string, typeof AGENT_COLORS[0]> = {};
  config.agents.forEach((a, i) => {
    agentColorMap[a.id] = AGENT_COLORS[i % AGENT_COLORS.length];
  });

  // Auto-scroll on new messages
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages.length]);

  const handleInject = async () => {
    if (!injectText.trim() || injecting) return;
    setInjecting(true);
    try {
      await fetch(`/api/pipelines/${pipeline.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'inject', agentId: injectTarget, message: injectText }),
      });
      setInjectText('');
    } catch {}
    setInjecting(false);
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Conversation info bar */}
      <div className="px-4 py-2 border-b border-[var(--border)] bg-[var(--bg-tertiary)]/50 shrink-0">
        <div className="flex items-center gap-3">
          <span className="text-[9px] px-1.5 py-0.5 rounded bg-[var(--accent)]/20 text-[var(--accent)] font-medium">Conversation</span>
          <span className="text-[9px] text-[var(--text-secondary)]">Round {currentRound}/{config.maxRounds}</span>
          <div className="flex items-center gap-2 ml-auto">
            {/* View mode toggle */}
            <div className="flex border border-[var(--border)] rounded overflow-hidden">
              <button
                onClick={() => setViewMode('graph')}
                className={`text-[8px] px-2 py-0.5 ${viewMode === 'graph' ? 'bg-[var(--accent)]/20 text-[var(--accent)]' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'}`}
              >Graph</button>
              <button
                onClick={() => setViewMode('chat')}
                className={`text-[8px] px-2 py-0.5 ${viewMode === 'chat' ? 'bg-[var(--accent)]/20 text-[var(--accent)]' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'}`}
              >Chat</button>
            </div>
            {config.agents.map(a => {
              const colors = agentColorMap[a.id];
              const isRunning = messages.some(m => m.agentId === a.id && m.status === 'running');
              return (
                <span key={a.id} className={`text-[8px] px-1.5 py-0.5 rounded ${colors.badge} ${isRunning ? 'ring-1 ring-yellow-400/50' : ''}`}>
                  {isRunning ? '● ' : ''}{a.id} ({a.agent})
                </span>
              );
            })}
          </div>
        </div>
        {config.stopCondition && (
          <div className="text-[8px] text-[var(--text-secondary)] mt-1">Stop: {config.stopCondition}</div>
        )}
      </div>

      {/* Graph or Chat view */}
      {viewMode === 'graph' ? (
        <div className="flex-1 min-h-0">
          <Suspense fallback={<div className="flex items-center justify-center h-full text-xs text-[var(--text-secondary)]">Loading graph...</div>}>
            <ConversationGraphView pipeline={pipeline} />
          </Suspense>
        </div>
      ) : (
        <>
          {/* Initial prompt */}
          <div className="px-4 pt-3">
            <div className="border border-[var(--border)] rounded-lg p-3 bg-[var(--bg-tertiary)]/50">
              <div className="text-[9px] text-[var(--text-secondary)] font-medium mb-1">Initial Prompt</div>
              <div className="text-[11px] text-[var(--text-primary)] whitespace-pre-wrap">{config.initialPrompt}</div>
            </div>
          </div>

          {/* Messages — chat-like view with live logs */}
          <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
            {messages.map((msg, i) => {
              const colors = agentColorMap[msg.agentId] || AGENT_COLORS[0];
              const agentDef = config.agents.find(a => a.id === msg.agentId);
              const isLeft = config.agents.indexOf(agentDef!) % 2 === 0;

              return (
                <ConversationMessageBubble
                  key={`${msg.taskId || i}-${msg.status}`}
                  msg={msg}
                  colors={colors}
                  agentDef={agentDef}
                  isLeft={isLeft}
                  onViewTask={onViewTask}
                />
              );
            })}

            {/* Completion indicator */}
            {pipeline.status === 'done' && (
              <div className="flex justify-center py-2">
                <span className="text-[10px] px-3 py-1 rounded-full bg-green-500/10 text-green-400 border border-green-500/30">
                  Conversation complete — {messages.length} messages in {Math.max(...messages.map(m => m.round), 0)} rounds
                </span>
              </div>
            )}
            {pipeline.status === 'failed' && (
              <div className="flex justify-center py-2">
                <span className="text-[10px] px-3 py-1 rounded-full bg-red-500/10 text-red-400 border border-red-500/30">
                  Conversation failed
                </span>
              </div>
            )}
          </div>
        </>
      )}

      {/* Inject command bar */}
      {pipeline.status === 'running' && (
        <div className="px-4 py-2 border-t border-[var(--border)] bg-[var(--bg-tertiary)]/50 shrink-0">
          <div className="flex items-center gap-2">
            <select
              value={injectTarget}
              onChange={e => setInjectTarget(e.target.value)}
              className="text-[10px] bg-[var(--bg-tertiary)] border border-[var(--border)] rounded px-2 py-1 text-[var(--text-primary)]"
            >
              {config.agents.map(a => (
                <option key={a.id} value={a.id}>@{a.id}</option>
              ))}
            </select>
            <input
              value={injectText}
              onChange={e => setInjectText(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && !e.shiftKey && handleInject()}
              placeholder="Send instruction to agent..."
              className="flex-1 text-[10px] bg-[var(--bg-primary)] border border-[var(--border)] rounded px-2 py-1 text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)]"
            />
            <button
              onClick={handleInject}
              disabled={!injectText.trim() || injecting}
              className="text-[10px] px-3 py-1 bg-[var(--accent)] text-white rounded hover:opacity-90 disabled:opacity-50"
            >Send</button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function PipelineView({ onViewTask, focusPipelineId, onFocusHandled }: { onViewTask?: (taskId: string) => void; focusPipelineId?: string | null; onFocusHandled?: () => void }) {
  const { sidebarWidth, onSidebarDragStart } = useSidebarResize({ defaultWidth: 256, minWidth: 140, maxWidth: 480 });
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [selectedPipeline, setSelectedPipeline] = useState<Pipeline | null>(null);
  const [activeWorkflow, setActiveWorkflow] = useState<string | null>(null); // selected workflow in left panel
  const [showCreate, setShowCreate] = useState(false);
  const [selectedWorkflow, setSelectedWorkflow] = useState<string>('');
  const [projects, setProjects] = useState<{ name: string; path: string }[]>([]);
  const [inputValues, setInputValues] = useState<Record<string, string>>({});
  const [creating, setCreating] = useState(false);
  const [showEditor, setShowEditor] = useState(false);
  const [editorYaml, setEditorYaml] = useState<string | undefined>(undefined);
  const [editorIsConversation, setEditorIsConversation] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [importYaml, setImportYaml] = useState('');
  const [agents, setAgents] = useState<{ id: string; name: string; detected?: boolean }[]>([]);

  const fetchData = useCallback(async () => {
    const [pRes, wRes, projRes, agentRes] = await Promise.all([
      fetch('/api/pipelines'),
      fetch('/api/pipelines?type=workflows'),
      fetch('/api/projects'),
      fetch('/api/agents'),
    ]);
    const pData = await pRes.json();
    const wData = await wRes.json();
    const projData = await projRes.json();
    const agentData = await agentRes.json();
    if (Array.isArray(pData)) setPipelines(pData);
    if (Array.isArray(wData)) setWorkflows(wData);
    if (Array.isArray(projData)) setProjects(projData.map((p: any) => ({ name: p.name, path: p.path })));
    if (Array.isArray(agentData?.agents)) setAgents(agentData.agents);
  }, []);

  useEffect(() => {
    fetchData();
    const timer = setInterval(fetchData, 5000);
    return () => clearInterval(timer);
  }, [fetchData]);

  // Focus on a specific pipeline (from external navigation)
  useEffect(() => {
    if (!focusPipelineId || pipelines.length === 0) return;
    const target = pipelines.find(p => p.id === focusPipelineId);
    if (target) {
      setSelectedPipeline(target);
      setShowEditor(false);
      onFocusHandled?.();
    }
  }, [focusPipelineId, pipelines, onFocusHandled]);

  // Refresh selected pipeline
  useEffect(() => {
    if (!selectedPipeline || selectedPipeline.status !== 'running') return;
    const timer = setInterval(async () => {
      const res = await fetch(`/api/pipelines/${selectedPipeline.id}`);
      const data = await res.json();
      if (data.id) setSelectedPipeline(data);
    }, 3000);
    return () => clearInterval(timer);
  }, [selectedPipeline?.id, selectedPipeline?.status]);

  const handleCreate = async () => {
    if (!selectedWorkflow) return;
    setCreating(true);
    try {
      const res = await fetch('/api/pipelines', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workflow: selectedWorkflow, input: inputValues }),
      });
      const data = await res.json();
      if (data.id) {
        setSelectedPipeline(data);
        setShowCreate(false);
        setInputValues({});
        fetchData();
      }
    } catch {}
    setCreating(false);
  };

  const handleCancel = async (id: string) => {
    await fetch(`/api/pipelines/${id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'cancel' }),
    });
    fetchData();
    if (selectedPipeline?.id === id) {
      const res = await fetch(`/api/pipelines/${id}`);
      setSelectedPipeline(await res.json());
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this pipeline?')) return;
    await fetch(`/api/pipelines/${id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'delete' }),
    });
    if (selectedPipeline?.id === id) setSelectedPipeline(null);
    fetchData();
  };

  const generateConversationTemplate = () => {
    const detectedAgents = agents.filter(a => a.detected);
    const agentEntries = detectedAgents.length >= 2
      ? detectedAgents.slice(0, 2)
      : [{ id: 'claude', name: 'Claude Code' }, { id: 'claude', name: 'Claude Code' }];

    return `name: my-conversation
type: conversation
description: "Multi-agent collaboration"
input:
  project: "Project name"
  task: "Task description"
agents:
  - id: designer
    agent: ${agentEntries[0].id}
    role: "You are a software architect. Design the solution and review implementations."
  - id: builder
    agent: ${agentEntries[1].id}
    role: "You are a developer. Implement what the designer proposes."
max_rounds: 5
stop_condition: "both agents say DONE"
initial_prompt: "{{input.task}}"
`;
  };

  const currentWorkflow = workflows.find(w => w.name === selectedWorkflow);

  return (
    <div className="flex-1 flex min-h-0">
      {/* Left — Workflow list */}
      <aside style={{ width: sidebarWidth }} className="flex flex-col shrink-0 overflow-hidden">
        <div className="px-3 py-2 border-b border-[var(--border)] flex items-center gap-1.5">
          <span className="text-[11px] font-semibold text-[var(--text-primary)] flex-1">Workflows</span>
          <button
            onClick={() => setShowImport(v => !v)}
            className="text-[9px] text-green-400 hover:underline"
          >Import</button>
          <button
            onClick={() => { setEditorYaml(undefined); setEditorIsConversation(false); setShowEditor(true); }}
            className="text-[9px] text-[var(--accent)] hover:underline"
          >+ DAG</button>
          <button
            onClick={() => { setImportYaml(generateConversationTemplate()); setShowImport(true); }}
            className="text-[9px] text-purple-400 hover:underline"
          >+ Conversation</button>
        </div>

        {/* Import form */}
        {showImport && (
          <div className="p-3 border-b border-[var(--border)] space-y-2">
            <textarea
              value={importYaml}
              onChange={e => setImportYaml(e.target.value)}
              placeholder="Paste YAML workflow here..."
              className="w-full h-40 text-xs font-mono bg-[var(--bg-tertiary)] border border-[var(--border)] rounded p-2 text-[var(--text-primary)] resize-none focus:outline-none focus:border-[var(--accent)]"
              spellCheck={false}
            />
            <div className="flex gap-2">
              <button
                onClick={async () => {
                  if (!importYaml.trim()) return;
                  try {
                    const res = await fetch('/api/pipelines', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ action: 'save-workflow', yaml: importYaml }),
                    });
                    const data = await res.json();
                    if (data.ok) {
                      setShowImport(false);
                      setImportYaml('');
                      fetchData();
                      alert(`Workflow "${data.name}" imported successfully`);
                    } else {
                      alert(`Import failed: ${data.error}`);
                    }
                  } catch { alert('Import failed'); }
                }}
                disabled={!importYaml.trim()}
                className="text-[10px] px-3 py-1 bg-[var(--accent)] text-white rounded hover:opacity-90 disabled:opacity-50"
              >Save Workflow</button>
              <button
                onClick={() => { setShowImport(false); setImportYaml(''); }}
                className="text-[10px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
              >Cancel</button>
            </div>
          </div>
        )}

        {/* Create form */}
        {showCreate && (
          <div className="p-3 border-b border-[var(--border)] space-y-2">
            <select
              value={selectedWorkflow}
              onChange={e => { setSelectedWorkflow(e.target.value); setInputValues({}); }}
              className="w-full text-xs bg-[var(--bg-tertiary)] border border-[var(--border)] rounded px-2 py-1.5 text-[var(--text-primary)]"
            >
              <option value="">Select workflow...</option>
              {workflows.map(w => (
                <option key={w.name} value={w.name}>{w.builtin ? '[Built-in] ' : ''}{w.name}{w.description ? ` — ${w.description}` : ''}</option>
              ))}
            </select>

            {/* Input fields — project fields get a dropdown */}
            {currentWorkflow && Object.keys(currentWorkflow.input).length > 0 && (
              <div className="space-y-1.5">
                {Object.entries(currentWorkflow.input).map(([key, desc]) => (
                  <div key={key}>
                    <label className="text-[9px] text-[var(--text-secondary)]">{key}: {desc}</label>
                    {key.toLowerCase() === 'project' ? (
                      <select
                        value={inputValues[key] || ''}
                        onChange={e => setInputValues(prev => ({ ...prev, [key]: e.target.value }))}
                        className="w-full text-xs bg-[var(--bg-tertiary)] border border-[var(--border)] rounded px-2 py-1.5 text-[var(--text-primary)]"
                      >
                        <option value="">Select project...</option>
                        {projects.map(p => <option key={p.path} value={p.name}>{p.name}</option>)}
                      </select>
                    ) : (
                      <input
                        value={inputValues[key] || ''}
                        onChange={e => setInputValues(prev => ({ ...prev, [key]: e.target.value }))}
                        className="w-full text-xs bg-[var(--bg-tertiary)] border border-[var(--border)] rounded px-2 py-1 text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)]"
                      />
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* Workflow preview */}
            {currentWorkflow && (
              <div className="text-[9px] text-[var(--text-secondary)] space-y-0.5">
                {Object.entries(currentWorkflow.nodes).map(([id, node]) => (
                  <div key={id} className="flex items-center gap-1">
                    <span className="text-[var(--accent)]">{id}</span>
                    {node.dependsOn.length > 0 && <span>← {node.dependsOn.join(', ')}</span>}
                    <span className="text-[var(--text-secondary)] truncate ml-auto">{node.project}</span>
                  </div>
                ))}
              </div>
            )}

            <button
              onClick={handleCreate}
              disabled={!selectedWorkflow || creating}
              className="w-full text-[10px] px-2 py-1.5 bg-[var(--accent)] text-white rounded hover:opacity-90 disabled:opacity-50"
            >
              {creating ? 'Starting...' : 'Start Pipeline'}
            </button>

            {workflows.length === 0 && (
              <p className="text-[9px] text-[var(--text-secondary)]">
                No workflows found. Create YAML files in ~/.forge/flows/
              </p>
            )}
          </div>
        )}

        {/* Workflow list + execution history */}
        <div className="flex-1 overflow-y-auto">
          {workflows.map(w => {
            const isActive = activeWorkflow === w.name;
            const runs = pipelines.filter(p => p.workflowName === w.name);
            return (
              <div key={w.name}>
                <div
                  onClick={() => { setActiveWorkflow(isActive ? null : w.name); setSelectedPipeline(null); }}
                  className={`w-full text-left px-3 py-2 border-b border-[var(--border)]/30 flex items-center gap-2 cursor-pointer ${
                    isActive ? 'bg-[var(--accent)]/10 border-l-2 border-l-[var(--accent)]' : 'hover:bg-[var(--bg-tertiary)] border-l-2 border-l-transparent'
                  }`}
                >
                  <span className="text-[8px] text-[var(--text-secondary)]">{isActive ? '▾' : '▸'}</span>
                  {w.builtin && <span className="text-[7px] text-[var(--text-secondary)]">⚙</span>}
                  <span className="text-[11px] text-[var(--text-primary)] truncate flex-1">{w.name}</span>
                  {runs.length > 0 && <span className="text-[8px] text-[var(--text-secondary)]">{runs.length}</span>}
                  <button
                    onClick={async (e) => {
                      e.stopPropagation();
                      setSelectedWorkflow(w.name);
                      setInputValues({});
                      setShowCreate(true);
                      setActiveWorkflow(w.name);
                    }}
                    className="text-[8px] text-[var(--accent)] hover:underline shrink-0"
                    title="Run this workflow"
                  >Run</button>
                  <button
                    onClick={async (e) => {
                      e.stopPropagation();
                      try {
                        const res = await fetch(`/api/pipelines?type=workflow-yaml&name=${encodeURIComponent(w.name)}`);
                        const data = await res.json();
                        setEditorYaml(data.yaml || undefined);
                        setEditorIsConversation(w.type === 'conversation' || (data.yaml || '').includes('type: conversation'));
                      } catch { setEditorYaml(undefined); setEditorIsConversation(false); }
                      setShowEditor(true);
                    }}
                    className="text-[8px] text-green-400 hover:underline shrink-0"
                    title={w.builtin ? 'View YAML' : 'Edit'}
                  >{w.builtin ? 'View' : 'Edit'}</button>
                </div>
                {/* Execution history for this workflow */}
                {isActive && (
                  <div className="bg-[var(--bg-tertiary)]/50">
                    {runs.length === 0 ? (
                      <div className="px-4 py-2 text-[9px] text-[var(--text-secondary)]">No runs yet</div>
                    ) : (
                      runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 20).map(p => (
                        <button
                          key={p.id}
                          onClick={() => setSelectedPipeline(p)}
                          className={`w-full text-left px-4 py-1.5 border-b border-[var(--border)]/20 hover:bg-[var(--bg-tertiary)] ${
                            selectedPipeline?.id === p.id ? 'bg-[var(--accent)]/5' : ''
                          }`}
                        >
                          <div className="flex items-center gap-1.5">
                            <span className={`text-[9px] ${STATUS_COLOR[p.status]}`}>●</span>
                            <span className="text-[9px] text-[var(--text-secondary)] font-mono">{p.id.slice(0, 8)}</span>
                            {p.type === 'conversation' ? (
                              <span className="text-[7px] px-1 rounded bg-[var(--accent)]/15 text-[var(--accent)]">
                                R{p.conversation?.currentRound || 0}/{p.conversation?.config.maxRounds || '?'}
                              </span>
                            ) : (
                            <div className="flex gap-0.5 ml-1">
                              {p.nodeOrder.map(nodeId => (
                                <span key={nodeId} className={`text-[8px] ${STATUS_COLOR[p.nodes[nodeId]?.status || 'pending']}`}>
                                  {STATUS_ICON[p.nodes[nodeId]?.status || 'pending']}
                                </span>
                              ))}
                            </div>
                            )}
                            <span className="text-[8px] text-[var(--text-secondary)] ml-auto">
                              {new Date(p.createdAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                            </span>
                          </div>
                        </button>
                      ))
                    )}
                  </div>
                )}
              </div>
            );
          })}
          {workflows.length === 0 && (
            <div className="p-4 text-center text-xs text-[var(--text-secondary)]">
              No workflows. Click Import or + New to create one.
            </div>
          )}
        </div>
      </aside>

      {/* Sidebar resize handle */}
      <div
        onMouseDown={onSidebarDragStart}
        className="w-1 bg-[var(--border)] cursor-col-resize shrink-0 hover:bg-[var(--accent)]/50 transition-colors"
      />

      {/* Right — Pipeline detail / Editor */}
      <main className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {showEditor ? (
          editorIsConversation ? (
            <Suspense fallback={<div className="flex-1 flex items-center justify-center text-xs text-[var(--text-secondary)]">Loading editor...</div>}>
              <ConversationEditor
                initialYaml={editorYaml || ''}
                onSave={async (yaml) => {
                  await fetch('/api/pipelines', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: 'save-workflow', yaml }),
                  });
                  setShowEditor(false);
                  fetchData();
                }}
                onClose={() => setShowEditor(false)}
              />
            </Suspense>
          ) : (
          <Suspense fallback={<div className="flex-1 flex items-center justify-center text-xs text-[var(--text-secondary)]">Loading editor...</div>}>
            <PipelineEditor
              initialYaml={editorYaml}
              onSave={async (yaml) => {
                await fetch('/api/pipelines', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ action: 'save-workflow', yaml }),
                });
                setShowEditor(false);
                fetchData();
              }}
              onClose={() => setShowEditor(false)}
            />
          </Suspense>
          )
        ) : selectedPipeline ? (
          <>
            {/* Header */}
            <div className="px-4 py-3 border-b border-[var(--border)] shrink-0">
              <div className="flex items-center gap-2">
                <span className={`text-sm ${STATUS_COLOR[selectedPipeline.status]}`}>
                  {STATUS_ICON[selectedPipeline.status]}
                </span>
                <span className="text-sm font-semibold text-[var(--text-primary)]">{selectedPipeline.workflowName}</span>
                {selectedPipeline.type === 'conversation' && (
                  <span className="text-[8px] px-1.5 py-0.5 rounded bg-[var(--accent)]/20 text-[var(--accent)]">conversation</span>
                )}
                <span className="text-[10px] text-[var(--text-secondary)] font-mono">{selectedPipeline.id}</span>
                <div className="flex items-center gap-2 ml-auto">
                  {selectedPipeline.status === 'running' && (
                    <button
                      onClick={() => handleCancel(selectedPipeline.id)}
                      className="text-[10px] px-2 py-0.5 text-red-400 border border-red-400/30 rounded hover:bg-red-400 hover:text-white"
                    >
                      Cancel
                    </button>
                  )}
                  <button
                    onClick={() => handleDelete(selectedPipeline.id)}
                    className="text-[10px] px-2 py-0.5 text-[var(--text-secondary)] hover:text-red-400"
                  >
                    Delete
                  </button>
                </div>
              </div>
              <div className="text-[9px] text-[var(--text-secondary)] mt-1">
                Started: {new Date(selectedPipeline.createdAt).toLocaleString()}
                {selectedPipeline.completedAt && ` · Completed: ${new Date(selectedPipeline.completedAt).toLocaleString()}`}
              </div>
              {Object.keys(selectedPipeline.input).length > 0 && (
                <div className="text-[9px] text-[var(--text-secondary)] mt-1">
                  Input: {Object.entries(selectedPipeline.input).map(([k, v]) => `${k}="${v}"`).join(', ')}
                </div>
              )}
            </div>

            {/* Conversation or DAG visualization */}
            {selectedPipeline.type === 'conversation' && selectedPipeline.conversation ? (
              <ConversationView
                pipeline={selectedPipeline}
                onViewTask={onViewTask}
              />
            ) : (
            <div className="p-4 space-y-2 overflow-y-auto">
              {selectedPipeline.nodeOrder.map((nodeId, idx) => {
                const node = selectedPipeline.nodes[nodeId];
                const wf = workflows.find(w => w.name === selectedPipeline.workflowName);
                const nodeDef = wf?.nodes?.[nodeId];
                return (
                  <div key={nodeId}>
                    {idx > 0 && (
                      <div className="flex items-center pl-5 py-1">
                        <div className="w-px h-4 bg-[var(--border)]" />
                      </div>
                    )}
                    <DagNodeCard nodeId={nodeId} node={node} nodeDef={nodeDef} onViewTask={onViewTask} />
                  </div>
                );
              })}
            </div>
            )}
          </>
        ) : activeWorkflow ? (() => {
          const w = workflows.find(wf => wf.name === activeWorkflow);
          if (!w) return null;
          const nodeEntries = Object.entries(w.nodes);
          return (
            <div className="flex-1 flex flex-col overflow-y-auto">
              {/* Workflow header */}
              <div className="px-4 py-3 border-b border-[var(--border)] shrink-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-[var(--text-primary)]">{w.name}</span>
                  {w.type === 'conversation' && <span className="text-[8px] px-1.5 py-0.5 rounded bg-[var(--accent)]/20 text-[var(--accent)]">conversation</span>}
                  {w.builtin && <span className="text-[8px] px-1.5 py-0.5 rounded bg-[var(--bg-tertiary)] text-[var(--text-secondary)]">built-in</span>}
                  <div className="ml-auto flex gap-2">
                    <button
                      onClick={() => { setSelectedWorkflow(w.name); setInputValues({}); setShowCreate(true); }}
                      className="text-[10px] px-3 py-1 bg-[var(--accent)] text-white rounded hover:opacity-90"
                    >Run</button>
                    <button
                      onClick={async () => {
                        try {
                          const res = await fetch(`/api/pipelines?type=workflow-yaml&name=${encodeURIComponent(w.name)}`);
                          const data = await res.json();
                          setEditorYaml(data.yaml || undefined);
                          setEditorIsConversation(w.type === 'conversation' || (data.yaml || '').includes('type: conversation'));
                        } catch { setEditorYaml(undefined); setEditorIsConversation(false); }
                        setShowEditor(true);
                      }}
                      className="text-[10px] px-3 py-1 border border-[var(--border)] text-[var(--text-secondary)] rounded hover:text-[var(--text-primary)]"
                    >{w.builtin ? 'View YAML' : 'Edit'}</button>
                  </div>
                </div>
                {w.description && <p className="text-[10px] text-[var(--text-secondary)] mt-1">{w.description}</p>}
                {Object.keys(w.input).length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {Object.entries(w.input).map(([k, v]) => (
                      <span key={k} className="text-[8px] px-1.5 py-0.5 rounded bg-[var(--accent)]/10 text-[var(--accent)]">{k}</span>
                    ))}
                  </div>
                )}
              </div>

              {/* Conversation or Node flow visualization */}
              {w.type === 'conversation' && w.conversation ? (
                <div className="p-4 space-y-3">
                  {/* Initial prompt */}
                  <div className="border border-[var(--border)] rounded-lg p-3 bg-[var(--bg-tertiary)]">
                    <div className="text-[9px] text-[var(--text-secondary)] font-medium mb-1">Initial Prompt</div>
                    <p className="text-[10px] text-[var(--text-primary)]">{w.conversation.initialPrompt}</p>
                  </div>
                  {/* Agents */}
                  <div className="text-[9px] text-[var(--text-secondary)] font-medium">Agents ({w.conversation.agents.length})</div>
                  <div className="space-y-2">
                    {w.conversation.agents.map((a, i) => {
                      const colors = AGENT_COLORS[i % AGENT_COLORS.length];
                      return (
                        <div key={a.id} className={`border rounded-lg p-3 ${colors.bg} ${colors.border}`}>
                          <div className="flex items-center gap-2">
                            <span className={`text-[9px] px-1.5 py-0.5 rounded font-medium ${colors.badge}`}>{a.agent}</span>
                            <span className="text-[11px] font-semibold text-[var(--text-primary)]">{a.id}</span>
                          </div>
                          {a.role && <p className="text-[9px] text-[var(--text-secondary)] mt-1">{a.role}</p>}
                        </div>
                      );
                    })}
                  </div>
                  {/* Config */}
                  <div className="text-[9px] text-[var(--text-secondary)] space-y-0.5">
                    <div>Max rounds: {w.conversation.maxRounds}</div>
                    {w.conversation.stopCondition && <div>Stop: {w.conversation.stopCondition}</div>}
                  </div>
                </div>
              ) : (
              <div className="p-4 space-y-2">
                {nodeEntries.map(([nodeId, node], i) => (
                  <div key={nodeId}>
                    {/* Connection line */}
                    {i > 0 && (
                      <div className="flex items-center justify-center py-1">
                        <div className="w-px h-4 bg-[var(--border)]" />
                      </div>
                    )}
                    {/* Node card */}
                    <div className="border border-[var(--border)] rounded-lg p-3 bg-[var(--bg-tertiary)]">
                      <div className="flex items-center gap-2">
                        <span className={`text-[9px] px-1.5 py-0.5 rounded font-medium ${
                          node.mode === 'shell' ? 'bg-yellow-500/20 text-yellow-400' : 'bg-purple-500/20 text-purple-400'
                        }`}>{node.mode === 'shell' ? 'shell' : (node.agent || 'default')}</span>
                        <span className="text-[11px] font-semibold text-[var(--text-primary)]">{nodeId}</span>
                        {node.project && <span className="text-[9px] text-[var(--text-secondary)] ml-auto">{node.project}</span>}
                      </div>
                      {node.dependsOn.length > 0 && (
                        <div className="text-[8px] text-[var(--text-secondary)] mt-1">depends: {node.dependsOn.join(', ')}</div>
                      )}
                      <p className="text-[9px] text-[var(--text-secondary)] mt-1 line-clamp-2">{node.prompt.slice(0, 120)}{node.prompt.length > 120 ? '...' : ''}</p>
                      {node.outputs.length > 0 && (
                        <div className="flex gap-1 mt-1">
                          {node.outputs.map(o => (
                            <span key={o.name} className="text-[7px] px-1 rounded bg-green-500/10 text-green-400">{o.name}</span>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
              )}
            </div>
          );
        })() : (
          <div className="flex-1 flex items-center justify-center text-[var(--text-secondary)]">
            <p className="text-xs">Select a workflow to view details or run</p>
          </div>
        )}
      </main>
    </div>
  );
}
