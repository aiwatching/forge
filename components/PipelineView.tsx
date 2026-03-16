'use client';

import { useState, useEffect, useCallback } from 'react';

interface WorkflowNode {
  id: string;
  project: string;
  prompt: string;
  dependsOn: string[];
  outputs: { name: string; extract: string }[];
  routes: { condition: string; next: string }[];
  maxIterations: number;
}

interface Workflow {
  name: string;
  description?: string;
  vars: Record<string, string>;
  input: Record<string, string>;
  nodes: Record<string, WorkflowNode>;
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

interface Pipeline {
  id: string;
  workflowName: string;
  status: 'running' | 'done' | 'failed' | 'cancelled';
  input: Record<string, string>;
  vars: Record<string, string>;
  nodes: Record<string, PipelineNodeState>;
  nodeOrder: string[];
  createdAt: string;
  completedAt?: string;
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

export default function PipelineView() {
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [selectedPipeline, setSelectedPipeline] = useState<Pipeline | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [selectedWorkflow, setSelectedWorkflow] = useState<string>('');
  const [inputValues, setInputValues] = useState<Record<string, string>>({});
  const [creating, setCreating] = useState(false);

  const fetchData = useCallback(async () => {
    const [pRes, wRes] = await Promise.all([
      fetch('/api/pipelines'),
      fetch('/api/pipelines?type=workflows'),
    ]);
    const pData = await pRes.json();
    const wData = await wRes.json();
    if (Array.isArray(pData)) setPipelines(pData);
    if (Array.isArray(wData)) setWorkflows(wData);
  }, []);

  useEffect(() => {
    fetchData();
    const timer = setInterval(fetchData, 5000);
    return () => clearInterval(timer);
  }, [fetchData]);

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

  const currentWorkflow = workflows.find(w => w.name === selectedWorkflow);

  return (
    <div className="flex-1 flex min-h-0">
      {/* Left — Pipeline list */}
      <aside className="w-72 border-r border-[var(--border)] flex flex-col shrink-0">
        <div className="px-3 py-2 border-b border-[var(--border)] flex items-center justify-between">
          <span className="text-[11px] font-semibold text-[var(--text-primary)]">Pipelines</span>
          <button
            onClick={() => setShowCreate(v => !v)}
            className={`text-[10px] px-2 py-0.5 rounded ${showCreate ? 'text-white bg-[var(--accent)]' : 'text-[var(--accent)] hover:bg-[var(--accent)]/10'}`}
          >
            + New
          </button>
        </div>

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
                <option key={w.name} value={w.name}>{w.name}{w.description ? ` — ${w.description}` : ''}</option>
              ))}
            </select>

