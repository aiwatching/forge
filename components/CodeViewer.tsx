'use client';

import { useState, useEffect, useCallback, useRef, lazy, Suspense } from 'react';
import type { WebTerminalHandle, WebTerminalProps } from './WebTerminal';
import { useSidebarResize } from '@/hooks/useSidebarResize';

const WebTerminal = lazy(() => import('./WebTerminal'));

interface FileNode {
  name: string;
  path: string;
  type: 'file' | 'dir';
  children?: FileNode[];
}

// ─── File Tree ───────────────────────────────────────────

type GitStatusMap = Map<string, string>; // path → status
type GitRepoMap = Map<string, { branch: string; remote: string }>; // dir name → repo info

function TreeNode({ node, depth, selected, onSelect, gitMap, repoMap }: {
  node: FileNode;
  depth: number;
  selected: string | null;
  onSelect: (path: string) => void;
  gitMap: GitStatusMap;
  repoMap: GitRepoMap;
}) {
  // Auto-expand if selected file is under this directory
  const containsSelected = selected ? selected.startsWith(node.path + '/') : false;
  const [manualExpanded, setManualExpanded] = useState<boolean | null>(null);
  const expanded = manualExpanded ?? (depth < 1 || containsSelected);

  if (node.type === 'dir') {
    const dirHasChanges = node.children?.some(c => hasGitChanges(c, gitMap));
    const repo = repoMap.get(node.name);
    return (
      <div>
        <button
          onClick={() => setManualExpanded(v => v === null ? !expanded : !v)}
          className="w-full text-left flex items-center gap-1 px-1 py-0.5 hover:bg-[var(--bg-tertiary)] rounded text-xs group"
          style={{ paddingLeft: depth * 12 + 4 }}
          title={repo ? `${repo.branch} · ${repo.remote.replace(/^https?:\/\//, '').replace(/^git@github\.com:/, 'github.com/').replace(/\.git$/, '')}` : undefined}
        >
          <span className="text-[10px] text-[var(--text-secondary)] w-3">{expanded ? '▾' : '▸'}</span>
          <span className={dirHasChanges ? 'text-yellow-400' : 'text-[var(--text-primary)]'}>{node.name}</span>
          {repo && (
            <span className="text-[8px] text-[var(--accent)] opacity-60 group-hover:opacity-100 ml-auto shrink-0">{repo.branch}</span>
          )}
        </button>
        {expanded && node.children?.map(child => (
          <TreeNode key={child.path} node={child} depth={depth + 1} selected={selected} onSelect={onSelect} gitMap={gitMap} repoMap={repoMap} />
        ))}
      </div>
    );
  }

  const isSelected = selected === node.path;
  const gitStatus = gitMap.get(node.path);
  const gitColor = gitStatus
    ? gitStatus.includes('M') ? 'text-yellow-400'
    : gitStatus.includes('D') ? 'text-red-400'
    : 'text-green-400'  // A, ?, new
    : '';

  return (
    <button
      onClick={() => onSelect(node.path)}
      className={`w-full text-left flex items-center gap-1 px-1 py-0.5 rounded text-xs truncate ${
        isSelected ? 'bg-[var(--accent)]/20 text-[var(--accent)]'
        : gitColor ? `hover:bg-[var(--bg-tertiary)] ${gitColor}`
        : 'hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)]'
      }`}
      style={{ paddingLeft: depth * 12 + 16 }}
      title={node.path}
    >
      {node.name}
    </button>
  );
}

function hasGitChanges(node: FileNode, gitMap: GitStatusMap): boolean {
  if (node.type === 'file') return gitMap.has(node.path);
  return node.children?.some(c => hasGitChanges(c, gitMap)) || false;
}

function flattenTree(nodes: FileNode[]): FileNode[] {
  const result: FileNode[] = [];
  for (const node of nodes) {
    if (node.type === 'file') result.push(node);
    if (node.children) result.push(...flattenTree(node.children));
  }
  return result;
}

