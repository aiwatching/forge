'use client';

import { useState, useEffect, useCallback, useRef, lazy, Suspense } from 'react';
import MarkdownContent from './MarkdownContent';

const DocTerminal = lazy(() => import('./DocTerminal'));

interface FileNode {
  name: string;
  path: string;
  type: 'file' | 'dir';
  children?: FileNode[];
}

// ─── File Tree ───────────────────────────────────────────

function TreeNode({ node, depth, selected, onSelect }: {
  node: FileNode;
  depth: number;
  selected: string | null;
  onSelect: (path: string) => void;
}) {
  const [expanded, setExpanded] = useState(depth < 1);

  if (node.type === 'dir') {
    return (
      <div>
        <button
          onClick={() => setExpanded(v => !v)}
          className="w-full text-left flex items-center gap-1 px-1 py-0.5 hover:bg-[var(--bg-tertiary)] rounded text-xs"
          style={{ paddingLeft: depth * 12 + 4 }}
        >
          <span className="text-[10px] text-[var(--text-secondary)] w-3">{expanded ? '▾' : '▸'}</span>
          <span className="text-[var(--text-primary)]">{node.name}</span>
        </button>
        {expanded && node.children?.map(child => (
          <TreeNode key={child.path} node={child} depth={depth + 1} selected={selected} onSelect={onSelect} />
        ))}
      </div>
    );
  }

  const isSelected = selected === node.path;
  return (
    <button
      onClick={() => onSelect(node.path)}
      className={`w-full text-left flex items-center gap-1 px-1 py-0.5 rounded text-xs truncate ${
        isSelected ? 'bg-[var(--accent)]/20 text-[var(--accent)]' : 'hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)]'
      }`}
      style={{ paddingLeft: depth * 12 + 16 }}
      title={node.path}
    >
      {node.name.replace(/\.md$/, '')}
    </button>
  );
}

// ─── Search ──────────────────────────────────────────────

function flattenTree(nodes: FileNode[]): FileNode[] {
  const result: FileNode[] = [];
  for (const node of nodes) {
    if (node.type === 'file') result.push(node);
    if (node.children) result.push(...flattenTree(node.children));
  }
  return result;
}

// ─── Main Component ──────────────────────────────────────

