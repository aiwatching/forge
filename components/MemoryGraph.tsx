'use client';

import { useMemo, useState, useCallback } from 'react';
import {
  ReactFlow,
  Background,
  type Node,
  type Edge,
  type NodeMouseHandler,
  useNodesState,
  useEdgesState,
  useReactFlow,
  ReactFlowProvider,
  Position,
  MarkerType,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

interface FileNode {
  id: string;
  label: string;
  module: string;
  functions: number;
  exported: boolean;
}

interface FileEdge {
  source: string;
  target: string;
  type: string;
  detail?: string;
}

interface ModuleInfo {
  id: string;
  files: number;
  color: string;
}

interface SymbolInfo {
  name: string;
  type: string;
  file: string;
  line?: number;
  module: string;
}

interface Props {
  moduleGraph: {
    nodes: FileNode[];
    edges: FileEdge[];
    modules: ModuleInfo[];
    symbols: SymbolInfo[];
    totalConnected?: number;
  };
}

// ─── Helpers ─────────────────────────────────────────────

function nodeConnectivity(nodes: FileNode[], edges: FileEdge[]): Record<string, number> {
  const conn: Record<string, number> = {};
  for (const n of nodes) conn[n.id] = 0;
  for (const e of edges) {
    conn[e.source] = (conn[e.source] || 0) + 1;
    conn[e.target] = (conn[e.target] || 0) + 1;
  }
  return conn;
}

function traceChain(rootId: string, allEdges: FileEdge[]): Set<string> {
  const chain = new Set<string>([rootId]);
  const downstream: Record<string, string[]> = {};
  const upstream: Record<string, string[]> = {};
  for (const e of allEdges) {
    if (!downstream[e.source]) downstream[e.source] = [];
    downstream[e.source].push(e.target);
    if (!upstream[e.target]) upstream[e.target] = [];
    upstream[e.target].push(e.source);
  }
  const qDown = [rootId];
  while (qDown.length > 0) {
    const cur = qDown.shift()!;
    for (const next of (downstream[cur] || [])) {
      if (!chain.has(next)) { chain.add(next); qDown.push(next); }
    }
  }
  const qUp = [rootId];
  while (qUp.length > 0) {
    const cur = qUp.shift()!;
    for (const next of (upstream[cur] || [])) {
      if (!chain.has(next)) { chain.add(next); qUp.push(next); }
    }
  }
  return chain;
}

function chainLayout(rootId: string, nodes: FileNode[], edges: FileEdge[], width: number, height: number) {
  const positions: Record<string, { x: number; y: number }> = {};
  const downstream: Record<string, string[]> = {};
  const upstream: Record<string, string[]> = {};
  for (const e of edges) {
    if (!downstream[e.source]) downstream[e.source] = [];
    downstream[e.source].push(e.target);
    if (!upstream[e.target]) upstream[e.target] = [];
    upstream[e.target].push(e.source);
  }
  const nodeIds = new Set(nodes.map(n => n.id));
  const depth: Record<string, number> = {};
  depth[rootId] = 0;

  const qDown = [rootId];
  while (qDown.length > 0) {
    const cur = qDown.shift()!;
    for (const next of (downstream[cur] || [])) {
      if (nodeIds.has(next) && depth[next] === undefined) { depth[next] = depth[cur] + 1; qDown.push(next); }
    }
  }
  const qUp = [rootId];
  while (qUp.length > 0) {
    const cur = qUp.shift()!;
    for (const next of (upstream[cur] || [])) {
      if (nodeIds.has(next) && depth[next] === undefined) { depth[next] = depth[cur] - 1; qUp.push(next); }
    }
  }
  for (const n of nodes) { if (depth[n.id] === undefined) depth[n.id] = 0; }

  const levels: Record<number, string[]> = {};
  for (const [id, d] of Object.entries(depth)) { if (!levels[d]) levels[d] = []; levels[d].push(id); }
  const allDepths = Object.keys(levels).map(Number).sort((a, b) => a - b);
  const colWidth = width / Math.max(allDepths.length, 1);

  allDepths.forEach((d, colIdx) => {
    const ids = levels[d];
    const rowHeight = height / (ids.length + 1);
    ids.forEach((id, rowIdx) => {
      positions[id] = { x: colIdx * colWidth + 40, y: (rowIdx + 1) * rowHeight };
    });
  });
  return positions;
}

function clusterLayout(nodes: FileNode[], edges: FileEdge[], width: number, height: number) {
  const positions: Record<string, { x: number; y: number }> = {};
  const moduleNodes: Record<string, FileNode[]> = {};
  for (const n of nodes) { if (!moduleNodes[n.module]) moduleNodes[n.module] = []; moduleNodes[n.module].push(n); }
  const moduleKeys = Object.keys(moduleNodes);
  const cx = width / 2, cy = height / 2;
  const moduleRadius = Math.min(width, height) * 0.32;

  moduleKeys.forEach((mod, mi) => {
    const angle = (2 * Math.PI * mi) / moduleKeys.length - Math.PI / 2;
    const mx = cx + moduleRadius * Math.cos(angle);
    const my = cy + moduleRadius * Math.sin(angle);
    const files = moduleNodes[mod];
    const clusterR = Math.min(30 + files.length * 6, 100);
    files.forEach((f, fi) => {
      const fa = (2 * Math.PI * fi) / files.length;
      positions[f.id] = { x: mx + clusterR * Math.cos(fa), y: my + clusterR * Math.sin(fa) };
    });
  });
  return positions;
}

// ─── Component ───────────────────────────────────────────

function MemoryGraphInner({ moduleGraph }: Props) {
  const { fitView, setCenter } = useReactFlow();

  const defaultActiveModules = useMemo(() => {
    const crossMods = new Set<string>();
    const fileToMod: Record<string, string> = {};
    for (const n of moduleGraph.nodes) fileToMod[n.id] = n.module;
    for (const e of moduleGraph.edges) {
      const sm = fileToMod[e.source], tm = fileToMod[e.target];
      if (sm && tm && sm !== tm) { crossMods.add(sm); crossMods.add(tm); }
    }
    if (crossMods.size < 2) return new Set(moduleGraph.modules.map(m => m.id));
    return crossMods;
  }, [moduleGraph]);

  const [activeModules, setActiveModules] = useState<Set<string>>(defaultActiveModules);
  const defaultMinEdges = useMemo(() => {
    const conn = nodeConnectivity(moduleGraph.nodes, moduleGraph.edges);
    for (let t = 1; t <= 20; t++) {
      if (moduleGraph.nodes.filter(n => (conn[n.id] || 0) >= t).length <= 25) return t;
    }
    return 10;
  }, [moduleGraph]);
  const [minEdges, setMinEdges] = useState(defaultMinEdges);

  // Search
  const [search, setSearch] = useState('');
  const [searchResults, setSearchResults] = useState<SymbolInfo[]>([]);

  // Chain mode + selected node for detail
  const [chainRoot, setChainRoot] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<string | null>(null);

  const graphNodeIds = useMemo(() => new Set(moduleGraph.nodes.map(n => n.id)), [moduleGraph.nodes]);

  // Get symbols for a given file
  const getFileSymbols = useCallback((fileId: string) => {
    return (moduleGraph.symbols || []).filter(s => s.file === fileId);
  }, [moduleGraph.symbols]);

  // Get direct connections for a file
  const getFileConnections = useCallback((fileId: string) => {
    const imports: string[] = []; // this file imports
    const importedBy: string[] = []; // imported by
    for (const e of moduleGraph.edges) {
      if (e.source === fileId) imports.push(e.target);
      if (e.target === fileId) importedBy.push(e.source);
    }
    return { imports, importedBy };
  }, [moduleGraph.edges]);

  const doSearch = useCallback((q: string) => {
    setSearch(q);
    if (!q.trim()) { setSearchResults([]); return; }
    const lower = q.toLowerCase();
    const symMatches = (moduleGraph.symbols || []).filter(s => s.name.toLowerCase().includes(lower)).slice(0, 30);
    const fileMatches = moduleGraph.nodes
      .filter(n => n.label.toLowerCase().includes(lower) || n.id.toLowerCase().includes(lower))
      .slice(0, 10)
      .map(n => ({ name: n.label, type: 'file' as string, file: n.id, module: n.module }));
    const seen = new Set(symMatches.map(m => m.file + m.name));
    for (const fm of fileMatches) { const key = fm.file + fm.name; if (!seen.has(key)) { symMatches.push(fm); seen.add(key); } }
    symMatches.sort((a, b) => (graphNodeIds.has(a.file) ? 0 : 1) - (graphNodeIds.has(b.file) ? 0 : 1));
    setSearchResults(symMatches.slice(0, 20));
  }, [moduleGraph.symbols, moduleGraph.nodes, graphNodeIds]);

  const focusChain = useCallback((fileId: string) => {
    if (graphNodeIds.has(fileId)) {
      setChainRoot(fileId);
      setSelectedNode(fileId);
      setSearch('');
      setSearchResults([]);
      setTimeout(() => fitView({ padding: 0.3, duration: 300 }), 100);
    } else {
      // Show detail for isolated file
      setSelectedNode(fileId);
      setSearch('');
      setSearchResults([]);
    }
  }, [fitView, graphNodeIds]);

  const clearChain = useCallback(() => {
    setChainRoot(null);
    setSelectedNode(null);
  }, []);

  const toggleModule = useCallback((modId: string) => {
    setActiveModules(prev => {
      const next = new Set(prev);
      if (next.has(modId)) next.delete(modId); else next.add(modId);
      return next;
    });
  }, []);

  // ─── Build visible graph ──────────────────────────────

  const { visibleNodes, visibleEdges, moduleLegend, chainInfo } = useMemo(() => {
    const moduleColorMap: Record<string, string> = {};
    for (const m of moduleGraph.modules) moduleColorMap[m.id] = m.color;

    let finalNodes: FileNode[];
    let finalEdges: FileEdge[];
    let chainInfo: { upstream: number; downstream: number } | null = null;

    if (chainRoot) {
      const chainFiles = traceChain(chainRoot, moduleGraph.edges);
      finalNodes = moduleGraph.nodes.filter(n => chainFiles.has(n.id));
      const finalNodeIds = new Set(finalNodes.map(n => n.id));
      finalEdges = moduleGraph.edges.filter(e => finalNodeIds.has(e.source) && finalNodeIds.has(e.target));

      const downstream = new Set<string>();
      const upstream = new Set<string>();
      const downAdj: Record<string, string[]> = {};
      const upAdj: Record<string, string[]> = {};
      for (const e of finalEdges) {
        if (!downAdj[e.source]) downAdj[e.source] = [];
        downAdj[e.source].push(e.target);
        if (!upAdj[e.target]) upAdj[e.target] = [];
        upAdj[e.target].push(e.source);
      }
      const q1 = [chainRoot];
      while (q1.length) { const c = q1.shift()!; for (const n of (downAdj[c] || [])) { if (!downstream.has(n) && n !== chainRoot) { downstream.add(n); q1.push(n); } } }
      const q2 = [chainRoot];
      while (q2.length) { const c = q2.shift()!; for (const n of (upAdj[c] || [])) { if (!upstream.has(n) && n !== chainRoot) { upstream.add(n); q2.push(n); } } }
      chainInfo = { upstream: upstream.size, downstream: downstream.size };
    } else {
      const filteredNodes = moduleGraph.nodes.filter(n => activeModules.has(n.module));
      const nodeIds = new Set(filteredNodes.map(n => n.id));
      const filteredEdges = moduleGraph.edges.filter(e => nodeIds.has(e.source) && nodeIds.has(e.target));
      const conn = nodeConnectivity(filteredNodes, filteredEdges);
      finalNodes = filteredNodes.filter(n => conn[n.id] >= minEdges);
      const finalNodeIds = new Set(finalNodes.map(n => n.id));
      finalEdges = filteredEdges.filter(e => finalNodeIds.has(e.source) && finalNodeIds.has(e.target));
    }

    const positions = chainRoot
      ? chainLayout(chainRoot, finalNodes, finalEdges, 700, 400)
      : clusterLayout(finalNodes, finalEdges, 600, 400);

    const visibleNodes: Node[] = finalNodes.map(n => {
      const color = moduleColorMap[n.module] || '#666';
      const isRoot = n.id === chainRoot;
      const isSelected = n.id === selectedNode && !isRoot;
      return {
        id: n.id,
        position: positions[n.id] || { x: 0, y: 0 },
        data: {
          label: (
            <div className="text-center leading-tight">
              <div className="text-[8px] font-medium truncate max-w-[90px]">{n.label}</div>
              {n.functions > 0 && <div className="text-[7px] opacity-60">{n.functions} fn</div>}
            </div>
          ),
        },
        sourcePosition: Position.Right,
        targetPosition: Position.Left,
        style: {
          background: isRoot ? color + '50' : isSelected ? color + '35' : color + '18',
          border: `${isRoot ? 3 : isSelected ? 2.5 : 1.5}px solid ${color}`,
          borderRadius: 6,
          padding: '2px 6px',
          fontSize: 8,
          color: 'var(--text-primary)',
          width: Math.max(70, 50 + n.functions * 2),
          minHeight: 28,
          boxShadow: isRoot ? `0 0 12px ${color}80` : isSelected ? `0 0 8px ${color}50` : 'none',
          cursor: 'pointer',
        },
      };
    });

    const visibleEdges: Edge[] = finalEdges.map((e, i) => {
      const touchesSelected = selectedNode && (e.source === selectedNode || e.target === selectedNode);
      const touchesRoot = chainRoot && (e.source === chainRoot || e.target === chainRoot);
      const isHot = touchesSelected || touchesRoot;
      return {
        id: `e-${i}`,
        source: e.source,
        target: e.target,
        animated: !!touchesRoot,
        style: {
          stroke: isHot ? 'var(--accent)' : 'var(--text-secondary)',
          strokeWidth: isHot ? 2 : 1,
          opacity: chainRoot ? 0.7 : 0.3,
        },
        markerEnd: { type: MarkerType.ArrowClosed, width: 8, height: 8, color: isHot ? 'var(--accent)' : 'var(--text-secondary)' },
      };
    });

    return { visibleNodes, visibleEdges, moduleLegend: moduleGraph.modules, chainInfo };
  }, [moduleGraph, activeModules, minEdges, chainRoot, selectedNode]);

  const [nodes, setNodes, onNodesChange] = useNodesState(visibleNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(visibleEdges);

  useMemo(() => {
    setNodes(visibleNodes);
    setEdges(visibleEdges);
  }, [visibleNodes, visibleEdges, setNodes, setEdges]);

  // Click node: select it (show detail), double-click for chain
  const onNodeClick: NodeMouseHandler = useCallback((_event, node) => {
    setSelectedNode(node.id);
  }, []);

  const onNodeDoubleClick: NodeMouseHandler = useCallback((_event, node) => {
    if (chainRoot === node.id) {
      clearChain();
    } else {
      setChainRoot(node.id);
      setSelectedNode(node.id);
      setTimeout(() => fitView({ padding: 0.3, duration: 300 }), 100);
    }
  }, [chainRoot, clearChain, fitView]);

  // Detail panel data
  const selectedFileNode = selectedNode ? moduleGraph.nodes.find(n => n.id === selectedNode) : null;
  const selectedSymbols = selectedNode ? getFileSymbols(selectedNode) : [];
  const selectedConns = selectedNode ? getFileConnections(selectedNode) : { imports: [], importedBy: [] };

  return (
    <div className="w-full h-full relative flex flex-col" style={{ minHeight: 350 }}>
      {/* Filter bar */}
      <div className="shrink-0 flex items-center gap-1.5 px-2 py-1 border-b border-[var(--border)] bg-[var(--bg-primary)] flex-wrap">
        {/* Search */}
        <div className="relative">
          <input
            type="text"
            placeholder="Search fn/class/file..."
            value={search}
            onChange={e => doSearch(e.target.value)}
            className="text-[8px] bg-[var(--bg-secondary)] border border-[var(--border)] rounded px-1.5 py-0.5 w-32 text-[var(--text-primary)]"
          />
          {searchResults.length > 0 && (
            <div className="absolute top-full left-0 mt-0.5 w-64 max-h-48 overflow-y-auto bg-[var(--bg-primary)] border border-[var(--border)] rounded shadow-lg z-50">
              {searchResults.map((s, i) => {
                const inGraph = graphNodeIds.has(s.file);
                return (
                  <button key={i} onClick={() => focusChain(s.file)}
                    className={`w-full text-left px-2 py-1 hover:bg-[var(--bg-secondary)] flex items-center gap-1.5 ${!inGraph ? 'opacity-50' : ''}`}
                    title={inGraph ? 'Click to trace dependency chain' : 'No dependencies'}>
                    <span className="text-[7px] px-1 rounded bg-[var(--bg-tertiary)] text-[var(--text-secondary)] shrink-0">
                      {s.type === 'function' ? 'fn' : s.type === 'class' ? 'cls' : 'file'}
                    </span>
                    <span className="text-[8px] font-medium text-[var(--text-primary)] truncate">{s.name}</span>
                    <span className="text-[7px] text-[var(--text-secondary)] truncate ml-auto">
                      {s.file.split('/').slice(-2).join('/')}{s.line ? `:${s.line}` : ''}
                    </span>
                    {inGraph && <span className="text-[7px] text-[var(--accent)] shrink-0">→</span>}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {chainRoot ? (
          <>
            <span className="text-[var(--border)]">|</span>
            <span className="text-[8px] text-[var(--accent)] font-medium">
              Chain: {moduleGraph.nodes.find(n => n.id === chainRoot)?.label || chainRoot.split('/').pop()}
            </span>
            {chainInfo && (
              <span className="text-[8px] text-[var(--text-secondary)]">
                ← {chainInfo.upstream} · {chainInfo.downstream} →
              </span>
            )}
            <button onClick={clearChain}
              className="text-[8px] px-1.5 py-0.5 rounded bg-[var(--bg-secondary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] ml-auto">
              Exit chain
            </button>
          </>
        ) : (
          <>
            <span className="text-[var(--border)]">|</span>
            {moduleLegend.map(m => (
              <button key={m.id} onClick={() => toggleModule(m.id)}
                className={`flex items-center gap-1 text-[8px] px-1 py-0.5 rounded transition-opacity ${activeModules.has(m.id) ? 'opacity-100' : 'opacity-30'}`}>
                <span className="w-2 h-2 rounded-sm shrink-0" style={{ background: m.color }} />
                <span className="text-[var(--text-primary)]">{m.id}</span>
              </button>
            ))}
            <span className="text-[var(--border)]">|</span>
            <span className="text-[8px] text-[var(--text-secondary)]">≥</span>
            <input type="range" min={1} max={20} value={minEdges}
              onChange={e => setMinEdges(Number(e.target.value))} className="w-12 h-2 accent-[var(--accent)]" />
            <span className="text-[8px] font-mono text-[var(--text-primary)] w-3">{minEdges}</span>
            <span className="text-[8px] text-[var(--text-secondary)] ml-auto">{nodes.length}n · {edges.length}e</span>
          </>
        )}
      </div>

      {/* Main area: graph + detail panel */}
      <div className="flex-1 min-h-0 flex">
        {/* Graph */}
        <div className={`${selectedNode ? 'flex-1' : 'w-full'} min-h-0`}>
          {nodes.length > 0 ? (
            <ReactFlow
              nodes={nodes} edges={edges}
              onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
              onNodeClick={onNodeClick}
              onNodeDoubleClick={onNodeDoubleClick}
              onPaneClick={() => setSelectedNode(null)}
              fitView fitViewOptions={{ padding: 0.2 }}
              proOptions={{ hideAttribution: true }}
              minZoom={0.2} maxZoom={3}
              nodesDraggable nodesConnectable={false}
              panOnScroll zoomOnDoubleClick={false}
            >
              <Background gap={24} size={1} color="var(--border)" />
            </ReactFlow>
          ) : (
            <div className="flex items-center justify-center h-full text-[10px] text-[var(--text-secondary)]">
              No nodes. Lower the threshold or enable more modules.
            </div>
          )}
        </div>

        {/* Detail panel */}
        {selectedNode && (
          <div className="w-52 shrink-0 border-l border-[var(--border)] bg-[var(--bg-primary)] overflow-y-auto p-2 space-y-2">
            {/* File header */}
            <div>
              <div className="text-[9px] font-medium text-[var(--text-primary)] break-all">{selectedNode}</div>
              {selectedFileNode && (
                <div className="text-[8px] text-[var(--text-secondary)] mt-0.5">
                  module: {selectedFileNode.module} · {selectedFileNode.functions} fn
                </div>
              )}
            </div>

            {/* Actions */}
            <div className="flex gap-1">
              {graphNodeIds.has(selectedNode) && (
                <button
                  onClick={() => { setChainRoot(selectedNode); setTimeout(() => fitView({ padding: 0.3, duration: 300 }), 100); }}
                  className="text-[8px] px-1.5 py-0.5 rounded bg-[var(--accent)]/20 text-[var(--accent)] hover:bg-[var(--accent)]/30"
                >
                  Trace chain
                </button>
              )}
              <button onClick={() => setSelectedNode(null)}
                className="text-[8px] px-1.5 py-0.5 rounded bg-[var(--bg-secondary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]">
                Close
              </button>
            </div>

            {/* Functions & classes */}
            {selectedSymbols.length > 0 && (
              <div>
                <div className="text-[8px] text-[var(--text-secondary)] mb-0.5">Symbols ({selectedSymbols.length})</div>
                <div className="space-y-0.5 max-h-40 overflow-y-auto">
                  {selectedSymbols.map((s, i) => (
                    <div key={i} className="flex items-center gap-1 text-[8px]">
                      <span className={`text-[7px] px-0.5 rounded ${s.type === 'class' ? 'bg-purple-500/20 text-purple-400' : 'bg-blue-500/20 text-blue-400'}`}>
                        {s.type === 'class' ? 'C' : 'F'}
                      </span>
                      <span className="text-[var(--text-primary)] truncate">{s.name}</span>
                      {s.line && <span className="text-[7px] text-[var(--text-secondary)] ml-auto">:{s.line}</span>}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Imports (this file depends on) */}
            {selectedConns.imports.length > 0 && (
              <div>
                <div className="text-[8px] text-[var(--text-secondary)] mb-0.5">Imports ({selectedConns.imports.length})</div>
                <div className="space-y-0.5 max-h-28 overflow-y-auto">
                  {selectedConns.imports.map(f => (
                    <button key={f} onClick={() => { setSelectedNode(f); }}
                      className="w-full text-left text-[8px] text-[var(--accent)] hover:underline truncate block">
                      → {f.split('/').slice(-2).join('/')}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Imported by (depends on this file) */}
            {selectedConns.importedBy.length > 0 && (
              <div>
                <div className="text-[8px] text-[var(--text-secondary)] mb-0.5">Imported by ({selectedConns.importedBy.length})</div>
                <div className="space-y-0.5 max-h-28 overflow-y-auto">
                  {selectedConns.importedBy.map(f => (
                    <button key={f} onClick={() => { setSelectedNode(f); }}
                      className="w-full text-left text-[8px] text-[var(--green)] hover:underline truncate block">
                      ← {f.split('/').slice(-2).join('/')}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* No connections */}
            {selectedConns.imports.length === 0 && selectedConns.importedBy.length === 0 && (
              <div className="text-[8px] text-[var(--text-secondary)]">No import connections</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default function MemoryGraph(props: Props) {
  return (
    <ReactFlowProvider>
      <MemoryGraphInner {...props} />
    </ReactFlowProvider>
  );
}