const LANG_MAP: Record<string, string> = {
  ts: 'TypeScript', tsx: 'TypeScript (JSX)', js: 'JavaScript', jsx: 'JavaScript (JSX)',
  py: 'Python', go: 'Go', rs: 'Rust', java: 'Java', kt: 'Kotlin',
  css: 'CSS', scss: 'SCSS', html: 'HTML', json: 'JSON', yaml: 'YAML', yml: 'YAML',
  md: 'Markdown', sh: 'Shell', sql: 'SQL', toml: 'TOML', xml: 'XML',
};

// ─── Simple syntax highlighting ──────────────────────────

const KEYWORDS = new Set([
  'import', 'export', 'from', 'const', 'let', 'var', 'function', 'return',
  'if', 'else', 'for', 'while', 'switch', 'case', 'break', 'continue',
  'class', 'extends', 'new', 'this', 'super', 'typeof', 'instanceof',
  'try', 'catch', 'finally', 'throw', 'async', 'await', 'yield',
  'default', 'interface', 'type', 'enum', 'implements', 'readonly',
  'public', 'private', 'protected', 'static', 'abstract',
  'true', 'false', 'null', 'undefined', 'void',
  'def', 'self', 'None', 'True', 'False', 'class', 'lambda', 'with', 'as', 'in', 'not', 'and', 'or',
  'func', 'package', 'struct', 'go', 'defer', 'select', 'chan', 'map', 'range',
  'final', 'synchronized', 'volatile', 'transient', 'native',
  'throws', 'int', 'long', 'double', 'float', 'char', 'byte', 'short', 'boolean',
  'override',
  'val', 'object', 'trait', 'sealed', 'implicit', 'lazy', 'match',
]);

function highlightLine(line: string, lang: string): React.ReactNode {
  if (!line) return ' ';

  // Comments
  const commentIdx = lang === 'py' ? line.indexOf('#') :
    line.indexOf('//');
  if (commentIdx === 0 || (commentIdx > 0 && /^\s*$/.test(line.slice(0, commentIdx)))) {
    return <span className="text-gray-500 italic">{line}</span>;
  }

  // Tokenize with regex
  const parts: React.ReactNode[] = [];
  let lastIdx = 0;

  const regex = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\b\d+\.?\d*\b)|(\/\/.*$|#.*$)|(\b[A-Z_][A-Z_0-9]+\b)|(\b\w+\b)/g;
  let match;

  while ((match = regex.exec(line)) !== null) {
    // Text before match
    if (match.index > lastIdx) {
      parts.push(line.slice(lastIdx, match.index));
    }

    if (match[1]) {
      // String
      parts.push(<span key={match.index} className="text-green-400">{match[0]}</span>);
    } else if (match[2]) {
      // Number
      parts.push(<span key={match.index} className="text-orange-300">{match[0]}</span>);
    } else if (match[3]) {
      // Comment
      parts.push(<span key={match.index} className="text-gray-500 italic">{match[0]}</span>);
    } else if (match[4]) {
      // CONSTANT
      parts.push(<span key={match.index} className="text-cyan-300">{match[0]}</span>);
    } else if (match[5] && KEYWORDS.has(match[5])) {
      // Keyword
      parts.push(<span key={match.index} className="text-purple-400">{match[0]}</span>);
    } else {
      parts.push(match[0]);
    }
    lastIdx = match.index + match[0].length;
  }

  if (lastIdx < line.length) {
    parts.push(line.slice(lastIdx));
  }

  return parts.length > 0 ? <>{parts}</> : line;
}

// ─── Main Component ──────────────────────────────────────

