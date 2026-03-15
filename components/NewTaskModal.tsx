'use client';

import { useState, useEffect } from 'react';
import type { TaskMode, WatchConfig } from '@/src/types';

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

interface TaskData {
  projectName: string;
  prompt: string;
  priority?: number;
  conversationId?: string;
  newSession?: boolean;
  scheduledAt?: string;
  mode?: TaskMode;
  watchConfig?: WatchConfig;
}

export default function NewTaskModal({
  onClose,
  onCreate,
  editTask,
}: {
  onClose: () => void;
  onCreate: (data: TaskData) => void;
  editTask?: { id: string; projectName: string; prompt: string; priority: number; mode: TaskMode; scheduledAt?: string };
}) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProject, setSelectedProject] = useState(editTask?.projectName || '');
  const [prompt, setPrompt] = useState(editTask?.prompt || '');
  const [priority, setPriority] = useState(editTask?.priority || 0);

  // Task mode
  const [taskMode, setTaskMode] = useState<TaskMode>(editTask?.mode || 'prompt');

  // Monitor config
  const [watchCondition, setWatchCondition] = useState<WatchConfig['condition']>('change');
  const [watchKeyword, setWatchKeyword] = useState('');
  const [watchIdleMinutes, setWatchIdleMinutes] = useState(10);
  const [watchAction, setWatchAction] = useState<WatchConfig['action']>('notify');
  const [watchActionPrompt, setWatchActionPrompt] = useState('');
  const [watchRepeat, setWatchRepeat] = useState(false);

  // Session selection
  const [sessionMode, setSessionMode] = useState<'auto' | 'select' | 'new'>('auto');
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [autoSessionId, setAutoSessionId] = useState<string | null>(null);

  // Scheduling
  const [scheduleMode, setScheduleMode] = useState<'now' | 'delay' | 'time'>(editTask?.scheduledAt ? 'time' : 'now');
  const [delayMinutes, setDelayMinutes] = useState(30);
  const [scheduledTime, setScheduledTime] = useState(editTask?.scheduledAt ? new Date(editTask.scheduledAt).toISOString().slice(0, 16) : '');

  useEffect(() => {
    fetch('/api/projects').then(r => r.json()).then((p: Project[]) => {
      setProjects(p);
      if (!selectedProject && p.length > 0) setSelectedProject(p[0].name);
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

  const getScheduledAt = (): string | null | undefined => {
    if (scheduleMode === 'now') return editTask ? null : undefined;  // null clears existing schedule
    if (scheduleMode === 'delay') {
      return new Date(Date.now() + delayMinutes * 60_000).toISOString();
    }
    if (scheduleMode === 'time' && scheduledTime) {
      return new Date(scheduledTime).toISOString();
    }
    return editTask ? null : undefined;
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedProject) return;
    // Monitor mode requires session selection; prompt mode requires prompt text
    if (taskMode === 'prompt' && !prompt.trim()) return;
    if (taskMode === 'monitor' && sessionMode !== 'select') return;

    const data: Parameters<typeof onCreate>[0] = {
      projectName: selectedProject,
      prompt: taskMode === 'monitor' ? `Monitor session ${selectedSessionId}` : prompt.trim(),
      priority,
      scheduledAt: getScheduledAt(),
      mode: taskMode,
    };

    if (sessionMode === 'new') {
      data.newSession = true;
    } else if (sessionMode === 'select' && selectedSessionId) {
      data.conversationId = selectedSessionId;
    }

    if (taskMode === 'monitor') {
      const wc: WatchConfig = {
        condition: watchCondition,
        action: watchAction,
        repeat: watchRepeat,
      };
      if (watchCondition === 'keyword') wc.keyword = watchKeyword;
      if (watchCondition === 'idle') wc.idleMinutes = watchIdleMinutes;
      if (watchAction !== 'notify') wc.actionPrompt = watchActionPrompt;
      data.watchConfig = wc;
    }

    onCreate(data);
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg w-[560px] max-h-[80vh] overflow-auto" onClick={e => e.stopPropagation()}>
        <div className="p-4 border-b border-[var(--border)]">
          <h2 className="text-sm font-semibold">{editTask ? 'Edit Task' : 'New Task'}</h2>
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

          {/* Task Mode */}
          <div>
            <label className="text-[11px] text-[var(--text-secondary)] block mb-1">Mode</label>
            <div className="flex gap-2">
              {([
                { value: 'prompt' as const, label: 'Prompt', desc: 'Send a message to Claude' },
                { value: 'monitor' as const, label: 'Monitor', desc: 'Watch a session, trigger actions' },
              ]).map(m => (
                <button
                  key={m.value}
                  type="button"
                  onClick={() => {
                    setTaskMode(m.value);
                    if (m.value === 'monitor') setSessionMode('select');
                  }}
                  className={`text-[11px] px-3 py-1 rounded border transition-colors ${
                    taskMode === m.value
                      ? 'border-[var(--accent)] text-[var(--accent)] bg-[var(--accent)]/10'
                      : 'border-[var(--border)] text-[var(--text-secondary)] hover:border-[var(--text-secondary)]'
                  }`}
                >
                  {m.label}
                </button>
              ))}
            </div>
            <p className="text-[10px] text-[var(--text-secondary)] mt-1">
              {taskMode === 'prompt' ? 'Send a message to Claude to work on autonomously' : 'Watch a session and trigger actions on conditions'}
            </p>
          </div>

          {/* Session */}
          <div>
            <label className="text-[11px] text-[var(--text-secondary)] block mb-1">Session</label>
            {taskMode === 'prompt' && (
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
            )}
            {taskMode === 'monitor' && (
              <p className="text-[10px] text-[var(--text-secondary)]">Select a session to monitor</p>
            )}

            {sessionMode === 'auto' && taskMode === 'prompt' && (
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

          {/* Monitor Config — only in monitor mode */}
          {taskMode === 'monitor' && (
            <div className="space-y-3 p-3 bg-[var(--bg-tertiary)] rounded border border-[var(--border)]">
              <div>
                <label className="text-[11px] text-[var(--text-secondary)] block mb-1">Trigger when</label>
                <div className="flex gap-1 flex-wrap">
                  {([
                    { value: 'change' as const, label: 'Content changes' },
                    { value: 'idle' as const, label: 'Session idle' },
                    { value: 'complete' as const, label: 'Session completes' },
                    { value: 'error' as const, label: 'Error occurs' },
                    { value: 'keyword' as const, label: 'Keyword found' },
                  ]).map(c => (
                    <button
                      key={c.value}
                      type="button"
                      onClick={() => setWatchCondition(c.value)}
                      className={`text-[10px] px-2 py-0.5 rounded border transition-colors ${
                        watchCondition === c.value
                          ? 'border-[var(--accent)] text-[var(--accent)] bg-[var(--accent)]/10'
                          : 'border-[var(--border)] text-[var(--text-secondary)] hover:border-[var(--text-secondary)]'
                      }`}
                    >
                      {c.label}
                    </button>
                  ))}
                </div>
                {watchCondition === 'keyword' && (
                  <input
                    type="text"
                    value={watchKeyword}
                    onChange={e => setWatchKeyword(e.target.value)}
                    placeholder="Enter keyword to watch for..."
                    className="mt-2 w-full px-2 py-1 bg-[var(--bg-secondary)] border border-[var(--border)] rounded text-xs text-[var(--text-primary)] focus:outline-none"
                  />
                )}
                {watchCondition === 'idle' && (
                  <div className="flex items-center gap-2 mt-2">
                    <span className="text-[10px] text-[var(--text-secondary)]">Idle for</span>
                    <input
                      type="number"
                      value={watchIdleMinutes}
                      onChange={e => setWatchIdleMinutes(Number(e.target.value))}
                      min={1}
                      className="w-16 px-2 py-1 bg-[var(--bg-secondary)] border border-[var(--border)] rounded text-xs text-[var(--text-primary)] focus:outline-none"
                    />
                    <span className="text-[10px] text-[var(--text-secondary)]">minutes</span>
                  </div>
                )}
              </div>

              <div>
                <label className="text-[11px] text-[var(--text-secondary)] block mb-1">Then</label>
                <div className="flex gap-1 flex-wrap">
                  {([
                    { value: 'notify' as const, label: 'Send Telegram notification' },
                    { value: 'message' as const, label: 'Send message to session' },
                    { value: 'task' as const, label: 'Create new task' },
                  ]).map(a => (
                    <button
                      key={a.value}
                      type="button"
                      onClick={() => setWatchAction(a.value)}
                      className={`text-[10px] px-2 py-0.5 rounded border transition-colors ${
                        watchAction === a.value
                          ? 'border-[var(--accent)] text-[var(--accent)] bg-[var(--accent)]/10'
                          : 'border-[var(--border)] text-[var(--text-secondary)] hover:border-[var(--text-secondary)]'
                      }`}
                    >
                      {a.label}
                    </button>
                  ))}
                </div>
                {watchAction !== 'notify' && (
                  <textarea
                    value={watchActionPrompt}
                    onChange={e => setWatchActionPrompt(e.target.value)}
                    placeholder={watchAction === 'message' ? 'Message to send to the session...' : 'Prompt for the new task...'}
                    rows={2}
                    className="mt-2 w-full px-2 py-1 bg-[var(--bg-secondary)] border border-[var(--border)] rounded text-xs text-[var(--text-primary)] resize-none focus:outline-none"
                  />
                )}
              </div>

              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={watchRepeat}
                  onChange={e => setWatchRepeat(e.target.checked)}
                  className="rounded"
                />
                <span className="text-[10px] text-[var(--text-secondary)]">Keep watching after trigger (repeat)</span>
              </label>
            </div>
          )}

          {/* Task prompt — only in prompt mode */}
          {taskMode === 'prompt' && (
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
          )}

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
              disabled={!selectedProject || (taskMode === 'prompt' && !prompt.trim()) || (taskMode === 'monitor' && !selectedSessionId)}
              className="text-xs px-4 py-1.5 bg-[var(--accent)] text-white rounded hover:opacity-90 disabled:opacity-50"
            >
              {editTask ? 'Save & Restart' : taskMode === 'monitor' ? 'Start Monitor' : scheduleMode === 'now' ? 'Submit Task' : 'Schedule Task'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