export default function DocsViewer() {
  const [roots, setRoots] = useState<string[]>([]);
  const [rootPaths, setRootPaths] = useState<string[]>([]);
  const [activeRoot, setActiveRoot] = useState(0);
  const [tree, setTree] = useState<FileNode[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [terminalHeight, setTerminalHeight] = useState(250);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const dragRef = useRef<{ startY: number; startH: number } | null>(null);

  // Fetch tree
  const fetchTree = useCallback(async (rootIdx: number) => {
    const res = await fetch(`/api/docs?root=${rootIdx}`);
    const data = await res.json();
    setRoots(data.roots || []);
    setRootPaths(data.rootPaths || []);
    setTree(data.tree || []);
  }, []);

  useEffect(() => { fetchTree(activeRoot); }, [activeRoot, fetchTree]);

  const [fileWarning, setFileWarning] = useState<string | null>(null);

  // Fetch file content
  const openFile = useCallback(async (path: string) => {
    setSelectedFile(path);
    setLoading(true);
    setFileWarning(null);
    const res = await fetch(`/api/docs?root=${activeRoot}&file=${encodeURIComponent(path)}`);
    const data = await res.json();
    if (data.tooLarge) {
      setContent(null);
      setFileWarning(`File too large (${data.sizeLabel})`);
    } else {
      setContent(data.content || null);
    }
    setLoading(false);
  }, [activeRoot]);

  // Search filter
  const allFiles = flattenTree(tree);
  const filtered = search
    ? allFiles.filter(f => f.name.toLowerCase().includes(search.toLowerCase()) || f.path.toLowerCase().includes(search.toLowerCase()))
    : null;

  // Drag to resize terminal
  const onDragStart = (e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current = { startY: e.clientY, startH: terminalHeight };
    const onMove = (ev: MouseEvent) => {
      if (!dragRef.current) return;
      const delta = dragRef.current.startY - ev.clientY;
      setTerminalHeight(Math.max(100, Math.min(500, dragRef.current.startH + delta)));
    };
    const onUp = () => {
      dragRef.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  if (roots.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-[var(--text-secondary)]">
        <div className="text-center space-y-2">
          <p className="text-lg">No document directories configured</p>
          <p className="text-xs">Add directories in Settings → Document Roots</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Doc content area */}
      <div className="flex-1 flex min-h-0">
        {/* Collapsible sidebar — file tree */}
        {sidebarOpen && (
          <aside className="w-56 border-r border-[var(--border)] flex flex-col shrink-0">
            {/* Root selector */}
            {roots.length > 1 && (
              <div className="p-2 border-b border-[var(--border)]">
                <select
                  value={activeRoot}
                  onChange={e => { setActiveRoot(Number(e.target.value)); setSelectedFile(null); setContent(null); }}
                  className="w-full text-xs bg-[var(--bg-tertiary)] border border-[var(--border)] rounded px-2 py-1 text-[var(--text-primary)]"
                >
                  {roots.map((r, i) => <option key={i} value={i}>{r}</option>)}
                </select>
              </div>
            )}

            {/* Search */}
            <div className="p-2 border-b border-[var(--border)]">
              <input
                type="text"
                placeholder="Search..."
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="w-full text-xs bg-[var(--bg-tertiary)] border border-[var(--border)] rounded px-2 py-1 text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)]"
              />
            </div>

            {/* Tree / search results */}
            <div className="flex-1 overflow-y-auto p-1">
              {filtered ? (
                filtered.length === 0 ? (
                  <div className="text-xs text-[var(--text-secondary)] p-2">No matches</div>
                ) : (
                  filtered.map(f => (
                    <button
                      key={f.path}
                      onClick={() => { openFile(f.path); setSearch(''); }}
                      className={`w-full text-left px-2 py-1 rounded text-xs truncate ${
                        selectedFile === f.path ? 'bg-[var(--accent)]/20 text-[var(--accent)]' : 'hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)]'
                      }`}
                      title={f.path}
                    >
                      <span className="text-[var(--text-primary)]">{f.name.replace(/\.md$/, '')}</span>
                      <span className="text-[9px] text-[var(--text-secondary)] ml-1">{f.path.split('/').slice(0, -1).join('/')}</span>
                    </button>
                  ))
                )
              ) : (
                tree.map(node => (
                  <TreeNode key={node.path} node={node} depth={0} selected={selectedFile} onSelect={openFile} />
                ))
              )}
            </div>
          </aside>
        )}

        {/* Main content — full width markdown */}
        <main className="flex-1 flex flex-col min-w-0">
          {/* Top bar */}
          <div className="px-3 py-1.5 border-b border-[var(--border)] shrink-0 flex items-center gap-2">
            <button
              onClick={() => setSidebarOpen(v => !v)}
              className="text-[10px] px-1.5 py-0.5 text-gray-400 hover:text-white hover:bg-[var(--bg-tertiary)] rounded"
              title={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
            >
              {sidebarOpen ? '◀' : '▶'}
            </button>
            {selectedFile ? (
              <>
                <span className="text-xs font-semibold text-[var(--text-primary)] truncate">{selectedFile.replace(/\.md$/, '')}</span>
                <span className="text-[9px] text-[var(--text-secondary)] ml-auto">{selectedFile}</span>
              </>
            ) : (
              <span className="text-xs text-[var(--text-secondary)]">{roots[activeRoot] || 'Docs'}</span>
            )}
          </div>

          {/* Content */}
          {fileWarning ? (
            <div className="flex-1 flex items-center justify-center text-[var(--text-secondary)]">
              <div className="text-center space-y-2">
                <div className="text-3xl">⚠️</div>
                <p className="text-sm">{fileWarning}</p>
              </div>
            </div>
          ) : selectedFile && content ? (
            <div className="flex-1 overflow-y-auto px-8 py-6">
              {loading ? (
                <div className="text-xs text-[var(--text-secondary)]">Loading...</div>
              ) : (
                <div className="max-w-none">
                  <MarkdownContent content={content} />
                </div>
              )}
            </div>
          ) : (
            <div className="flex-1 flex items-center justify-center text-[var(--text-secondary)]">
              <p className="text-xs">Select a document to view</p>
            </div>
          )}
        </main>
      </div>

      {/* Resize handle */}
      <div
        onMouseDown={onDragStart}
        className="h-1 bg-[var(--border)] cursor-row-resize hover:bg-[var(--accent)]/50 shrink-0"
      />

      {/* Bottom — Claude console */}
      <div className="shrink-0" style={{ height: terminalHeight }}>
        <Suspense fallback={<div className="h-full flex items-center justify-center text-[var(--text-secondary)] text-xs">Loading...</div>}>
          <DocTerminal docRoot={rootPaths[activeRoot] || ''} />
        </Suspense>
      </div>
    </div>
  );
}
