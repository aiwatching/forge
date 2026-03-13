'use client';

import { useState, useEffect } from 'react';

interface Project {
  name: string;
  path: string;
  language: string | null;
}

interface SessionInfo {
  sessionId: string;
  summary?: string;
  firstPrompt?: string;
  modified?: string;
  gitBranch?: string;
}

export default function NewTaskModal({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (data: {
    projectName: string;
    prompt: string;
    priority?: number;
    conversationId?: string;
    newSession?: boolean;
    scheduledAt?: string;
  }) => void;
}) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProject, setSelectedProject] = useState('');
  const [prompt, setPrompt] = useState('');
  const [priority, setPriority] = useState(0);

  // Session selection
  const [sessionMode, setSessionMode] = useState<'auto' | 'select' | 'new'>('auto');
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [autoSessionId, setAutoSessionId] = useState<string | null>(null);

  // Scheduling
  const [scheduleMode, setScheduleMode] = useState<'now' | 'delay' | 'time'>('now');
  const [delayMinutes, setDelayMinutes] = useState(30);
  const [scheduledTime, setScheduledTime] = useState('');

  useEffect(() => {
    fetch('/api/projects').then(r => r.json()).then((p: Project[]) => {
      setProjects(p);
      if (p.length > 0) setSelectedProject(p[0].name);
    });
  }, []);

  // Fetch sessions when project changes
  useEffect(() => {
    if (!selectedProject) return;

    // Get auto-inherited session
    fetch(`/api/tasks/session?project=${encodeURIComponent(selectedProject)}`)
      .then(r => r.json())
      .then(data => setAutoSessionId(data.conversationId || null))
      .catch(() => setAutoSessionId(null));

    // Get all sessions for picker
    fetch(`/api/claude-sessions/${encodeURIComponent(selectedProject)}`)
      .then(r => r.json())
      .then((s: SessionInfo[]) => setSessions(s))
      .catch(() => setSessions([]));
  }, [selectedProject]);

  const getScheduledAt = (): string | undefined => {
    if (scheduleMode === 'now') return undefined;
    if (scheduleMode === 'delay') {
      return new Date(Date.now() + delayMinutes * 60_000).toISOString();
    }
    if (scheduleMode === 'time' && scheduledTime) {
      return new Date(scheduledTime).toISOString();
    }
    return undefined;
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedProject || !prompt.trim()) return;

    const data: Parameters<typeof onCreate>[0] = {
      projectName: selectedProject,
      prompt: prompt.trim(),
      priority,
      scheduledAt: getScheduledAt(),
    };

    if (sessionMode === 'new') {
      data.newSession = true;
    } else if (sessionMode === 'select' && selectedSessionId) {
      data.conversationId = selectedSessionId;
    }
    // 'auto' → don't set conversationId, let backend auto-inherit

    onCreate(data);
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg w-[560px] max-h-[80vh] overflow-auto" onClick={e => e.stopPropagation()}>
        <div className="p-4 border-b border-[var(--border)]">
          <h2 className="text-sm font-semibold">New Task</h2>
          <p className="text-[11px] text-[var(--text-secondary)] mt-0.5">
            Submit a task for Claude Code to work on autonomously
          </p>
        </div>

        <form onSubmit={handleSubmit} className="p-4 space-y-4">
          {/* Project */}
          <div>
            <label className="text-[11px] text-[var(--text-secondary)] block mb-1">Project</label>
            <select
              value={selectedProject}
              onChange={e => { setSelectedProject(e.target.value); setSelectedSessionId(null); }}
              className="w-full px-3 py-2 bg-[var(--bg-tertiary)] border border-[var(--border)] rounded text-xs text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)]"
            >
              {projects.map(p => (
                <option key={p.name} value={p.name}>
                  {p.name} {p.language ? `(${p.language})` : ''}
                </option>
              ))}
            </select>
          </div>

          {/* Session */}
          <div>
            <label className="text-[11px] text-[var(--text-secondary)] block mb-1">Session</label>
            <div className="flex gap-2">
              {(['auto', 'select', 'new'] as const).map(mode => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setSessionMode(mode)}
                  className={`text-[11px] px-3 py-1 rounded border transition-colors ${
                    sessionMode === mode
                      ? 'border-[var(--accent)] text-[var(--accent)] bg-[var(--accent)]/10'
                      : 'border-[var(--border)] text-[var(--text-secondary)] hover:border-[var(--text-secondary)]'
                  }`}
                >
                  {mode === 'auto' ? 'Auto Continue' : mode === 'select' ? 'Choose Session' : 'New Session'}
                </button>
              ))}
            </div>

            {sessionMode === 'auto' && (
              <p className="text-[10px] text-[var(--text-secondary)] mt-1">
                {autoSessionId
                  ? <>Will continue <span className="font-mono text-[var(--accent)]">{autoSessionId.slice(0, 12)}</span></>
                  : 'No existing session — will start new'}
              </p>
            )}

            {sessionMode === 'select' && (
              <div className="mt-2 max-h-32 overflow-y-auto border border-[var(--border)] rounded">
                {sessions.length === 0 ? (
                  <p className="text-[10px] text-[var(--text-secondary)] p-2">No sessions found</p>
                ) : sessions.map(s => (
                  <button
                    key={s.sessionId}
                    type="button"
                    onClick={() => setSelectedSessionId(s.sessionId)}
                    className={`w-full text-left px-2 py-1.5 text-[10px] hover:bg-[var(--bg-tertiary)] transition-colors ${
                      selectedSessionId === s.sessionId ? 'bg-[var(--accent)]/10 border-l-2 border-l-[var(--accent)]' : ''
                    }`}
                  >
                    <div className="text-[var(--text-primary)] truncate">
                      {s.summary || s.firstPrompt?.slice(0, 50) || s.sessionId.slice(0, 8)}
                    </div>
                    <div className="flex gap-2 mt-0.5">
                      <span className="font-mono text-[var(--text-secondary)]">{s.sessionId.slice(0, 8)}</span>
                      {s.gitBranch && <span className="text-[var(--accent)]">{s.gitBranch}</span>}
                      {s.modified && <span className="text-[var(--text-secondary)]">{new Date(s.modified).toLocaleDateString()}</span>}
                    </div>
                  </button>
                ))}
              </div>
            )}

            {sessionMode === 'new' && (
              <p className="text-[10px] text-[var(--text-secondary)] mt-1">
                Will start a fresh session with no prior context
              </p>
            )}
          </div>

          {/* Task prompt */}
          <div>
            <label className="text-[11px] text-[var(--text-secondary)] block mb-1">What should Claude do?</label>
            <textarea
              value={prompt}
              onChange={e => setPrompt(e.target.value)}
              placeholder="e.g. Refactor the authentication module to use JWT tokens..."
              rows={5}
              className="w-full px-3 py-2 bg-[var(--bg-tertiary)] border border-[var(--border)] rounded text-xs text-[var(--text-primary)] resize-none focus:outline-none focus:border-[var(--accent)]"
              autoFocus
            />
          </div>

          {/* Schedule */}
          <div>
            <label className="text-[11px] text-[var(--text-secondary)] block mb-1">When</label>
            <div className="flex gap-2">
              {(['now', 'delay', 'time'] as const).map(mode => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setScheduleMode(mode)}
                  className={`text-[11px] px-3 py-1 rounded border transition-colors ${
                    scheduleMode === mode
                      ? 'border-[var(--accent)] text-[var(--accent)] bg-[var(--accent)]/10'
                      : 'border-[var(--border)] text-[var(--text-secondary)] hover:border-[var(--text-secondary)]'
                  }`}
                >
                  {mode === 'now' ? 'Now' : mode === 'delay' ? 'Delay' : 'Schedule'}
                </button>
              ))}
            </div>

            {scheduleMode === 'delay' && (
              <div className="flex items-center gap-2 mt-2">
                <span className="text-[10px] text-[var(--text-secondary)]">Run in</span>
                <input
                  type="number"
                  value={delayMinutes}
                  onChange={e => setDelayMinutes(Number(e.target.value))}
                  min={1}
                  className="w-20 px-2 py-1 bg-[var(--bg-tertiary)] border border-[var(--border)] rounded text-xs text-[var(--text-primary)] focus:outline-none"
                />
                <span className="text-[10px] text-[var(--text-secondary)]">minutes</span>
              </div>
            )}

            {scheduleMode === 'time' && (
              <div className="mt-2">
                <input
                  type="datetime-local"
                  value={scheduledTime}
                  onChange={e => setScheduledTime(e.target.value)}
                  className="px-2 py-1 bg-[var(--bg-tertiary)] border border-[var(--border)] rounded text-xs text-[var(--text-primary)] focus:outline-none"
                />
              </div>
            )}
          </div>

          {/* Priority */}
          <div>
            <label className="text-[11px] text-[var(--text-secondary)] block mb-1">Priority</label>
            <div className="flex gap-2">
              {[
                { value: 0, label: 'Normal' },
                { value: 1, label: 'High' },
                { value: 2, label: 'Urgent' },
              ].map(p => (
                <button
                  key={p.value}
                  type="button"
                  onClick={() => setPriority(p.value)}
                  className={`text-[11px] px-3 py-1 rounded border transition-colors ${
                    priority === p.value
                      ? 'border-[var(--accent)] text-[var(--accent)] bg-[var(--accent)]/10'
                      : 'border-[var(--border)] text-[var(--text-secondary)] hover:border-[var(--text-secondary)]'
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          {/* Actions */}
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} className="text-xs px-3 py-1.5 text-[var(--text-secondary)] hover:text-[var(--text-primary)]">
              Cancel
            </button>
            <button
              type="submit"
              disabled={!selectedProject || !prompt.trim()}
              className="text-xs px-4 py-1.5 bg-[var(--accent)] text-white rounded hover:opacity-90 disabled:opacity-50"
            >
              {scheduleMode === 'now' ? 'Submit Task' : 'Schedule Task'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
