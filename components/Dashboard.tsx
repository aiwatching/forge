'use client';

import { useState, useEffect, useCallback, useRef, lazy, Suspense } from 'react';
import { signOut } from 'next-auth/react';
import TaskBoard from './TaskBoard';
import TaskDetail from './TaskDetail';
import SessionView from './SessionView';
import NewTaskModal from './NewTaskModal';
import SettingsModal from './SettingsModal';
import TunnelToggle from './TunnelToggle';
import MonitorPanel from './MonitorPanel';
import type { Task } from '@/src/types';
import type { WebTerminalHandle } from './WebTerminal';

const WebTerminal = lazy(() => import('./WebTerminal'));
const DocsViewer = lazy(() => import('./DocsViewer'));
const CodeViewer = lazy(() => import('./CodeViewer'));
const ProjectManager = lazy(() => import('./ProjectManager'));
const PreviewPanel = lazy(() => import('./PreviewPanel'));
const PipelineView = lazy(() => import('./PipelineView'));
const SkillsPanel = lazy(() => import('./SkillsPanel'));

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
  const [viewMode, setViewMode] = useState<'tasks' | 'sessions' | 'terminal' | 'docs' | 'projects' | 'preview' | 'pipelines' | 'skills'>('terminal');
  const [tasks, setTasks] = useState<Task[]>([]);
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [showNewTask, setShowNewTask] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showMonitor, setShowMonitor] = useState(false);
  const [usage, setUsage] = useState<UsageSummary[]>([]);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [onlineCount, setOnlineCount] = useState<{ total: number; remote: number }>({ total: 0, remote: 0 });
  const [versionInfo, setVersionInfo] = useState<{ current: string; latest: string; hasUpdate: boolean } | null>(null);
  const [notifications, setNotifications] = useState<any[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [showNotifications, setShowNotifications] = useState(false);
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const terminalRef = useRef<WebTerminalHandle>(null);

  // Theme: load from localStorage + apply
  useEffect(() => {
    const saved = localStorage.getItem('forge-theme') as 'dark' | 'light' | null;
    if (saved) {
      setTheme(saved);
      document.documentElement.setAttribute('data-theme', saved === 'light' ? 'light' : '');
    }
  }, []);

  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    document.documentElement.setAttribute('data-theme', next === 'light' ? 'light' : '');
    localStorage.setItem('forge-theme', next);
  };

  // Version check (on mount + every 10 min)
  useEffect(() => {
    const check = () => fetch('/api/version').then(r => r.json()).then(setVersionInfo).catch(() => {});
    check();
    const id = setInterval(check, 10 * 60 * 1000);
    return () => clearInterval(id);
  }, []);

  // Notification polling
  const fetchNotifications = useCallback(() => {
    fetch('/api/notifications').then(r => r.json()).then(data => {
      setNotifications(data.notifications || []);
      setUnreadCount(data.unread || 0);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    fetchNotifications();
    const id = setInterval(fetchNotifications, 10000);
    return () => clearInterval(id);
  }, [fetchNotifications]);

  // Heartbeat for online user tracking
  useEffect(() => {
    const ping = () => {
      fetch('/api/online', { method: 'POST' })
        .then(r => r.json())
        .then(setOnlineCount)
        .catch(() => {});
    };
    ping();
    const id = setInterval(ping, 15_000); // every 15s
    return () => clearInterval(id);
  }, []);

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
      <header className="h-12 border-b-2 border-[var(--border)] flex items-center justify-between px-4 shrink-0 bg-[var(--bg-secondary)]">
        <div className="flex items-center gap-4">
          <span className="text-sm font-bold text-[var(--accent)]">Forge</span>
          {versionInfo && (
            <span className="flex items-center gap-1.5">
              <span className="text-[10px] text-[var(--text-secondary)]">v{versionInfo.current}</span>
              {versionInfo.hasUpdate && (
                <span
                  className="text-[9px] px-1.5 py-0.5 bg-[var(--accent)]/15 text-[var(--accent)] rounded cursor-default"
                  title={`forge upgrade\nnpm install -g @aion0/forge@latest`}
                >
                  v{versionInfo.latest} available
                </span>
              )}
              <button
                onClick={async () => {
                  const res = await fetch('/api/version?force=1');
                  const data = await res.json();
                  setVersionInfo(data);
                  if (data.hasUpdate) fetchNotifications();
                }}
                className="text-[9px] px-1 py-0.5 text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                title="Check for updates"
              >
                ↻
              </button>
            </span>
          )}

          {/* View mode toggle */}
          <div className="flex bg-[var(--bg-tertiary)] rounded p-0.5">
            <button
              onClick={() => setViewMode('terminal')}
              className={`text-[11px] px-2.5 py-0.5 rounded transition-colors ${
                viewMode === 'terminal'
                  ? 'bg-[var(--bg-secondary)] text-[var(--text-primary)] shadow-sm'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              }`}
            >
              Vibe Coding
            </button>
            <button
              onClick={() => setViewMode('docs')}
              className={`text-[11px] px-2.5 py-0.5 rounded transition-colors ${
                viewMode === 'docs'
                  ? 'bg-[var(--bg-secondary)] text-[var(--text-primary)] shadow-sm'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              }`}
            >
              Docs
            </button>
            <button
              onClick={() => setViewMode('projects')}
              className={`text-[11px] px-2.5 py-0.5 rounded transition-colors ${
                viewMode === 'projects'
                  ? 'bg-[var(--bg-secondary)] text-[var(--text-primary)] shadow-sm'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              }`}
            >
              Projects
            </button>
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
              onClick={() => setViewMode('pipelines')}
              className={`text-[11px] px-2.5 py-0.5 rounded transition-colors ${
                viewMode === 'pipelines'
                  ? 'bg-[var(--bg-secondary)] text-[var(--text-primary)] shadow-sm'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              }`}
            >
              Pipelines
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
              onClick={() => setViewMode('preview')}
              className={`text-[11px] px-2.5 py-0.5 rounded transition-colors ${
                viewMode === 'preview'
                  ? 'bg-[var(--bg-secondary)] text-[var(--text-primary)] shadow-sm'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              }`}
            >
              Demo Preview
            </button>
            <button
              onClick={() => setViewMode('skills')}
              className={`text-[11px] px-2.5 py-0.5 rounded transition-colors ${
                viewMode === 'skills'
                  ? 'bg-[var(--bg-secondary)] text-[var(--text-primary)] shadow-sm'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              }`}
            >
              Skills
            </button>
          </div>

          {viewMode === 'tasks' && (
            <span className="text-[10px] text-[var(--text-secondary)]">
              {running.length} running · {queued.length} queued · {tasks.filter(t => t.status === 'done').length} done
            </span>
          )}
        </div>
        <div className="flex items-center gap-2.5">
          {viewMode === 'tasks' && (
            <button
              onClick={() => setShowNewTask(true)}
              className="text-[10px] px-2.5 py-1 bg-[var(--accent)] text-white rounded hover:opacity-90"
            >
              + New Task
            </button>
          )}
          <TunnelToggle />
          {onlineCount.total > 0 && (
            <span className="text-[10px] text-[var(--text-secondary)] flex items-center gap-1" title={`${onlineCount.total} online${onlineCount.remote > 0 ? `, ${onlineCount.remote} remote` : ''}`}>
              <span className="text-green-500">●</span>
              {onlineCount.total}
            </span>
          )}
          {/* Alerts */}
          <div className="relative">
            <button
              onClick={() => { setShowNotifications(v => !v); setShowUserMenu(false); }}
              className="text-[10px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] relative px-1"
            >
              Alerts
              {unreadCount > 0 && (
                <span className="absolute -top-1.5 -right-1.5 min-w-[14px] h-[14px] rounded-full bg-[var(--red)] text-[8px] text-white flex items-center justify-center px-1 font-bold">
                  {unreadCount > 99 ? '99+' : unreadCount}
                </span>
              )}
            </button>
            {showNotifications && (
              <>
              <div className="fixed inset-0 z-40" onClick={() => setShowNotifications(false)} />
              <div className="absolute right-0 top-8 w-[360px] max-h-[480px] bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg shadow-xl z-50 flex flex-col">
                <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--border)]">
                  <span className="text-xs font-bold text-[var(--text-primary)]">Notifications</span>
                  <div className="flex items-center gap-2">
                    {unreadCount > 0 && (
                      <button
                        onClick={async () => {
                          await fetch('/api/notifications', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ action: 'markAllRead' }),
                          });
                          fetchNotifications();
                        }}
                        className="text-[9px] text-[var(--accent)] hover:underline"
                      >
                        Mark all read
                      </button>
                    )}
                    <button
                      onClick={() => setShowNotifications(false)}
                      className="text-[10px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                    >
                      Close
                    </button>
                  </div>
                </div>
                <div className="flex-1 overflow-y-auto">
                  {notifications.length === 0 ? (
                    <div className="p-6 text-center text-xs text-[var(--text-secondary)]">No notifications</div>
                  ) : (
                    notifications.map((n: any) => (
                      <div
                        key={n.id}
                        className={`group px-3 py-2 border-b border-[var(--border)]/50 hover:bg-[var(--bg-tertiary)] ${!n.read ? 'bg-[var(--accent)]/5' : ''}`}
                      >
                        <div className="flex items-start gap-2">
                          <span className="text-[10px] mt-0.5 shrink-0">
                            {n.type === 'task_done' ? '✅' : n.type === 'task_failed' ? '❌' : n.type === 'pipeline_done' ? '🔗' : n.type === 'pipeline_failed' ? '💔' : n.type === 'tunnel' ? '🌐' : 'ℹ️'}
                          </span>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-1">
                              <span className={`text-[11px] truncate ${!n.read ? 'font-semibold text-[var(--text-primary)]' : 'text-[var(--text-secondary)]'}`}>
                                {n.title}
                              </span>
                              {!n.read && <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)] shrink-0" />}
                            </div>
                            {n.body && (
                              <p className="text-[9px] text-[var(--text-secondary)] truncate mt-0.5">{n.body}</p>
                            )}
                            <span className="text-[8px] text-[var(--text-secondary)]">
                              {new Date(n.createdAt).toLocaleString()}
                            </span>
                          </div>
                          <div className="hidden group-hover:flex items-center gap-1 shrink-0">
                            {!n.read && (
                              <button
                                onClick={async (e) => {
                                  e.stopPropagation();
                                  await fetch('/api/notifications', {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ action: 'markRead', id: n.id }),
                                  });
                                  fetchNotifications();
                                }}
                                className="text-[8px] px-1 py-0.5 text-[var(--accent)] hover:underline"
                              >
                                read
                              </button>
                            )}
                            <button
                              onClick={async (e) => {
                                e.stopPropagation();
                                await fetch('/api/notifications', {
                                  method: 'POST',
                                  headers: { 'Content-Type': 'application/json' },
                                  body: JSON.stringify({ action: 'delete', id: n.id }),
                                });
                                fetchNotifications();
                              }}
                              className="text-[8px] px-1 py-0.5 text-red-400 hover:underline"
                            >
                              del
                            </button>
                          </div>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
              </>
            )}
          </div>
          {/* User menu */}
          <div className="relative">
            <button
              onClick={() => { setShowUserMenu(v => !v); setShowNotifications(false); }}
              className="text-[10px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] flex items-center gap-1 px-1"
            >
              {user?.name || 'local'} <span className="text-[8px]">▾</span>
            </button>
            {showUserMenu && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setShowUserMenu(false)} />
                <div className="absolute right-0 top-8 w-[140px] bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg shadow-xl z-50 py-1">
                  <button
                    onClick={() => { setShowMonitor(true); setShowUserMenu(false); }}
                    className="w-full text-left text-[11px] px-3 py-1.5 text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
                  >
                    Monitor
                  </button>
                  <button
                    onClick={() => { setShowSettings(true); setShowUserMenu(false); }}
                    className="w-full text-left text-[11px] px-3 py-1.5 text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
                  >
                    Settings
                  </button>
                  <div className="border-t border-[var(--border)] my-1" />
                  <button
                    onClick={() => signOut({ callbackUrl: '/login' })}
                    className="w-full text-left text-[11px] px-3 py-1.5 text-[var(--text-secondary)] hover:text-[var(--red)] hover:bg-[var(--bg-tertiary)]"
                  >
                    Logout
                  </button>
                </div>
              </>
            )}
          </div>
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

        {/* Projects */}
        {viewMode === 'projects' && (
          <Suspense fallback={<div className="flex-1 flex items-center justify-center text-[var(--text-secondary)]">Loading...</div>}>
            <ProjectManager />
          </Suspense>
        )}

        {/* Pipelines */}
        {viewMode === 'pipelines' && (
          <Suspense fallback={<div className="flex-1 flex items-center justify-center text-[var(--text-secondary)]">Loading...</div>}>
            <PipelineView onViewTask={(taskId) => { setViewMode('tasks'); setActiveTaskId(taskId); }} />
          </Suspense>
        )}

        {/* Preview */}
        {viewMode === 'preview' && (
          <Suspense fallback={<div className="flex-1 flex items-center justify-center text-[var(--text-secondary)]">Loading...</div>}>
            <PreviewPanel />
          </Suspense>
        )}

        {/* Skills */}
        {viewMode === 'skills' && (
          <Suspense fallback={<div className="flex-1 flex items-center justify-center text-[var(--text-secondary)]">Loading...</div>}>
            <SkillsPanel />
          </Suspense>
        )}

        {/* Docs — always mounted to keep terminal session alive */}
        <div className={viewMode === 'docs' ? 'flex-1 min-h-0 flex' : 'hidden'}>
          <Suspense fallback={<div className="flex-1 flex items-center justify-center text-[var(--text-secondary)]">Loading...</div>}>
            <DocsViewer />
          </Suspense>
        </div>

        {/* Code — terminal + file browser, always mounted to keep terminal sessions alive */}
        <div className={viewMode === 'terminal' ? 'flex-1 min-h-0 flex' : 'hidden'}>
          <Suspense fallback={<div className="flex-1 flex items-center justify-center text-[var(--text-secondary)]">Loading...</div>}>
            <CodeViewer terminalRef={terminalRef} />
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

      {showMonitor && <MonitorPanel onClose={() => setShowMonitor(false)} />}

      {showSettings && (
        <SettingsModal onClose={() => { setShowSettings(false); fetchData(); }} />
      )}
    </div>
  );
}
