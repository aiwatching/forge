'use client';

import { useState } from 'react';
import type { Task, TaskStatus } from '@/src/types';

const STATUS_COLORS: Record<TaskStatus, string> = {
  queued: 'text-yellow-500',
  running: 'text-[var(--green)]',
  done: 'text-blue-400',
  failed: 'text-[var(--red)]',
  cancelled: 'text-[var(--text-secondary)]',
};

const STATUS_LABELS: Record<TaskStatus, string> = {
  queued: 'queued',
  running: 'running',
  done: 'done',
  failed: 'failed',
  cancelled: 'cancelled',
};

export default function TaskBoard({
  tasks,
  activeId,
  onSelect,
  onRefresh,
}: {
  tasks: Task[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onRefresh: () => void;
}) {
  const [filter, setFilter] = useState<TaskStatus | 'all'>('all');

  const filtered = filter === 'all' ? tasks : tasks.filter(t => t.status === filter);

  return (
    <div className="flex flex-col h-full">
      {/* Filter tabs */}
      <div className="p-2 border-b border-[var(--border)] flex gap-1 flex-wrap">
        {(['all', 'running', 'queued', 'done', 'failed'] as const).map(f => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`text-[10px] px-2 py-0.5 rounded transition-colors ${
              filter === f ? 'bg-[var(--accent)] text-white' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]'
            }`}
          >
            {f} {f !== 'all' ? `(${tasks.filter(t => t.status === f).length})` : `(${tasks.length})`}
          </button>
        ))}
      </div>

      {/* Task list */}
      <div className="flex-1 overflow-y-auto">
        {filtered.map(task => (
          <button
            key={task.id}
            onClick={() => onSelect(task.id)}
            className={`w-full text-left px-3 py-2 border-b border-[var(--border)] hover:bg-[var(--bg-tertiary)] transition-colors ${
              activeId === task.id ? 'bg-[var(--bg-tertiary)]' : ''
            }`}
          >
            <div className="flex items-center gap-2 mb-0.5">
              <span className={`text-[10px] ${STATUS_COLORS[task.status]}`}>●</span>
              <span className="text-xs font-medium truncate">{task.projectName}</span>
              <span className={`text-[9px] ml-auto ${STATUS_COLORS[task.status]}`}>
                {task.scheduledAt && task.status === 'queued'
                  ? `⏰ ${new Date(task.scheduledAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`
                  : STATUS_LABELS[task.status]}
              </span>
            </div>
            <p className="text-[11px] text-[var(--text-secondary)] truncate pl-4">
              {task.prompt.slice(0, 80)}{task.prompt.length > 80 ? '...' : ''}
            </p>
            <div className="flex items-center gap-2 pl-4 mt-0.5">
              <span className="text-[9px] text-[var(--text-secondary)]">
                {timeAgo(task.createdAt)}
              </span>
              {task.costUSD != null && (
                <span className="text-[9px] text-[var(--text-secondary)]">
                  ${task.costUSD.toFixed(3)}
                </span>
              )}
            </div>
          </button>
        ))}
        {filtered.length === 0 && (
          <div className="p-4 text-center text-xs text-[var(--text-secondary)]">
            No tasks
          </div>
        )}
      </div>

      <div className="p-2 border-t border-[var(--border)] text-[10px] text-[var(--text-secondary)] text-center">
        {tasks.length} tasks total
      </div>
    </div>
  );
}

function timeAgo(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diff = now - then;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}
