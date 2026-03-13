'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import MarkdownContent from './MarkdownContent';

interface SessionEntry {
  type: 'user' | 'assistant_text' | 'tool_use' | 'tool_result' | 'thinking' | 'system';
  content: string;
  toolName?: string;
  model?: string;
  timestamp?: string;
}

interface ClaudeSessionInfo {
  sessionId: string;
  summary?: string;
  firstPrompt?: string;
  messageCount?: number;
  created?: string;
  modified?: string;
  gitBranch?: string;
  fileSize: number;
}

interface Watcher {
  id: string;
  projectName: string;
  sessionId: string | null;
  label: string | null;
  checkInterval: number;
  active: boolean;
  createdAt: string;
}

export default function SessionView({
  projectName,
  projects,
  onOpenInTerminal,
}: {
  projectName?: string;
  projects: { name: string; path: string; language: string | null }[];
  onOpenInTerminal?: (sessionId: string, projectPath: string) => void;
}) {
  // Tree data: project → sessions
  const [sessionTree, setSessionTree] = useState<Record<string, ClaudeSessionInfo[]>>({});
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set());
  const [selectedProject, setSelectedProject] = useState(projectName || '');
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [entries, setEntries] = useState<SessionEntry[]>([]);
  const [expandedTools, setExpandedTools] = useState<Set<number>>(new Set());
  const [syncing, setSyncing] = useState(false);
  const [watchers, setWatchers] = useState<Watcher[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Load cached sessions tree
  const loadTree = useCallback(async (force = false) => {
    setSyncing(true);
    try {
      if (force) {
        const res = await fetch('/api/claude-sessions/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        const data = await res.json();
        setSessionTree(data.sessions);
      } else {
        const res = await fetch('/api/claude-sessions/sync');
        const data = await res.json();
        setSessionTree(data);
      }
    } catch {}
    setSyncing(false);
  }, []);

  // Load watchers
  const loadWatchers = useCallback(async () => {
    try {
      const res = await fetch('/api/watchers');
      setWatchers(await res.json());
    } catch {}
  }, []);

  useEffect(() => {
    loadTree(true); // Initial sync
    loadWatchers();
  }, [loadTree, loadWatchers]);

  // Auto-expand project if only one or if pre-selected
  useEffect(() => {
    const projectNames = Object.keys(sessionTree);
    if (projectName && sessionTree[projectName]) {
      setExpandedProjects(new Set([projectName]));
    } else if (projectNames.length === 1) {
      setExpandedProjects(new Set([projectNames[0]]));
    }
  }, [sessionTree, projectName]);

  // SSE live stream
  useEffect(() => {
    if (!selectedProject || !activeSessionId) return;

    setEntries([]);
    const es = new EventSource(
      `/api/claude-sessions/${encodeURIComponent(selectedProject)}/live?sessionId=${activeSessionId}`
    );

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'init') setEntries(data.entries);
        else if (data.type === 'update') setEntries(prev => [...prev, ...data.entries]);
      } catch {}
    };

    es.onerror = () => es.close();
    return () => es.close();
  }, [selectedProject, activeSessionId]);

  // Auto-scroll
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [entries]);

  const toggleProject = (name: string) => {
    setExpandedProjects(prev => {
      const next = new Set(prev);
      next.has(name) ? next.delete(name) : next.add(name);
      return next;
    });
  };

  const selectSession = (project: string, sessionId: string) => {
    setSelectedProject(project);
    setActiveSessionId(sessionId);
    setEntries([]);
    setExpandedTools(new Set());
  };

  const toggleTool = (i: number) => {
    setExpandedTools(prev => {
      const next = new Set(prev);
      next.has(i) ? next.delete(i) : next.add(i);
      return next;
    });
  };

  const addWatcher = async (project: string, sessionId?: string) => {
    await fetch('/api/watchers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectName: project, sessionId, label: sessionId ? `${project}/${sessionId.slice(0, 8)}` : project }),
    });
    loadWatchers();
  };

  const removeWatcher = async (id: string) => {
    await fetch('/api/watchers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'delete', id }),
    });
    loadWatchers();
  };

  const activeSession = sessionTree[selectedProject]?.find(s => s.sessionId === activeSessionId);
  const watchedSessionIds = new Set(watchers.filter(w => w.active).map(w => w.sessionId));
  const watchedProjects = new Set(watchers.filter(w => w.active && !w.sessionId).map(w => w.projectName));

  return (
    <div className="flex h-full">
      {/* Left: tree view */}
      <div className="w-72 border-r border-[var(--border)] flex flex-col shrink-0">
        {/* Header */}
        <div className="flex items-center justify-between p-2 border-b border-[var(--border)]">
          <span className="text-[10px] font-semibold text-[var(--text-secondary)] uppercase">Sessions</span>
          <button
            onClick={() => loadTree(true)}
            disabled={syncing}
            className="text-[9px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-50"
          >
            {syncing ? 'Syncing...' : 'Sync'}
          </button>
        </div>

        {/* Tree */}
        <div className="flex-1 overflow-y-auto">
          {Object.keys(sessionTree).length === 0 && (
            <p className="text-[10px] text-[var(--text-secondary)] p-3">
              {syncing ? 'Loading sessions...' : 'No sessions found. Click Sync.'}
            </p>
          )}

          {Object.entries(sessionTree).map(([project, sessions]) => (
            <div key={project}>
              {/* Project node */}
              <button
                onClick={() => toggleProject(project)}
                className="w-full flex items-center gap-1.5 px-2 py-1.5 text-left hover:bg-[var(--bg-tertiary)] transition-colors border-b border-[var(--border)]/50"
              >
                <span className="text-[10px] text-[var(--text-secondary)]">
                  {expandedProjects.has(project) ? '▼' : '▶'}
                </span>
                <span className="text-[11px] font-medium text-[var(--text-primary)] truncate flex-1">{project}</span>
                <span className="text-[9px] text-[var(--text-secondary)]">{sessions.length}</span>
                {watchedProjects.has(project) && (
                  <span className="text-[9px] text-[var(--accent)]" title="Watching">👁</span>
                )}
              </button>

              {/* Session children */}
              {expandedProjects.has(project) && sessions.map(s => {
                const isActive = selectedProject === project && activeSessionId === s.sessionId;
                const isWatched = watchedSessionIds.has(s.sessionId);
                return (
                  <button
                    key={s.sessionId}
                    onClick={() => selectSession(project, s.sessionId)}
                    className={`w-full text-left pl-6 pr-2 py-1.5 hover:bg-[var(--bg-tertiary)] transition-colors ${
                      isActive ? 'bg-[var(--bg-tertiary)] border-l-2 border-l-[var(--accent)]' : 'border-l-2 border-l-transparent'
                    }`}
                  >
                    <div className="flex items-center gap-1">
                      <span className="text-[10px] text-[var(--text-primary)] truncate flex-1">
                        {s.summary || s.firstPrompt?.slice(0, 40) || s.sessionId.slice(0, 8)}
                      </span>
                      {isWatched && <span className="text-[8px] text-[var(--accent)]">👁</span>}
                    </div>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className="text-[8px] text-[var(--text-secondary)] font-mono">{s.sessionId.slice(0, 8)}</span>
                      {s.gitBranch && <span className="text-[8px] text-[var(--accent)]">{s.gitBranch}</span>}
                      {s.modified && (
                        <span className="text-[8px] text-[var(--text-secondary)]">
                          {timeAgo(s.modified)}
                        </span>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          ))}

          {/* Active watchers section */}
          {watchers.length > 0 && (
            <div className="border-t border-[var(--border)] mt-2 pt-2">
              <div className="px-2 mb-1">
                <span className="text-[9px] font-semibold text-[var(--text-secondary)] uppercase">Watchers</span>
              </div>
              {watchers.map(w => (
                <div key={w.id} className="flex items-center gap-1 px-2 py-1 text-[10px]">
                  <span className={`${w.active ? 'text-green-400' : 'text-gray-500'}`}>
                    {w.active ? '●' : '○'}
                  </span>
                  <span className="text-[var(--text-secondary)] truncate flex-1">
                    {w.label || w.projectName}
                  </span>
                  <button
                    onClick={() => removeWatcher(w.id)}
                    className="text-[8px] text-gray-500 hover:text-red-400"
                  >
                    x
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Right: session content */}
      <div className="flex-1 flex flex-col min-w-0">
        {activeSession && (
          <div className="border-b border-[var(--border)] px-4 py-2 shrink-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold">{selectedProject}</span>
              <span className="text-[10px] text-[var(--text-secondary)] font-mono">{activeSessionId?.slice(0, 12)}</span>
              {activeSession.gitBranch && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--accent)]/10 text-[var(--accent)]">
                  {activeSession.gitBranch}
                </span>
              )}
              <div className="ml-auto flex items-center gap-2">
                {activeSessionId && !watchedSessionIds.has(activeSessionId) && (
                  <button
                    onClick={() => addWatcher(selectedProject, activeSessionId!)}
                    className="text-[10px] px-2 py-0.5 border border-[var(--border)] text-[var(--text-secondary)] rounded hover:text-[var(--text-primary)] hover:border-[var(--accent)]"
                  >
                    Watch
                  </button>
                )}
                {onOpenInTerminal && activeSessionId && (
                  <button
                    onClick={() => {
                      const proj = projects.find(p => p.name === selectedProject);
                      if (proj) onOpenInTerminal(activeSessionId!, proj.path);
                    }}
                    className="text-[10px] px-2 py-0.5 bg-[var(--accent)] text-white rounded hover:opacity-90"
                  >
                    Open in Terminal
                  </button>
                )}
              </div>
            </div>
            {activeSession.summary && (
              <p className="text-xs text-[var(--text-secondary)] mt-0.5">{activeSession.summary}</p>
            )}
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-4 space-y-2">
          {!activeSessionId && (
            <div className="flex-1 flex items-center justify-center text-[var(--text-secondary)] h-full">
              <p>Select a session from the tree to view</p>
            </div>
          )}

          {entries.map((entry, i) => (
            <SessionEntryView
              key={i}
              entry={entry}
              expanded={expandedTools.has(i)}
              onToggle={() => toggleTool(i)}
            />
          ))}

          {entries.length > 0 && (
            <div className="text-[10px] text-[var(--text-secondary)] pt-2">
              {entries.length} entries — live updating
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      </div>
    </div>
  );
}

// ─── Time ago helper ─────────────────────────────────────────

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// ─── Session entry renderer ─────────────────────────────────

function SessionEntryView({
  entry,
  expanded,
  onToggle,
}: {
  entry: SessionEntry;
  expanded: boolean;
  onToggle: () => void;
}) {
  if (entry.type === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] px-3 py-2 bg-[var(--accent)]/10 border border-[var(--accent)]/20 rounded-lg">
          <p className="text-xs text-[var(--text-primary)] whitespace-pre-wrap">{entry.content}</p>
          {entry.timestamp && (
            <span className="text-[9px] text-[var(--text-secondary)] mt-1 block">
              {new Date(entry.timestamp).toLocaleTimeString()}
            </span>
          )}
        </div>
      </div>
    );
  }

  if (entry.type === 'assistant_text') {
    return (
      <div className="py-1">
        <MarkdownContent content={entry.content} />
      </div>
    );
  }

  if (entry.type === 'thinking') {
    const isLong = entry.content.length > 100;
    return (
      <div className="border border-[var(--border)] rounded overflow-hidden opacity-60">
        <button
          onClick={onToggle}
          className="w-full flex items-center gap-2 px-2 py-1 bg-[var(--bg-tertiary)] hover:bg-[var(--border)]/30 text-left"
        >
          <span className="text-[10px] text-[var(--text-secondary)] italic">thinking...</span>
          {isLong && <span className="text-[9px] text-[var(--text-secondary)] ml-auto">{expanded ? '▲' : '▼'}</span>}
        </button>
        {expanded && (
          <pre className="px-3 py-2 text-[10px] text-[var(--text-secondary)] font-mono whitespace-pre-wrap break-words max-h-40 overflow-y-auto border-t border-[var(--border)]">
            {entry.content}
          </pre>
        )}
      </div>
    );
  }

  if (entry.type === 'tool_use') {
    const isLong = entry.content.length > 80;
    return (
      <div className="border border-[var(--border)] rounded overflow-hidden">
        <button
          onClick={onToggle}
          className="w-full flex items-center gap-2 px-2 py-1.5 bg-[var(--bg-tertiary)] hover:bg-[var(--border)]/30 transition-colors text-left"
        >
          <span className="text-[10px] px-1.5 py-0.5 bg-[var(--accent)]/15 text-[var(--accent)] rounded font-medium font-mono">
            {entry.toolName || 'tool'}
          </span>
          <span className="text-[11px] text-[var(--text-secondary)] truncate flex-1 font-mono">
            {isLong && !expanded ? entry.content.slice(0, 80) + '...' : (!isLong ? entry.content : '')}
          </span>
          {isLong && <span className="text-[9px] text-[var(--text-secondary)] shrink-0">{expanded ? '▲' : '▼'}</span>}
        </button>
        {(expanded || !isLong) && isLong && (
          <pre className="px-3 py-2 text-[11px] text-[var(--text-secondary)] font-mono whitespace-pre-wrap break-words max-h-60 overflow-y-auto border-t border-[var(--border)]">
            {entry.content}
          </pre>
        )}
      </div>
    );
  }

  if (entry.type === 'tool_result') {
    const isLong = entry.content.length > 150;
    return (
      <div className="ml-4 border-l-2 border-[var(--accent)]/30 pl-3">
        <pre className={`text-[11px] text-[var(--text-secondary)] font-mono whitespace-pre-wrap break-words ${isLong && !expanded ? 'max-h-16 overflow-hidden' : 'max-h-80 overflow-y-auto'}`}>
          {entry.content}
        </pre>
        {isLong && !expanded && (
          <button onClick={onToggle} className="text-[9px] text-[var(--accent)] hover:underline mt-0.5">
            show more
          </button>
        )}
      </div>
    );
  }

  if (entry.type === 'system') {
    return (
      <div className="text-[10px] text-[var(--text-secondary)] py-0.5 flex items-center gap-1 opacity-50">
        <span>--</span> {entry.content}
      </div>
    );
  }

  return null;
}
