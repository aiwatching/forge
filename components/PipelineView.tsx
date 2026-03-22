'use client';

import { useState, useEffect, useCallback, lazy, Suspense } from 'react';
import { useSidebarResize } from '@/hooks/useSidebarResize';

const PipelineEditor = lazy(() => import('./PipelineEditor'));

interface WorkflowNode {
  id: string;
  project: string;
  prompt: string;
  mode?: 'claude' | 'shell';
  branch?: string;
  dependsOn: string[];
  outputs: { name: string; extract: string }[];
  routes: { condition: string; next: string }[];
  maxIterations: number;
}

interface Workflow {
  name: string;
  description?: string;
  builtin?: boolean;
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

export default function PipelineView({ onViewTask }: { onViewTask?: (taskId: string) => void }) {
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
  const [showImport, setShowImport] = useState(false);
  const [importYaml, setImportYaml] = useState('');

  const fetchData = useCallback(async () => {
    const [pRes, wRes, projRes] = await Promise.all([
      fetch('/api/pipelines'),
      fetch('/api/pipelines?type=workflows'),
      fetch('/api/projects'),
    ]);
    const pData = await pRes.json();
    const wData = await wRes.json();
    const projData = await projRes.json();
    if (Array.isArray(pData)) setPipelines(pData);
    if (Array.isArray(wData)) setWorkflows(wData);
    if (Array.isArray(projData)) setProjects(projData.map((p: any) => ({ name: p.name, path: p.path })));
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
      {/* Left — Workflow list */}
      <aside style={{ width: sidebarWidth }} className="flex flex-col shrink-0 overflow-hidden">
        <div className="px-3 py-2 border-b border-[var(--border)] flex items-center gap-1.5">
          <span className="text-[11px] font-semibold text-[var(--text-primary)] flex-1">Workflows</span>
          <button
            onClick={() => setShowImport(v => !v)}
            className="text-[9px] text-green-400 hover:underline"
          >Import</button>
          <button
            onClick={() => { setEditorYaml(undefined); setShowEditor(true); }}
            className="text-[9px] text-[var(--accent)] hover:underline"
          >+ New</button>
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
                      } catch { setEditorYaml(undefined); }
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
                            <div className="flex gap-0.5 ml-1">
                              {p.nodeOrder.map(nodeId => (
                                <span key={nodeId} className={`text-[8px] ${STATUS_COLOR[p.nodes[nodeId]?.status || 'pending']}`}>
                                  {STATUS_ICON[p.nodes[nodeId]?.status || 'pending']}
                                </span>
                              ))}
                            </div>
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
        ) : selectedPipeline ? (
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
                          <button
                            onClick={() => onViewTask?.(node.taskId!)}
                            className="text-[9px] text-[var(--accent)] font-mono hover:underline"
                          >
                            task:{node.taskId}
                          </button>
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
                        } catch { setEditorYaml(undefined); }
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

              {/* Node flow visualization */}
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
                        }`}>{node.mode === 'shell' ? 'shell' : 'claude'}</span>
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