            {/* Input fields */}
            {currentWorkflow && Object.keys(currentWorkflow.input).length > 0 && (
              <div className="space-y-1.5">
                {Object.entries(currentWorkflow.input).map(([key, desc]) => (
                  <div key={key}>
                    <label className="text-[9px] text-[var(--text-secondary)]">{key}: {desc}</label>
                    <input
                      value={inputValues[key] || ''}
                      onChange={e => setInputValues(prev => ({ ...prev, [key]: e.target.value }))}
                      className="w-full text-xs bg-[var(--bg-tertiary)] border border-[var(--border)] rounded px-2 py-1 text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)]"
                    />
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

        {/* Pipeline list */}
        <div className="flex-1 overflow-y-auto">
          {pipelines.map(p => (
            <button
              key={p.id}
              onClick={() => setSelectedPipeline(p)}
              className={`w-full text-left px-3 py-2 border-b border-[var(--border)]/30 hover:bg-[var(--bg-tertiary)] ${
                selectedPipeline?.id === p.id ? 'bg-[var(--bg-tertiary)]' : ''
              }`}
            >
              <div className="flex items-center gap-2">
                <span className={`text-[10px] ${STATUS_COLOR[p.status]}`}>●</span>
                <span className="text-xs font-medium truncate">{p.workflowName}</span>
                <span className="text-[9px] text-[var(--text-secondary)] ml-auto">{p.id}</span>
              </div>
              <div className="flex items-center gap-1 mt-0.5 pl-4">
                {p.nodeOrder.map(nodeId => (
                  <span key={nodeId} className={`text-[9px] ${STATUS_COLOR[p.nodes[nodeId]?.status || 'pending']}`}>
                    {STATUS_ICON[p.nodes[nodeId]?.status || 'pending']}
                  </span>
                ))}
                <span className="text-[8px] text-[var(--text-secondary)] ml-auto">
                  {new Date(p.createdAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>
            </button>
          ))}
          {pipelines.length === 0 && (
            <div className="p-4 text-center text-xs text-[var(--text-secondary)]">
              No pipelines yet
            </div>
          )}
        </div>
      </aside>

      {/* Right — Pipeline detail */}
      <main className="flex-1 flex flex-col min-w-0 overflow-y-auto">
        {selectedPipeline ? (
          <>
            {/* Header */}
            <div className="px-4 py-3 border-b border-[var(--border)] shrink-0">
              <div className="flex items-center gap-2">
                <span className={`text-sm ${STATUS_COLOR[selectedPipeline.status]}`}>
                  {STATUS_ICON[selectedPipeline.status]}
                </span>
                <span className="text-sm font-semibold text-[var(--text-primary)]">{selectedPipeline.workflowName}</span>
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

            {/* DAG visualization */}
            <div className="p-4 space-y-2">
              {selectedPipeline.nodeOrder.map((nodeId, idx) => {
                const node = selectedPipeline.nodes[nodeId];
                return (
                  <div key={nodeId}>
                    {/* Connection line */}
                    {idx > 0 && (
                      <div className="flex items-center pl-5 py-1">
                        <div className="w-px h-4 bg-[var(--border)]" />
                      </div>
                    )}

                    {/* Node card */}
                    <div className={`border rounded-lg p-3 ${
                      node.status === 'running' ? 'border-yellow-500/50 bg-yellow-500/5' :
                      node.status === 'done' ? 'border-green-500/30 bg-green-500/5' :
                      node.status === 'failed' ? 'border-red-500/30 bg-red-500/5' :
                      'border-[var(--border)]'
                    }`}>
                      <div className="flex items-center gap-2">
                        <span className={STATUS_COLOR[node.status]}>{STATUS_ICON[node.status]}</span>
                        <span className="text-xs font-semibold text-[var(--text-primary)]">{nodeId}</span>
                        {node.taskId && (
                          <span className="text-[9px] text-[var(--text-secondary)] font-mono">task:{node.taskId}</span>
                        )}
                        {node.iterations > 1 && (
                          <span className="text-[9px] text-yellow-400">iter {node.iterations}</span>
                        )}
                        <span className="text-[9px] text-[var(--text-secondary)] ml-auto">{node.status}</span>
                      </div>

                      {node.error && (
                        <div className="text-[10px] text-red-400 mt-1">{node.error}</div>
                      )}

                      {/* Outputs */}
                      {Object.keys(node.outputs).length > 0 && (
                        <div className="mt-2 space-y-1">
                          {Object.entries(node.outputs).map(([key, val]) => (
                            <details key={key} className="text-[10px]">
                              <summary className="cursor-pointer text-[var(--accent)]">
                                output: {key} ({val.length} chars)
                              </summary>
                              <pre className="mt-1 p-2 bg-[var(--bg-tertiary)] rounded text-[9px] text-[var(--text-secondary)] max-h-32 overflow-auto whitespace-pre-wrap">
                                {val.slice(0, 1000)}{val.length > 1000 ? '...' : ''}
                              </pre>
                            </details>
                          ))}
                        </div>
                      )}

                      {/* Timing */}
                      {node.startedAt && (
                        <div className="text-[8px] text-[var(--text-secondary)] mt-1">
                          {node.startedAt && `Started: ${new Date(node.startedAt).toLocaleTimeString()}`}
                          {node.completedAt && ` · Done: ${new Date(node.completedAt).toLocaleTimeString()}`}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-[var(--text-secondary)]">
            <div className="text-center space-y-2">
              <p className="text-sm">Select a pipeline or create a new one</p>
              <p className="text-xs">Define workflows in <code className="text-[var(--accent)]">~/.forge/flows/*.yaml</code></p>
              <details className="text-left text-[10px] mt-4 max-w-md">
                <summary className="cursor-pointer text-[var(--accent)]">Example workflow YAML</summary>
                <pre className="mt-2 p-3 bg-[var(--bg-tertiary)] rounded overflow-auto whitespace-pre text-[var(--text-secondary)]">{`name: feature-build
description: "Design → Implement → Review"

input:
  requirement: "Feature description"

vars:
  project: my-app

nodes:
  architect:
    project: "{{vars.project}}"
    prompt: |
      Analyze this requirement and create
      a technical design document:
      {{input.requirement}}
    outputs:
      - name: design_doc
        extract: result

  implement:
    project: "{{vars.project}}"
    depends_on: [architect]
    prompt: |
      Implement this design:
      {{nodes.architect.outputs.design_doc}}
    outputs:
      - name: diff
        extract: git_diff

  review:
    project: "{{vars.project}}"
    depends_on: [implement]
    prompt: |
      Review this code change:
      {{nodes.implement.outputs.diff}}`}</pre>
              </details>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
