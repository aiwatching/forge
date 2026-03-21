'use client';

import { useState, useEffect, useCallback, useRef, lazy, Suspense } from 'react';
import MarkdownContent from './MarkdownContent';
import TabBar from './TabBar';

const DocTerminal = lazy(() => import('./DocTerminal'));

interface DocTab {
  id: number;
  filePath: string;
  fileName: string;
  rootIdx: number;
  content: string | null;
  isImage: boolean;
}

function genTabId(): number { return Date.now() + Math.floor(Math.random() * 10000); }

interface FileNode {
  name: string;
  path: string;
  type: 'file' | 'dir';
  fileType?: 'md' | 'image' | 'other';
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
  const canOpen = node.fileType === 'md' || node.fileType === 'image';

  return (
    <button
      onClick={() => canOpen && onSelect(node.path)}
      className={`w-full text-left flex items-center gap-1 px-1 py-0.5 rounded text-xs truncate ${
        !canOpen ? 'text-[var(--text-secondary)]/40 cursor-default'
        : isSelected ? 'bg-[var(--accent)]/20 text-[var(--accent)]'
        : 'hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)]'
      }`}
      style={{ paddingLeft: depth * 12 + 16 }}
      title={node.path}
    >
      {node.fileType === 'image' ? '🖼 ' : ''}{node.name.replace(/\.md$/, '')}
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
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState('');
  const [saving, setSaving] = useState(false);
  const dragRef = useRef<{ startY: number; startH: number } | null>(null);

  // Doc tabs
  const [docTabs, setDocTabs] = useState<DocTab[]>([]);
  const [activeDocTabId, setActiveDocTabId] = useState(0);
  const saveTimerRef = useRef<any>(null);

  // Load tabs from DB on mount
  useEffect(() => {
    fetch('/api/tabs?type=docs').then(r => r.json())
      .then(data => {
        if (Array.isArray(data.tabs) && data.tabs.length > 0) {
          setDocTabs(data.tabs);
          setActiveDocTabId(data.activeTabId || data.tabs[0].id);
          // Set selectedFile to active tab's file
          const activeId = data.activeTabId || data.tabs[0].id;
          const active = data.tabs.find((t: any) => t.id === activeId);
          if (active) {
            setSelectedFile(active.filePath);
            // Content not stored in DB, fetch it
            if (!active.isImage) {
              fetch(`/api/docs?root=${active.rootIdx}&file=${encodeURIComponent(active.filePath)}`)
                .then(r => r.json())
                .then(d => { setContent(d.content || null); })
                .catch(() => {});
            }
          }
        }
      }).catch(() => {});
  }, []);

  // Persist tabs (debounced)
  const persistDocTabs = useCallback((tabs: DocTab[], activeId: number) => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      fetch('/api/tabs?type=docs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tabs: tabs.map(t => ({ id: t.id, filePath: t.filePath, fileName: t.fileName, rootIdx: t.rootIdx, isImage: t.isImage })),
          activeTabId: activeId,
        }),
      }).catch(() => {});
    }, 500);
  }, []);

  // Open file in tab
  const openFileInTab = useCallback(async (path: string) => {
    setSelectedFile(path);
    setEditing(false);
    setFileWarning(null);

    const isImg = isImageFile(path);
    const fileName = path.split('/').pop() || path;

    // Check if tab already exists (use functional update to get latest state)
    let found = false;
    setDocTabs(prev => {
      const existing = prev.find(t => t.filePath === path);
      if (existing) {
        found = true;
        setActiveDocTabId(existing.id);
        setContent(existing.content);
        persistDocTabs(prev, existing.id);
      }
      return prev;
    });
    if (found) return;

    // Fetch content
    let fileContent: string | null = null;
    if (!isImg) {
      setLoading(true);
      const res = await fetch(`/api/docs?root=${activeRoot}&file=${encodeURIComponent(path)}`);
      const data = await res.json();
      if (data.tooLarge) {
        setFileWarning(`File too large (${data.sizeLabel})`);
      } else {
        fileContent = data.content || null;
      }
      setLoading(false);
    }
    setContent(fileContent);

    const newTab: DocTab = { id: genTabId(), filePath: path, fileName, rootIdx: activeRoot, isImage: isImg, content: fileContent };
    setDocTabs(prev => {
      // Double-check no duplicate
      if (prev.find(t => t.filePath === path)) return prev;
      const updated = [...prev, newTab];
      setActiveDocTabId(newTab.id);
      persistDocTabs(updated, newTab.id);
      return updated;
    });
  }, [activeRoot, persistDocTabs]);

  const closeDocTab = useCallback((tabId: number) => {
    setDocTabs(prev => {
      const updated = prev.filter(t => t.id !== tabId);
      let newActiveId = activeDocTabId;
      if (tabId === activeDocTabId) {
        const idx = prev.findIndex(t => t.id === tabId);
        const next = updated[Math.min(idx, updated.length - 1)];
        newActiveId = next?.id || 0;
        if (next) { setSelectedFile(next.filePath); setContent(next.content); }
        else { setSelectedFile(null); setContent(null); }
      }
      setActiveDocTabId(newActiveId);
      persistDocTabs(updated, newActiveId);
      return updated;
    });
  }, [activeDocTabId, persistDocTabs]);

  const activateDocTab = useCallback(async (tabId: number) => {
    const tab = docTabs.find(t => t.id === tabId);
    if (tab) {
      setActiveDocTabId(tabId);
      setSelectedFile(tab.filePath);
      setEditing(false);
      if (tab.rootIdx !== activeRoot) setActiveRoot(tab.rootIdx);
      persistDocTabs(docTabs, tabId);

      // Use cached content or re-fetch
      if (tab.content) {
        setContent(tab.content);
      } else if (!tab.isImage) {
        setLoading(true);
        const res = await fetch(`/api/docs?root=${tab.rootIdx}&file=${encodeURIComponent(tab.filePath)}`);
        const data = await res.json();
        const fetched = data.content || null;
        setContent(fetched);
        // Cache in tab
        setDocTabs(prev => prev.map(t => t.id === tabId ? { ...t, content: fetched } : t));
        setLoading(false);
      }
    }
  }, [docTabs, activeRoot, persistDocTabs]);

  // Fetch tree
  const fetchTree = useCallback(async (rootIdx: number) => {
    const res = await fetch(`/api/docs?root=${rootIdx}`);
    const data = await res.json();
    setRoots(data.roots || []);
    setRootPaths(data.rootPaths || []);
    setTree(data.tree || []);
  }, []);

  useEffect(() => { fetchTree(activeRoot); }, [activeRoot, fetchTree]);

  // Re-fetch when tab becomes visible (settings may have changed)
  useEffect(() => {
    const handleVisibility = () => {
      if (!document.hidden) fetchTree(activeRoot);
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, [activeRoot, fetchTree]);

  const [fileWarning, setFileWarning] = useState<string | null>(null);

  // Fetch file content
  const isImageFile = (path: string) => /\.(png|jpg|jpeg|gif|svg|webp|bmp|ico|avif)$/i.test(path);

  const openFile = useCallback(async (path: string) => {
    setSelectedFile(path);
    setFileWarning(null);

    if (isImageFile(path)) {
      setContent(null);
      setLoading(false);
      return; // images rendered directly via img tag
    }

    setLoading(true);
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
            {roots.length > 0 && (
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

            {/* Header with refresh */}
            <div className="px-3 py-1.5 border-b border-[var(--border)] flex items-center">
              <span className="text-[10px] text-[var(--text-secondary)] truncate">{roots[activeRoot] || 'Docs'}</span>
              <button
                onClick={() => { fetchTree(activeRoot); if (selectedFile) openFile(selectedFile); }}
                className="text-[9px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] ml-auto shrink-0"
                title="Refresh files"
              >
                ↻
              </button>
            </div>

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
                      onClick={() => { openFileInTab(f.path); setSearch(''); }}
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
                  <TreeNode key={node.path} node={node} depth={0} selected={selectedFile} onSelect={openFileInTab} />
                ))
              )}
            </div>
          </aside>
        )}

        {/* Main content */}
        <main className="flex-1 flex flex-col min-w-0">
          {/* Doc tab bar */}
          {docTabs.length > 0 && (
            <TabBar
              tabs={docTabs.map(t => ({ id: t.id, label: t.fileName.replace(/\.md$/, '') }))}
              activeId={activeDocTabId}
              onActivate={activateDocTab}
              onClose={closeDocTab}
            />
          )}

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
                <span className="text-[9px] text-[var(--text-secondary)] ml-auto mr-2">{selectedFile}</span>
                {content && !isImageFile(selectedFile) && !editing && (
                  <button
                    onClick={() => { setEditing(true); setEditContent(content); }}
                    className="text-[9px] px-2 py-0.5 border border-[var(--border)] rounded text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:border-[var(--text-secondary)] shrink-0"
                  >
                    Edit
                  </button>
                )}
                {editing && (
                  <>
                    <button
                      disabled={saving}
                      onClick={async () => {
                        setSaving(true);
                        await fetch('/api/docs', {
                          method: 'PUT',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ root: activeRoot, file: selectedFile, content: editContent }),
                        });
                        setContent(editContent);
                        setEditing(false);
                        setSaving(false);
                      }}
                      className="text-[9px] px-2 py-0.5 bg-[var(--accent)] text-white rounded hover:opacity-90 disabled:opacity-50 shrink-0"
                    >
                      {saving ? 'Saving...' : 'Save'}
                    </button>
                    <button
                      onClick={() => setEditing(false)}
                      className="text-[9px] px-2 py-0.5 text-[var(--text-secondary)] hover:text-[var(--text-primary)] shrink-0"
                    >
                      Cancel
                    </button>
                  </>
                )}
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
          ) : selectedFile && isImageFile(selectedFile) ? (
            <div className="flex-1 overflow-auto flex items-center justify-center p-6 bg-[var(--bg-tertiary)]">
              <img
                src={`/api/docs?root=${activeRoot}&image=${encodeURIComponent(selectedFile)}`}
                alt={selectedFile}
                className="max-w-full max-h-full object-contain rounded shadow-lg"
              />
            </div>
          ) : selectedFile && content ? (
            editing ? (
              <div className="flex-1 overflow-hidden flex flex-col">
                <textarea
                  value={editContent}
                  onChange={e => setEditContent(e.target.value)}
                  className="flex-1 w-full p-4 bg-[var(--bg-primary)] text-[var(--text-primary)] text-[13px] font-mono leading-relaxed resize-none focus:outline-none"
                  style={{ tabSize: 2 }}
                  spellCheck={false}
                />
              </div>
            ) : (
            <div className="flex-1 overflow-y-auto px-8 py-6">
              {loading ? (
                <div className="text-xs text-[var(--text-secondary)]">Loading...</div>
              ) : (
                <div className="max-w-none">
                  <MarkdownContent content={content} />
                </div>
              )}
            </div>
            )
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