export default function CodeViewer({ terminalRef }: { terminalRef: React.RefObject<WebTerminalHandle | null> }) {
  const [currentDir, setCurrentDir] = useState<string | null>(null);
  const [dirName, setDirName] = useState('');
  const [tree, setTree] = useState<FileNode[]>([]);
  const [gitBranch, setGitBranch] = useState('');
  const [gitChanges, setGitChanges] = useState<{ path: string; status: string }[]>([]);
  const [gitRepos, setGitRepos] = useState<{ name: string; branch: string; remote: string; changes: { path: string; status: string }[] }[]>([]);
  const [showGit, setShowGit] = useState(false);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [language, setLanguage] = useState('');
  const [loading, setLoading] = useState(false);
  const [fileWarning, setFileWarning] = useState<{ type: 'binary' | 'large' | 'tooLarge'; label: string; fileType?: string } | null>(null);
  const [search, setSearch] = useState('');
  const [diffContent, setDiffContent] = useState<string | null>(null);
  const [diffFile, setDiffFile] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'file' | 'diff'>('file');
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [codeOpen, setCodeOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState('');
  const [saving, setSaving] = useState(false);

  const handleCodeOpenChange = useCallback((open: boolean) => {
    setCodeOpen(open);
  }, []);
  const [terminalHeight, setTerminalHeight] = useState(300);
  const [activeSession, setActiveSession] = useState<string | null>(null);
  const [taskNotification, setTaskNotification] = useState<{ id: string; status: string; prompt: string; sessionId?: string } | null>(null);
  const dragRef = useRef<{ startY: number; startH: number } | null>(null);
  const { sidebarWidth, onSidebarDragStart } = useSidebarResize({ defaultWidth: 224, minWidth: 120, maxWidth: 480 });
  const lastDirRef = useRef<string | null>(null);
  const lastTaskCheckRef = useRef<string>('');

  // When active terminal session changes, query its cwd
  useEffect(() => {
    if (!activeSession) return;
    let cancelled = false;

    const fetchCwd = async () => {
      try {
        const res = await fetch(`/api/terminal-cwd?session=${encodeURIComponent(activeSession)}`);
        const data = await res.json();
        if (!cancelled && data.path && data.path !== lastDirRef.current) {
          lastDirRef.current = data.path;
          setCurrentDir(data.path);
          setSelectedFile(null);
          setContent(null);
        }
      } catch {}
    };

    fetchCwd();
    // Poll cwd every 15s (user might cd to a different directory)
    const timer = setInterval(fetchCwd, 15000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [activeSession]);

  // Fetch file tree when directory changes
  useEffect(() => {
    if (!currentDir) return;
    const fetchDir = () => {
      fetch(`/api/code?dir=${encodeURIComponent(currentDir)}`)
        .then(r => r.json())
        .then(data => {
          setTree(data.tree || []);
          setDirName(data.dirName || currentDir.split('/').pop() || '');
          setGitBranch(data.gitBranch || '');
          setGitChanges(data.gitChanges || []);
          setGitRepos(data.gitRepos || []);
        })
        .catch(() => setTree([]));
    };
    fetchDir();
  }, [currentDir]);

  // Task completion is notified via hook stop — no polling needed

  // Build git status map for tree coloring
  const gitMap: GitStatusMap = new Map(gitChanges.map(g => [g.path, g.status]));
  const repoMap: GitRepoMap = new Map(gitRepos.filter(r => r.name !== '.').map(r => [r.name, { branch: r.branch, remote: r.remote }]));

  const openFile = useCallback(async (path: string, forceLoad?: boolean) => {
    if (!currentDir) return;
    setSelectedFile(path);
    setViewMode('file');
    setFileWarning(null);
    setLoading(true);

    const url = `/api/code?dir=${encodeURIComponent(currentDir)}&file=${encodeURIComponent(path)}${forceLoad ? '&force=1' : ''}`;
    const res = await fetch(url);
    const data = await res.json();

    if (data.binary) {
      setContent(null);
      setFileWarning({ type: 'binary', label: data.sizeLabel, fileType: data.fileType });
    } else if (data.tooLarge) {
      setContent(null);
      setFileWarning({ type: 'tooLarge', label: data.sizeLabel });
    } else if (data.large && !forceLoad) {
      setContent(null);
      setFileWarning({ type: 'large', label: data.sizeLabel });
      setLanguage(data.language || '');
    } else {
      setContent(data.content || null);
      setLanguage(data.language || '');
    }
    setLoading(false);
  }, [currentDir]);

  const openDiff = useCallback(async (path: string) => {
    if (!currentDir) return;
    setDiffFile(path);
    setViewMode('diff');
    setLoading(true);
    const res = await fetch(`/api/code?dir=${encodeURIComponent(currentDir)}&diff=${encodeURIComponent(path)}`);
    const data = await res.json();
    setDiffContent(data.diff || null);
    setLoading(false);
  }, [currentDir]);

  // Open file and auto-expand its parent dirs in tree
  const locateFile = useCallback((path: string) => {
    setSearch(''); // clear search so tree is visible
    openFile(path);
  }, [openFile]);

  const allFiles = flattenTree(tree);
  const filtered = search
    ? allFiles.filter(f => f.name.toLowerCase().includes(search.toLowerCase()) || f.path.toLowerCase().includes(search.toLowerCase()))
    : null;

  const onDragStart = (e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current = { startY: e.clientY, startH: terminalHeight };
    const onMove = (ev: MouseEvent) => {
      if (!dragRef.current) return;
      const delta = ev.clientY - dragRef.current.startY;
      setTerminalHeight(Math.max(100, Math.min(600, dragRef.current.startH + delta)));
    };
    const onUp = () => {
      dragRef.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  // Git operations
  const [commitMsg, setCommitMsg] = useState('');
  const [gitLoading, setGitLoading] = useState(false);
  const [gitResult, setGitResult] = useState<{ ok?: boolean; error?: string } | null>(null);

  const gitAction = useCallback(async (action: string, extra?: any) => {
    if (!currentDir) return;
    setGitLoading(true);
    setGitResult(null);
    try {
      const res = await fetch('/api/git', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, dir: currentDir, ...extra }),
      });
      const data = await res.json();
      setGitResult(data);
      // Refresh git status
      if (data.ok) {
        const r = await fetch(`/api/code?dir=${encodeURIComponent(currentDir)}`);
        const d = await r.json();
        setGitChanges(d.gitChanges || []);
        setGitRepos(d.gitRepos || []);
        setGitBranch(d.gitBranch || '');
        if (action === 'commit') setCommitMsg('');
      }
    } catch (e: any) {
      setGitResult({ error: e.message });
    }
    setGitLoading(false);
    setTimeout(() => setGitResult(null), 5000);
  }, [currentDir]);

  const refreshAll = useCallback(() => {
    if (!currentDir) return;
    // Refresh tree + git
    fetch(`/api/code?dir=${encodeURIComponent(currentDir)}`)
      .then(r => r.json())
      .then(data => {
        setTree(data.tree || []);
        setDirName(data.dirName || currentDir.split('/').pop() || '');
        setGitBranch(data.gitBranch || '');
        setGitChanges(data.gitChanges || []);
        setGitRepos(data.gitRepos || []);
      })
      .catch(() => {});
    // Refresh open file
    if (selectedFile) openFile(selectedFile);
  }, [currentDir, selectedFile, openFile]);

  const handleActiveSession = useCallback((session: string | null) => {
    setActiveSession(session);
  }, []);

  return (
    <div className="flex-1 flex flex-col min-h-0 min-w-0 overflow-hidden">
      {/* Task completion notification */}
      {taskNotification && (
        <div className="shrink-0 px-3 py-1.5 bg-green-900/30 border-b border-green-800/50 flex items-center gap-2 text-xs">
          <span className="text-green-400">{taskNotification.status === 'done' ? '✅' : '❌'}</span>
          <span className="text-green-300 truncate">Task {taskNotification.id}: {taskNotification.prompt.slice(0, 60)}</span>
          {taskNotification.sessionId && (
            <button
              onClick={() => {
                // Send claude --resume to the active terminal
                // The tmux display-message from backend already showed the notification
                setTaskNotification(null);
              }}
              className="ml-auto text-[10px] text-green-400 hover:text-white shrink-0"
            >
              Dismiss
            </button>
          )}
        </div>
      )}

      {/* Terminal + Browser — main area */}
      <div className={codeOpen ? 'shrink-0' : 'flex-1'} style={codeOpen ? { height: terminalHeight } : undefined}>
        <Suspense fallback={<div className="h-full flex items-center justify-center text-[var(--text-secondary)] text-xs">Loading...</div>}>
          <WebTerminal ref={terminalRef} onActiveSession={handleActiveSession} onCodeOpenChange={handleCodeOpenChange} />
        </Suspense>
      </div>

      {/* Resize handle */}
      {codeOpen && (
        <div
          onMouseDown={onDragStart}
          className="h-1 bg-[var(--border)] cursor-row-resize hover:bg-[var(--accent)]/50 shrink-0"
        />
      )}

      {/* File browser + code viewer — bottom */}
      {codeOpen && <div className="flex-1 flex min-h-0 min-w-0 overflow-hidden">
        {/* Sidebar */}
        {sidebarOpen && (
          <aside style={{ width: sidebarWidth }} className="flex flex-col shrink-0 overflow-hidden">
            {/* Directory name + git */}
            <div className="px-3 py-2 border-b border-[var(--border)]">
              <div className="flex items-center gap-2">
                <span className="text-[11px] font-semibold text-[var(--text-primary)] truncate">
                  {dirName || 'No directory'}
                </span>
                {gitBranch && (
                  <span className="text-[9px] text-[var(--accent)] bg-[var(--accent)]/10 px-1.5 py-0.5 rounded shrink-0">
                    {gitBranch}
                  </span>
                )}
                <button
                  onClick={refreshAll}
                  className="text-[9px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] ml-auto shrink-0"
                  title="Refresh files & git status"
                >
                  ↻
                </button>
              </div>
              {gitRepos.find(r => r.name === '.')?.remote && (
                <div className="text-[9px] text-[var(--text-secondary)] truncate mt-0.5" title={gitRepos.find(r => r.name === '.')!.remote}>
                  {gitRepos.find(r => r.name === '.')!.remote.replace(/^https?:\/\//, '').replace(/^git@github\.com:/, 'github.com/').replace(/\.git$/, '')}
                </div>
              )}
              {gitChanges.length > 0 && (
                <button
                  onClick={() => setShowGit(v => !v)}
                  className="text-[10px] text-yellow-500 hover:text-yellow-400 mt-1 block"
                >
                  {gitChanges.length} changes {showGit ? '▾' : '▸'}
                </button>
              )}
            </div>

            {/* Git changes — grouped by repo */}
            {showGit && gitChanges.length > 0 && (
              <div className="border-b border-[var(--border)] max-h-48 overflow-y-auto">
                {gitRepos.map(repo => (
                  <div key={repo.name}>
                    {/* Repo header — only show if multiple repos */}
                    {gitRepos.length > 1 && (
                      <div className="px-2 py-1 text-[9px] text-[var(--text-secondary)] bg-[var(--bg-tertiary)] sticky top-0" title={repo.remote}>
                        <div className="flex items-center gap-1.5">
                          <span className="font-semibold text-[var(--text-primary)]">{repo.name}</span>
                          <span className="text-[var(--accent)]">{repo.branch}</span>
                          <span className="ml-auto">{repo.changes.length}</span>
                        </div>
                        {repo.remote && (
                          <div className="text-[8px] truncate mt-0.5">{repo.remote.replace(/^https?:\/\//, '').replace(/\.git$/, '')}</div>
                        )}
                      </div>
                    )}
                    {repo.changes.map(g => (
                      <div
                        key={g.path}
                        className={`flex items-center px-2 py-1 text-xs hover:bg-[var(--bg-tertiary)] ${
                          diffFile === g.path && viewMode === 'diff' ? 'bg-[var(--accent)]/10' : ''
                        }`}
                      >
                        <span className={`text-[10px] font-mono w-4 shrink-0 ${
                          g.status.includes('M') ? 'text-yellow-500' :
                          g.status.includes('A') || g.status.includes('?') ? 'text-green-500' :
                          g.status.includes('D') ? 'text-red-500' :
                          'text-[var(--text-secondary)]'
                        }`}>
                          {g.status.includes('?') ? '+' : g.status[0]}
                        </span>
                        <button
                          onClick={() => openDiff(g.path)}
                          className="flex-1 text-left truncate text-[var(--text-secondary)] hover:text-[var(--text-primary)] ml-1 group relative"
                          title={`${g.path}${gitRepos.length > 1 ? ` (${repo.name} · ${repo.branch})` : ''}`}
                        >
                          {gitRepos.length > 1 ? g.path.replace(repo.name + '/', '') : g.path}
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); locateFile(g.path); }}
                          className="text-[10px] text-[var(--text-secondary)] hover:text-[var(--accent)] hover:bg-[var(--accent)]/10 px-1.5 py-0.5 rounded shrink-0"
                          title="Locate in file tree"
                    >
                      file
                    </button>
                      </div>
                    ))}
                  </div>
                ))}
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

            {/* Tree */}
            <div className="flex-1 overflow-y-auto p-1">
              {!currentDir ? (
                <div className="text-xs text-[var(--text-secondary)] p-2">Open a terminal to see files</div>
              ) : filtered ? (
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
                      <span className="text-[var(--text-primary)]">{f.name}</span>
                      <span className="text-[9px] text-[var(--text-secondary)] ml-1">{f.path.split('/').slice(0, -1).join('/')}</span>
                    </button>
                  ))
                )
              ) : (
                tree.map(node => (
                  <TreeNode key={node.path} node={node} depth={0} selected={selectedFile} onSelect={openFile} gitMap={gitMap} repoMap={repoMap} />
                ))
              )}
            </div>

            {/* Git actions — bottom of sidebar */}
            {currentDir && (gitChanges.length > 0 || gitRepos.length > 0) && (
              <div className="border-t border-[var(--border)] shrink-0 p-2 space-y-1.5">
                <div className="flex gap-1.5">
                  <input
                    value={commitMsg}
                    onChange={e => setCommitMsg(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && commitMsg.trim() && gitAction('commit', { message: commitMsg.trim() })}
                    placeholder="Commit message..."
                    className="flex-1 text-[10px] bg-[var(--bg-tertiary)] border border-[var(--border)] rounded px-2 py-1 text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)]"
                  />
                  <button
                    onClick={() => commitMsg.trim() && gitAction('commit', { message: commitMsg.trim() })}
                    disabled={gitLoading || !commitMsg.trim() || gitChanges.length === 0}
                    className="text-[9px] px-2 py-1 bg-[var(--accent)] text-white rounded hover:opacity-90 disabled:opacity-50 shrink-0"
                  >
                    Commit
                  </button>
                </div>
                <div className="flex gap-1.5">
                  <button
                    onClick={() => gitAction('push')}
                    disabled={gitLoading}
                    className="flex-1 text-[9px] py-1 border border-[var(--accent)] text-[var(--accent)] rounded hover:bg-[var(--accent)] hover:text-white disabled:opacity-50"
                  >
                    Push
                  </button>
                  <button
                    onClick={() => gitAction('pull')}
                    disabled={gitLoading}
                    className="flex-1 text-[9px] py-1 text-[var(--text-secondary)] border border-[var(--border)] rounded hover:text-[var(--text-primary)] hover:border-[var(--text-secondary)] disabled:opacity-50"
                  >
                    Pull
                  </button>
                </div>
                {gitResult && (
                  <div className={`text-[9px] ${gitResult.ok ? 'text-green-400' : 'text-red-400'}`}>
                    {gitResult.ok ? '✅ Done' : `❌ ${gitResult.error}`}
                  </div>
                )}
              </div>
            )}
          </aside>
        )}

        {/* Sidebar resize handle */}
        {sidebarOpen && (
          <div
            onMouseDown={onSidebarDragStart}
            className="w-1 bg-[var(--border)] cursor-col-resize shrink-0 hover:bg-[var(--accent)]/50 transition-colors"
          />
        )}

        {/* Code viewer */}
        <main className="flex-1 flex flex-col min-w-0 overflow-hidden" style={{ width: 0 }}>
          <div className="px-3 py-1.5 border-b border-[var(--border)] shrink-0 flex items-center gap-2">
            <button
              onClick={() => setSidebarOpen(v => !v)}
              className="text-[10px] px-1.5 py-0.5 text-gray-400 hover:text-white hover:bg-[var(--bg-tertiary)] rounded"
            >
              {sidebarOpen ? '◀' : '▶'}
            </button>
            {viewMode === 'diff' && diffFile ? (
              <>
                <span className="text-xs font-semibold text-yellow-400 truncate">{diffFile}</span>
                <span className="text-[9px] text-[var(--text-secondary)] ml-auto">diff</span>
              </>
            ) : selectedFile ? (
              <>
                <span className="text-xs font-semibold text-[var(--text-primary)] truncate">{selectedFile}</span>
                {language && (
                  <span className="text-[9px] text-[var(--text-secondary)] ml-auto mr-2">{LANG_MAP[language] || language}</span>
                )}
                {content !== null && !editing && (
                  <button
                    onClick={() => { setEditing(true); setEditContent(content); }}
                    className="text-[9px] px-2 py-0.5 border border-[var(--border)] rounded text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:border-[var(--text-secondary)] shrink-0 ml-auto"
                  >
                    Edit
                  </button>
                )}
                {editing && (
                  <>
                    <button
                      disabled={saving}
                      onClick={async () => {
                        if (!currentDir || !selectedFile) return;
                        setSaving(true);
                        await fetch('/api/code', {
                          method: 'PUT',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ dir: currentDir, file: selectedFile, content: editContent }),
                        });
                        setContent(editContent);
                        setEditing(false);
                        setSaving(false);
                      }}
                      className="text-[9px] px-2 py-0.5 bg-[var(--accent)] text-white rounded hover:opacity-90 disabled:opacity-50 shrink-0 ml-auto"
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
              <span className="text-xs text-[var(--text-secondary)]">{dirName || 'Code'}</span>
            )}
          </div>

          {loading ? (
            <div className="flex-1 flex items-center justify-center">
              <div className="text-xs text-[var(--text-secondary)]">Loading...</div>
            </div>
          ) : fileWarning ? (
            <div className="flex-1 flex items-center justify-center">
              <div className="text-center space-y-3 p-6">
                {fileWarning.type === 'binary' && (
                  <>
                    <div className="text-3xl">🚫</div>
                    <p className="text-sm text-[var(--text-primary)]">Binary file cannot be displayed</p>
                    <p className="text-xs text-[var(--text-secondary)]">{fileWarning.fileType?.toUpperCase()} · {fileWarning.label}</p>
                  </>
                )}
                {fileWarning.type === 'tooLarge' && (
                  <>
                    <div className="text-3xl">⚠️</div>
                    <p className="text-sm text-[var(--text-primary)]">File too large to display</p>
                    <p className="text-xs text-[var(--text-secondary)]">{fileWarning.label} — exceeds 2 MB limit</p>
                  </>
                )}
                {fileWarning.type === 'large' && (
                  <>
                    <div className="text-3xl">📄</div>
                    <p className="text-sm text-[var(--text-primary)]">Large file: {fileWarning.label}</p>
                    <p className="text-xs text-[var(--text-secondary)]">This file may slow down the browser</p>
                    <button
                      onClick={() => selectedFile && openFile(selectedFile, true)}
                      className="text-xs px-4 py-1.5 bg-[var(--accent)] text-white rounded hover:opacity-90 mt-2"
                    >
                      Open anyway
                    </button>
                  </>
                )}
              </div>
            </div>
          ) : viewMode === 'diff' && diffContent ? (
            <div className="flex-1 overflow-auto bg-[var(--bg-primary)]">
              <pre className="p-4 text-[12px] leading-[1.5] font-mono whitespace-pre" style={{ fontFamily: 'Menlo, Monaco, "Courier New", monospace', tabSize: 2, overflow: 'auto', maxWidth: 0, minWidth: '100%' }}>
                {diffContent.split('\n').map((line, i) => {
                  const color = line.startsWith('+') ? 'text-green-400 bg-green-900/20'
                    : line.startsWith('-') ? 'text-red-400 bg-red-900/20'
                    : line.startsWith('@@') ? 'text-cyan-400'
                    : line.startsWith('diff') || line.startsWith('index') ? 'text-[var(--text-secondary)]'
                    : 'text-[var(--text-primary)]';
                  return (
                    <div key={i} className={`${color} px-2`}>
                      {line || ' '}
                    </div>
                  );
                })}
              </pre>
            </div>
          ) : selectedFile && content !== null ? (
            editing ? (
              <div className="flex-1 overflow-hidden flex flex-col">
                <textarea
                  value={editContent}
                  onChange={e => setEditContent(e.target.value)}
                  onKeyDown={e => {
                    // Tab key inserts 2 spaces
                    if (e.key === 'Tab') {
                      e.preventDefault();
                      const ta = e.target as HTMLTextAreaElement;
                      const start = ta.selectionStart;
                      const end = ta.selectionEnd;
                      setEditContent(editContent.slice(0, start) + '  ' + editContent.slice(end));
                      setTimeout(() => { ta.selectionStart = ta.selectionEnd = start + 2; }, 0);
                    }
                  }}
                  className="flex-1 w-full p-4 bg-[var(--bg-primary)] text-[var(--text-primary)] text-[12px] leading-[1.5] font-mono resize-none focus:outline-none"
                  style={{ fontFamily: 'Menlo, Monaco, "Courier New", monospace', tabSize: 2 }}
                  spellCheck={false}
                />
              </div>
            ) : (
            <div className="flex-1 overflow-auto bg-[var(--bg-primary)]">
              <pre className="p-4 text-[12px] leading-[1.5] font-mono text-[var(--text-primary)] whitespace-pre" style={{ fontFamily: 'Menlo, Monaco, "Courier New", monospace', tabSize: 2, overflow: 'auto', maxWidth: 0, minWidth: '100%' }}>
                {content.split('\n').map((line, i) => (
                  <div key={i} className="flex hover:bg-[var(--bg-tertiary)]/50">
                    <span className="select-none text-[var(--text-secondary)]/40 text-right pr-4 w-10 shrink-0">{i + 1}</span>
                    <span className="whitespace-pre">{highlightLine(line, language)}</span>
                  </div>
                ))}
              </pre>
            </div>
            )
          ) : (
            <div className="flex-1 flex items-center justify-center text-[var(--text-secondary)]">
              <p className="text-xs">{currentDir ? 'Select a file to view' : 'Terminal will show files for its working directory'}</p>
            </div>
          )}
        </main>
      </div>}

    </div>
  );
}
