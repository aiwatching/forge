'use client';

import { useState, useEffect, useCallback, useRef, lazy, Suspense } from 'react';
import TaskBoard from './TaskBoard';
import TaskDetail from './TaskDetail';
import SessionView from './SessionView';
import NewTaskModal from './NewTaskModal';
import SettingsModal from './SettingsModal';
import type { Task } from '@/src/types';
import type { WebTerminalHandle } from './WebTerminal';

const WebTerminal = lazy(() => import('./WebTerminal'));

interface UsageSummary {
  provider: string;
  totalInput: number;
  totalOutput: number;
  totalCost: number;
}

interface ProviderInfo {
  name: string;
  displayName: string;
  hasKey: boolean;
  enabled: boolean;
}

interface ProjectInfo {
  name: string;
  path: string;
  language: string | null;
}

export default function Dashboard({ user }: { user: any }) {
  const [viewMode, setViewMode] = useState<'tasks' | 'sessions' | 'terminal'>('tasks');
  const [tasks, setTasks] = useState<Task[]>([]);
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [showNewTask, setShowNewTask] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [usage, setUsage] = useState<UsageSummary[]>([]);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const terminalRef = useRef<WebTerminalHandle>(null);

  const fetchData = useCallback(async () => {
    const [tasksRes, statusRes, projectsRes] = await Promise.all([
      fetch('/api/tasks'),
      fetch('/api/status'),
      fetch('/api/projects'),
    ]);
    const tasksData = await tasksRes.json();
    const statusData = await statusRes.json();
    const projectsData = await projectsRes.json();
    setTasks(tasksData);
    setProviders(statusData.providers);
    setUsage(statusData.usage);
    setProjects(projectsData);
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 5000);
    return () => clearInterval(interval);
  }, [fetchData]);

  const activeTask = tasks.find(t => t.id === activeTaskId);
  const running = tasks.filter(t => t.status === 'running');
  const queued = tasks.filter(t => t.status === 'queued');

  return (
    <div className="h-screen flex flex-col">
      {/* Top bar */}
      <header className="h-10 border-b border-[var(--border)] flex items-center justify-between px-4 shrink-0">
        <div className="flex items-center gap-4">
          <span className="text-sm font-bold text-[var(--accent)]">My Workflow</span>

          {/* View mode toggle */}
          <div className="flex bg-[var(--bg-tertiary)] rounded p-0.5">
            <button
              onClick={() => setViewMode('tasks')}
              className={`text-[11px] px-2.5 py-0.5 rounded transition-colors ${
                viewMode === 'tasks'
                  ? 'bg-[var(--bg-secondary)] text-[var(--text-primary)] shadow-sm'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              }`}
            >
              Tasks
            </button>
            <button
              onClick={() => setViewMode('sessions')}
              className={`text-[11px] px-2.5 py-0.5 rounded transition-colors ${
                viewMode === 'sessions'
                  ? 'bg-[var(--bg-secondary)] text-[var(--text-primary)] shadow-sm'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              }`}
            >
              Sessions
            </button>
            <button
              onClick={() => setViewMode('terminal')}
              className={`text-[11px] px-2.5 py-0.5 rounded transition-colors ${
                viewMode === 'terminal'
                  ? 'bg-[var(--bg-secondary)] text-[var(--text-primary)] shadow-sm'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              }`}
            >
              Terminal
            </button>
          </div>

          {viewMode === 'tasks' && (
            <span className="text-[10px] text-[var(--text-secondary)]">
              {running.length} running · {queued.length} queued · {tasks.filter(t => t.status === 'done').length} done
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          {viewMode === 'tasks' && (
            <button
              onClick={() => setShowNewTask(true)}
              className="text-xs px-3 py-1 bg-[var(--accent)] text-white rounded hover:opacity-90"
            >
              + New Task
            </button>
          )}
          <button
            onClick={() => setShowSettings(true)}
            className="text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
          >
            Settings
          </button>
          <span className="text-xs text-[var(--text-secondary)]">{user?.name || 'local'}</span>
        </div>
      </header>

      {/* Main content */}
      <div className="flex-1 flex min-h-0">
        {viewMode === 'tasks' ? (
          <>
            {/* Left — Task list */}
            <aside className="w-72 border-r border-[var(--border)] flex flex-col shrink-0">
              <TaskBoard tasks={tasks} activeId={activeTaskId} onSelect={setActiveTaskId} onRefresh={fetchData} />
            </aside>

            {/* Center — Task detail / empty state */}
            <main className="flex-1 flex flex-col min-w-0">
              {activeTask ? (
                <TaskDetail
                  task={activeTask}
                  onRefresh={fetchData}
                  onFollowUp={async (data) => {
                    const res = await fetch('/api/tasks', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify(data),
                    });
                    const newTask = await res.json();
                    setActiveTaskId(newTask.id);
                    fetchData();
                  }}
                />
              ) : (
                <div className="flex-1 flex items-center justify-center text-[var(--text-secondary)]">
                  <div className="text-center space-y-2">
                    <p className="text-lg">Select a task or create a new one</p>
                    <p className="text-xs">Submit tasks for Claude Code to work on autonomously</p>
                  </div>
                </div>
              )}
            </main>

            {/* Right — Status panel */}
            <aside className="w-56 border-l border-[var(--border)] flex flex-col shrink-0 p-3 space-y-4">
              {/* Providers */}
              <div>
                <h3 className="text-[10px] font-semibold text-[var(--text-secondary)] uppercase mb-2">Providers</h3>
                <div className="space-y-1">
                  {providers.map(p => (
                    <div key={p.name} className="flex items-center justify-between text-xs">
                      <span className={p.hasKey && p.enabled ? 'text-[var(--text-primary)]' : 'text-[var(--text-secondary)]'}>
                        {p.displayName}
                      </span>
                      <span className={`text-[10px] ${p.hasKey && p.enabled ? 'text-[var(--green)]' : 'text-[var(--red)]'}`}>
                        {p.hasKey && p.enabled ? '● active' : '○ off'}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Usage */}
              {usage.length > 0 && (
                <div>
                  <h3 className="text-[10px] font-semibold text-[var(--text-secondary)] uppercase mb-2">Usage (30d)</h3>
                  <div className="space-y-1">
                    {usage.map((u, i) => (
                      <div key={i} className="text-xs">
                        <div className="flex justify-between">
                          <span className="text-[var(--text-secondary)]">{u.provider}</span>
                          <span className="text-[var(--text-primary)]">{((u.totalInput + u.totalOutput) / 1000).toFixed(0)}k tokens</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Running tasks */}
              {running.length > 0 && (
                <div>
                  <h3 className="text-[10px] font-semibold text-[var(--text-secondary)] uppercase mb-2">Running</h3>
                  <div className="space-y-1">
                    {running.map(t => (
                      <button
                        key={t.id}
                        onClick={() => { setViewMode('tasks'); setActiveTaskId(t.id); }}
                        className="w-full text-left px-2 py-1 rounded text-xs hover:bg-[var(--bg-tertiary)]"
                      >
                        <span className="text-[var(--green)] text-[10px]">● </span>
                        <span className="truncate">{t.projectName}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </aside>
          </>
        ) : viewMode === 'sessions' ? (
          <SessionView
            projects={projects}
            onOpenInTerminal={(sessionId, projectPath) => {
              setViewMode('terminal');
              setTimeout(() => {
                terminalRef.current?.openSessionInTerminal(sessionId, projectPath);
              }, 100);
            }}
          />
        ) : null}

        {/* Terminal — always mounted, hidden when not active to keep sessions alive */}
        <div className={`flex-1 min-h-0 ${viewMode === 'terminal' ? '' : 'hidden'}`}>
          <Suspense fallback={<div className="flex-1 flex items-center justify-center text-[var(--text-secondary)]">Loading terminal...</div>}>
            <WebTerminal ref={terminalRef} />
          </Suspense>
        </div>
      </div>

      {showNewTask && (
        <NewTaskModal
          onClose={() => setShowNewTask(false)}
          onCreate={async (data) => {
            await fetch('/api/tasks', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(data),
            });
            setShowNewTask(false);
            fetchData();
          }}
        />
      )}

      {showSettings && (
        <SettingsModal onClose={() => { setShowSettings(false); fetchData(); }} />
      )}
    </div>
  );
}
