'use client';

import { useState, useEffect, useRef } from 'react';
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

export default function SessionView({
  projectName,
  projects,
}: {
  projectName?: string;
  projects: { name: string; path: string; language: string | null }[];
}) {
  const [selectedProject, setSelectedProject] = useState(projectName || '');
  const [sessions, setSessions] = useState<ClaudeSessionInfo[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [entries, setEntries] = useState<SessionEntry[]>([]);
  const [expandedTools, setExpandedTools] = useState<Set<number>>(new Set());
  const [messageText, setMessageText] = useState('');
  const [sending, setSending] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Fetch sessions when project changes
  useEffect(() => {
    if (!selectedProject) { setSessions([]); return; }
    fetch(`/api/claude-sessions/${encodeURIComponent(selectedProject)}`)
      .then(r => r.json())
      .then(setSessions)
      .catch(() => setSessions([]));
  }, [selectedProject]);

  // Auto-select first session
  useEffect(() => {
    if (sessions.length > 0 && !activeSessionId) {
      setActiveSessionId(sessions[0].sessionId);
    }
  }, [sessions, activeSessionId]);

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
        if (data.type === 'init') {
          setEntries(data.entries);
        } else if (data.type === 'update') {
          setEntries(prev => [...prev, ...data.entries]);
        }
      } catch {}
    };

    es.onerror = () => {
      es.close();
    };

    return () => es.close();
  }, [selectedProject, activeSessionId]);

  // Auto-scroll
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [entries]);

  const toggleTool = (i: number) => {
    setExpandedTools(prev => {
      const next = new Set(prev);
      next.has(i) ? next.delete(i) : next.add(i);
      return next;
    });
  };

  const activeSession = sessions.find(s => s.sessionId === activeSessionId);

  return (
    <div className="flex h-full">
      {/* Left: session list */}
      <div className="w-64 border-r border-[var(--border)] flex flex-col shrink-0">
        {/* Project selector */}
        <div className="p-2 border-b border-[var(--border)]">
          <select
            value={selectedProject}
            onChange={e => { setSelectedProject(e.target.value); setActiveSessionId(null); }}
            className="w-full px-2 py-1 bg-[var(--bg-tertiary)] border border-[var(--border)] rounded text-xs text-[var(--text-primary)] focus:outline-none"
          >
            <option value="">Select project...</option>
            {projects.map(p => (
              <option key={p.name} value={p.name}>{p.name}</option>
            ))}
          </select>
        </div>

        {/* Session list */}
        <div className="flex-1 overflow-y-auto">
          {sessions.length === 0 && selectedProject && (
            <p className="text-[10px] text-[var(--text-secondary)] p-3">No sessions found</p>
          )}
          {sessions.map(s => (
            <button
              key={s.sessionId}
              onClick={() => { setActiveSessionId(s.sessionId); setEntries([]); setExpandedTools(new Set()); }}
              className={`w-full text-left px-3 py-2 border-b border-[var(--border)] hover:bg-[var(--bg-tertiary)] transition-colors ${
                activeSessionId === s.sessionId ? 'bg-[var(--bg-tertiary)] border-l-2 border-l-[var(--accent)]' : ''
              }`}
            >
              <div className="text-[11px] text-[var(--text-primary)] truncate">
                {s.summary || s.firstPrompt || s.sessionId.slice(0, 8)}
              </div>
              <div className="flex items-center gap-2 mt-0.5">
                <span className="text-[9px] text-[var(--text-secondary)] font-mono">{s.sessionId.slice(0, 8)}</span>
                {s.gitBranch && <span className="text-[9px] text-[var(--accent)]">{s.gitBranch}</span>}
                {s.messageCount != null && <span className="text-[9px] text-[var(--text-secondary)]">{s.messageCount} msgs</span>}
              </div>
              {s.modified && (
                <div className="text-[9px] text-[var(--text-secondary)] mt-0.5">
                  {new Date(s.modified).toLocaleString()}
                </div>
              )}
            </button>
          ))}
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
            </div>
            {activeSession.summary && (
              <p className="text-xs text-[var(--text-secondary)] mt-0.5">{activeSession.summary}</p>
            )}
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-4 space-y-2">
          {!activeSessionId && (
            <div className="flex-1 flex items-center justify-center text-[var(--text-secondary)] h-full">
              <p>Select a project and session to view</p>
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

        {/* Message input */}
        {activeSessionId && selectedProject && (
          <div className="border-t border-[var(--border)] px-4 py-2 shrink-0">
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                if (!messageText.trim() || sending) return;
                setSending(true);
                try {
                  await fetch('/api/tasks', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      projectName: selectedProject,
                      prompt: messageText.trim(),
                      conversationId: activeSessionId,
                    }),
                  });
                  setMessageText('');
                } finally {
                  setSending(false);
                }
              }}
              className="flex gap-2"
            >
              <input
                type="text"
                value={messageText}
                onChange={e => setMessageText(e.target.value)}
                placeholder={`Send message to session ${activeSessionId?.slice(0, 8)}...`}
                className="flex-1 px-3 py-1.5 bg-[var(--bg-tertiary)] border border-[var(--border)] rounded text-xs text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)]"
              />
              <button
                type="submit"
                disabled={!messageText.trim() || sending}
                className="text-xs px-3 py-1.5 bg-[var(--accent)] text-white rounded hover:opacity-90 disabled:opacity-50"
              >
                {sending ? '...' : 'Send'}
              </button>
            </form>
            <p className="text-[9px] text-[var(--text-secondary)] mt-1">
              Creates a task with --resume to continue this session
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function SessionEntryView({
  entry,
  expanded,
  onToggle,
}: {
  entry: SessionEntry;
  expanded: boolean;
  onToggle: () => void;
}) {
  // User message
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

  // Assistant text
  if (entry.type === 'assistant_text') {
    return (
      <div className="py-1">
        <MarkdownContent content={entry.content} />
      </div>
    );
  }

  // Thinking
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

  // Tool use
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

  // Tool result
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

  // System
  if (entry.type === 'system') {
    return (
      <div className="text-[10px] text-[var(--text-secondary)] py-0.5 flex items-center gap-1 opacity-50">
        <span>--</span> {entry.content}
      </div>
    );
  }

  return null;
}
