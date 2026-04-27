'use client';

import { useState, useEffect, useRef, memo, useCallback, useMemo } from 'react';
import MarkdownContent from './MarkdownContent';
import NewTaskModal from './NewTaskModal';
import type { Task, TaskLogEntry } from '@/src/types';

// Bound the rendered log/diff to keep React from choking on huge sessions.
// Each LogEntry can include MarkdownContent — N entries means N markdown parses
// per render, so 5000+ entries used to freeze the tab on click.
const LOG_DEFAULT_TAIL = 300;
const LOG_LOAD_CHUNK = 500;
const DIFF_DEFAULT_LINES = 1000;

export default function TaskDetail({
  task,
  onRefresh,
  onFollowUp,
}: {
  task: Task;
  onRefresh: () => void;
  onFollowUp?: (data: { projectName: string; prompt: string; conversationId: string }) => void;
}) {
  const [liveLog, setLiveLog] = useState<TaskLogEntry[]>(task.log);
  const [liveStatus, setLiveStatus] = useState(task.status);
  const [fullTask, setFullTask] = useState<Task | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [tab, setTab] = useState<'log' | 'diff' | 'result'>('log');
  const [expandedTools, setExpandedTools] = useState<Set<number>>(new Set());
  const [followUpText, setFollowUpText] = useState('');
  const [editing, setEditing] = useState(false);
  const [visibleTail, setVisibleTail] = useState(LOG_DEFAULT_TAIL);
  const [showFullDiff, setShowFullDiff] = useState(false);
  const logEndRef = useRef<HTMLDivElement>(null);
  const logScrollRef = useRef<HTMLDivElement>(null);

  // Lazy-fetch the full task body — the task list now ships only metadata
  // (no log / git_diff / full result_summary) to keep the list response small.
  useEffect(() => {
    let cancelled = false;
    if (task.status === 'running' || task.status === 'queued') return;  // SSE will populate
    if (task.log && task.log.length > 0) return;                         // already have it
    setDetailLoading(true);
    fetch(`/api/tasks/${task.id}`)
      .then(r => r.ok ? r.json() : null)
      .then((full: Task | null) => {
        if (cancelled || !full) return;
        setFullTask(full);
        setLiveLog(full.log || []);
      })
      .finally(() => { if (!cancelled) setDetailLoading(false); });
    return () => { cancelled = true; };
  }, [task.id, task.status, task.log]);

  // SSE stream for running tasks
  useEffect(() => {
    if (task.status !== 'running' && task.status !== 'queued') {
      setLiveLog(task.log);
      setLiveStatus(task.status);
      return;
    }

    setLiveLog([]);
    const es = new EventSource(`/api/tasks/${task.id}/stream`);

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'log') {
          setLiveLog(prev => [...prev, data.entry]);
        } else if (data.type === 'status') {
          setLiveStatus(data.status);
          if (data.status === 'done' || data.status === 'failed' || data.status === 'cancelled') {
            onRefresh();
          }
        } else if (data.type === 'complete' && data.task) {
          setLiveLog(data.task.log);
          setLiveStatus(data.task.status);
        }
      } catch {}
    };

    es.onerror = () => {
      es.close();
      onRefresh();
    };

    return () => es.close();
  }, [task.id, task.status, onRefresh]);

  // Auto-scroll only when the user is already near the bottom — otherwise we yank
  // them away from a line they're trying to read.
  useEffect(() => {
    const el = logScrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 200;
    if (nearBottom) logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [liveLog.length]);

  const toggleTool = useCallback((i: number) => {
    setExpandedTools(prev => {
      const next = new Set(prev);
      next.has(i) ? next.delete(i) : next.add(i);
      return next;
    });
  }, []);

  const handleAction = async (action: string) => {
    await fetch(`/api/tasks/${task.id}`, {
      method: action === 'delete' ? 'DELETE' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: action !== 'delete' ? JSON.stringify({ action }) : undefined,
    });
    onRefresh();
  };

  const displayLog = liveLog.length > 0 ? liveLog : task.log;
  const totalLogCount = displayLog.length;
  const tailStart = Math.max(0, totalLogCount - visibleTail);
  const visibleLog = useMemo(() => displayLog.slice(tailStart), [displayLog, tailStart]);
  const hiddenCount = tailStart;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="border-b border-[var(--border)] px-4 py-2 shrink-0">
        <div className="flex items-center justify-between mb-1">
          <div className="flex items-center gap-2">
            <StatusBadge status={liveStatus} />
            <span className="text-sm font-semibold">{task.projectName}</span>
            <span className="text-[10px] text-[var(--text-secondary)] font-mono">{task.id}</span>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => setEditing(true)} className="text-[10px] px-2 py-0.5 text-[var(--accent)] border border-[var(--accent)]/30 rounded hover:bg-[var(--accent)] hover:text-white">
              Edit
            </button>
            {(liveStatus === 'running' || liveStatus === 'queued') && (
              <button onClick={() => handleAction('cancel')} className="text-[10px] px-2 py-0.5 text-[var(--red)] border border-[var(--red)]/30 rounded hover:bg-[var(--red)] hover:text-white">
                Cancel
              </button>
            )}
            {(liveStatus === 'failed' || liveStatus === 'cancelled') && (
              <button onClick={() => handleAction('retry')} className="text-[10px] px-2 py-0.5 text-[var(--accent)] border border-[var(--accent)]/30 rounded hover:bg-[var(--accent)] hover:text-white">
                Retry
              </button>
            )}
            <button onClick={() => handleAction('delete')} className="text-[10px] px-2 py-0.5 text-[var(--text-secondary)] hover:text-[var(--red)]">
              Delete
            </button>
          </div>
        </div>
        <p className="text-xs text-[var(--text-secondary)] mb-2">{task.prompt}</p>
        <div className="flex items-center gap-3 text-[10px] text-[var(--text-secondary)]">
          <span>Created: {new Date(task.createdAt).toLocaleString()}</span>
          {task.startedAt && <span>Started: {new Date(task.startedAt).toLocaleString()}</span>}
          {task.completedAt && <span>Completed: {new Date(task.completedAt).toLocaleString()}</span>}
          {task.costUSD != null && <span>Cost: ${task.costUSD.toFixed(4)}</span>}
        </div>
      </div>

      {/* Tabs */}
      <div className="border-b border-[var(--border)] px-4 flex gap-0.5 shrink-0">
        {(['log', 'result', 'diff'] as const).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`text-[11px] px-3 py-1.5 border-b-2 transition-colors ${
              tab === t ? 'border-[var(--accent)] text-[var(--accent)]' : 'border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
            }`}
          >
            {t === 'log' ? `Log (${displayLog.length})` : t === 'diff' ? 'Git Diff' : 'Result'}
          </button>
        ))}
      </div>

      {/* Content */}
      <div ref={logScrollRef} className="flex-1 overflow-y-auto p-4 text-sm">
        {tab === 'log' && (
          <div className="space-y-2">
            {detailLoading && displayLog.length === 0 && (
              <div className="text-[var(--text-secondary)] text-xs py-2">
                Loading log{task.logSize ? ` (${(task.logSize / 1024).toFixed(0)} KB)` : ''}…
              </div>
            )}
            {hiddenCount > 0 && (
              <div className="flex items-center justify-between gap-2 py-1.5 px-2 text-[10px] text-[var(--text-secondary)] bg-[var(--bg-tertiary)] rounded border border-[var(--border)]">
                <span>{hiddenCount} earlier {hiddenCount === 1 ? 'entry' : 'entries'} hidden</span>
                <div className="flex gap-1">
                  <button
                    onClick={() => setVisibleTail(v => v + LOG_LOAD_CHUNK)}
                    className="px-2 py-0.5 rounded bg-[var(--accent)]/15 text-[var(--accent)] hover:bg-[var(--accent)]/25"
                  >Load {Math.min(LOG_LOAD_CHUNK, hiddenCount)} more</button>
                  <button
                    onClick={() => setVisibleTail(totalLogCount)}
                    className="px-2 py-0.5 rounded text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-secondary)]"
                  >Show all ({totalLogCount})</button>
                </div>
              </div>
            )}
            {visibleLog.map((entry, i) => {
              const absoluteIndex = tailStart + i;
              return (
                <LogEntry
                  key={absoluteIndex}
                  entry={entry}
                  index={absoluteIndex}
                  expanded={expandedTools.has(absoluteIndex)}
                  onToggle={toggleTool}
                />
              );
            })}
            {liveStatus === 'running' && (
              <div className="text-[var(--accent)] animate-pulse py-1 text-xs">working...</div>
            )}
            <div ref={logEndRef} />
          </div>
        )}

        {tab === 'result' && (
          <div className="prose-container">
            {(fullTask?.resultSummary ?? task.resultSummary) ? (
              <MarkdownContent content={(fullTask?.resultSummary ?? task.resultSummary)!} />
            ) : task.error ? (
              <div className="p-3 bg-red-900/10 border border-red-800/20 rounded">
                <pre className="whitespace-pre-wrap break-words text-[var(--red)] text-xs font-mono">{task.error}</pre>
              </div>
            ) : (
              <p className="text-[var(--text-secondary)] text-xs">
                {liveStatus === 'running' || liveStatus === 'queued' ? 'Task is still running...' : detailLoading ? 'Loading…' : 'No result'}
              </p>
            )}
          </div>
        )}

        {tab === 'diff' && (
          <DiffView gitDiff={fullTask?.gitDiff ?? task.gitDiff} status={liveStatus} showAll={showFullDiff} onShowAll={() => setShowFullDiff(true)} />
        )}
      </div>

      {/* Follow-up input for completed tasks */}
      {liveStatus === 'done' && task.conversationId && onFollowUp && (
        <div className="border-t border-[var(--border)] px-4 py-2 shrink-0">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!followUpText.trim()) return;
              onFollowUp({
                projectName: task.projectName,
                prompt: followUpText.trim(),
                conversationId: task.conversationId!,
              });
              setFollowUpText('');
            }}
            className="flex gap-2"
          >
            <input
              type="text"
              value={followUpText}
              onChange={e => setFollowUpText(e.target.value)}
              placeholder="Send follow-up message (continues this session)..."
              className="flex-1 px-3 py-1.5 bg-[var(--bg-tertiary)] border border-[var(--border)] rounded text-xs text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)]"
            />
            <button
              type="submit"
              disabled={!followUpText.trim()}
              className="text-xs px-3 py-1.5 bg-[var(--accent)] text-white rounded hover:opacity-90 disabled:opacity-50"
            >
              Send
            </button>
          </form>
          <p className="text-[9px] text-[var(--text-secondary)] mt-1">
            Session <span className="font-mono">{task.conversationId.slice(0, 12)}...</span> — creates a new task continuing this conversation
          </p>
        </div>
      )}

      {editing && (
        <NewTaskModal
          editTask={{ id: task.id, projectName: task.projectName, prompt: task.prompt, priority: task.priority, mode: task.mode, scheduledAt: task.scheduledAt }}
          onClose={() => setEditing(false)}
          onCreate={async (data) => {
            await fetch(`/api/tasks/${task.id}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ ...data, restart: true }),
            });
            setEditing(false);
            onRefresh();
          }}
        />
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    queued: 'bg-yellow-500/20 text-yellow-500',
    running: 'bg-green-500/20 text-[var(--green)]',
    done: 'bg-blue-500/20 text-blue-400',
    failed: 'bg-red-500/20 text-[var(--red)]',
    cancelled: 'bg-gray-500/20 text-[var(--text-secondary)]',
  };
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${colors[status] || ''}`}>
      {status}
    </span>
  );
}

const LogEntry = memo(function LogEntry({ entry, index, expanded, onToggle }: {
  entry: TaskLogEntry;
  index: number;
  expanded: boolean;
  onToggle: (index: number) => void;
}) {
  const handleToggle = () => onToggle(index);
  // System init
  if (entry.type === 'system' && entry.subtype === 'init') {
    return (
      <div className="text-[10px] text-[var(--text-secondary)] py-0.5 flex items-center gap-1">
        <span className="opacity-50">⚙</span> {entry.content}
      </div>
    );
  }

  // Error
  if (entry.subtype === 'error') {
    return (
      <div className="p-2 bg-red-900/10 border border-red-800/20 rounded text-xs">
        <pre className="whitespace-pre-wrap break-words text-[var(--red)] font-mono">{entry.content}</pre>
      </div>
    );
  }

  // Tool use — collapsible
  if (entry.subtype === 'tool_use') {
    const toolContent = formatToolContent(entry.content);
    const isLong = toolContent.length > 80;

    return (
      <div className="border border-[var(--border)] rounded overflow-hidden">
        <button
          onClick={handleToggle}
          className="w-full flex items-center gap-2 px-2 py-1.5 bg-[var(--bg-tertiary)] hover:bg-[var(--border)]/30 transition-colors text-left"
        >
          <span className="text-[10px] px-1.5 py-0.5 bg-[var(--accent)]/15 text-[var(--accent)] rounded font-medium font-mono">
            {entry.tool || 'tool'}
          </span>
          <span className="text-[11px] text-[var(--text-secondary)] truncate flex-1 font-mono">
            {isLong && !expanded ? toolContent.slice(0, 80) + '...' : (!isLong ? toolContent : '')}
          </span>
          {isLong && (
            <span className="text-[9px] text-[var(--text-secondary)] shrink-0">{expanded ? '▲' : '▼'}</span>
          )}
        </button>
        {(expanded || !isLong) && isLong && (
          <pre className="px-3 py-2 text-[11px] text-[var(--text-secondary)] font-mono whitespace-pre-wrap break-words max-h-60 overflow-y-auto border-t border-[var(--border)]">
            {toolContent}
          </pre>
        )}
      </div>
    );
  }

  // Tool result — collapsible with border accent
  if (entry.subtype === 'tool_result') {
    const content = formatToolContent(entry.content);
    const isLong = content.length > 150;

    return (
      <div className="ml-4 border-l-2 border-[var(--accent)]/30 pl-3">
        <pre className={`text-[11px] text-[var(--text-secondary)] font-mono whitespace-pre-wrap break-words ${isLong && !expanded ? 'max-h-16 overflow-hidden' : 'max-h-80 overflow-y-auto'}`}>
          {content}
        </pre>
        {isLong && !expanded && (
          <button onClick={handleToggle} className="text-[9px] text-[var(--accent)] hover:underline mt-0.5">
            show more
          </button>
        )}
      </div>
    );
  }

  // Final result
  if (entry.type === 'result') {
    return (
      <div className="p-3 bg-green-900/5 border border-green-800/15 rounded">
        <MarkdownContent content={entry.content} />
      </div>
    );
  }

  // Assistant text — render as markdown
  return (
    <div className="py-1">
      <MarkdownContent content={entry.content} />
    </div>
  );
});

// Diff view — caps at DIFF_DEFAULT_LINES until "Show all" clicked.
function DiffView({ gitDiff, status, showAll, onShowAll }: {
  gitDiff?: string;
  status: string;
  showAll: boolean;
  onShowAll: () => void;
}) {
  const allLines = useMemo(() => (gitDiff ? gitDiff.split('\n') : []), [gitDiff]);
  if (!gitDiff) {
    return (
      <p className="text-[var(--text-secondary)] text-xs">
        {status === 'running' ? 'Diff will be captured after completion' : 'No changes detected'}
      </p>
    );
  }
  const lines = showAll ? allLines : allLines.slice(0, DIFF_DEFAULT_LINES);
  const truncated = !showAll && allLines.length > DIFF_DEFAULT_LINES;

  return (
    <div className="bg-[var(--bg-tertiary)] rounded border border-[var(--border)] overflow-hidden">
      {truncated && (
        <div className="flex items-center justify-between gap-2 py-1.5 px-3 text-[10px] text-[var(--text-secondary)] border-b border-[var(--border)] bg-[var(--bg-secondary)]">
          <span>Showing first {DIFF_DEFAULT_LINES} of {allLines.length} lines</span>
          <button onClick={onShowAll} className="px-2 py-0.5 rounded bg-[var(--accent)]/15 text-[var(--accent)] hover:bg-[var(--accent)]/25">
            Show all
          </button>
        </div>
      )}
      <pre className="p-3 text-xs font-mono overflow-x-auto">
        {lines.map((line, i) => (
          <div key={i} className={`px-2 ${
            line.startsWith('+++') || line.startsWith('---') ? 'text-[var(--text-secondary)] font-semibold' :
            line.startsWith('+') ? 'text-[var(--green)] bg-green-500/5' :
            line.startsWith('-') ? 'text-[var(--red)] bg-red-500/5' :
            line.startsWith('@@') ? 'text-[var(--accent)] bg-[var(--accent)]/5 font-semibold' :
            line.startsWith('diff ') ? 'text-[var(--text-primary)] font-bold border-t border-[var(--border)] pt-2 mt-2' :
            'text-[var(--text-secondary)]'
          }`}>
            {line}
          </div>
        ))}
      </pre>
    </div>
  );
}

function formatToolContent(content: string): string {
  try {
    const parsed = JSON.parse(content);
    if (typeof parsed === 'object') {
      // For common tool patterns, show a cleaner format
      if (parsed.command) return `$ ${parsed.command}`;
      if (parsed.file_path) return parsed.file_path;
      if (parsed.pattern) return `/${parsed.pattern}/`;
      return JSON.stringify(parsed, null, 2);
    }
    return content;
  } catch {
    return content;
  }
}
