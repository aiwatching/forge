'use client';

import { useState, useEffect, useCallback, useRef, lazy, Suspense } from 'react';
import { signOut } from 'next-auth/react';
const TaskBoard = lazy(() => import('./TaskBoard'));
const TaskDetail = lazy(() => import('./TaskDetail'));
const TunnelToggle = lazy(() => import('./TunnelToggle'));
import type { Task } from '@/src/types';
import type { WebTerminalHandle } from './WebTerminal';

const WebTerminal = lazy(() => import('./WebTerminal'));
const DocsViewer = lazy(() => import('./DocsViewer'));
const CodeViewer = lazy(() => import('./CodeViewer'));
const ProjectManager = lazy(() => import('./ProjectManager'));
const BrowserPanel = lazy(() => import('./BrowserPanel'));
const PipelineView = lazy(() => import('./PipelineView'));
const HelpDialog = lazy(() => import('./HelpDialog'));
const LogViewer = lazy(() => import('./LogViewer'));
const SkillsPanel = lazy(() => import('./SkillsPanel'));
const UsagePanel = lazy(() => import('./UsagePanel'));
const SessionView = lazy(() => import('./SessionView'));
const NewTaskModal = lazy(() => import('./NewTaskModal'));
const SettingsModal = lazy(() => import('./SettingsModal'));
const MonitorPanel = lazy(() => import('./MonitorPanel'));
const WorkspaceView = lazy(() => import('./WorkspaceView'));
// WorkspaceTree moved into ProjectDetail — no longer needed at Dashboard level

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

function FloatingBrowser({ onClose }: { onClose: () => void }) {
  const [pos, setPos] = useState({ x: 60, y: 60 });
  const [size, setSize] = useState({ w: 700, h: 500 });
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);
  const resizeRef = useRef<{ startX: number; startY: number; origW: number; origH: number } | null>(null);

  return (
    <div
      className="fixed z-50 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg shadow-2xl flex flex-col overflow-hidden"
      style={{ left: pos.x, top: pos.y, width: size.w, height: size.h }}
    >
      <div
        className="flex items-center gap-2 px-3 py-1.5 bg-[var(--bg-tertiary)] border-b border-[var(--border)] cursor-move shrink-0 select-none"
        onMouseDown={(e) => {
          e.preventDefault();
          dragRef.current = { startX: e.clientX, startY: e.clientY, origX: pos.x, origY: pos.y };
          const onMove = (ev: MouseEvent) => {
            if (!dragRef.current) return;
            setPos({ x: Math.max(0, dragRef.current.origX + ev.clientX - dragRef.current.startX), y: Math.max(0, dragRef.current.origY + ev.clientY - dragRef.current.startY) });
          };
          const onUp = () => { dragRef.current = null; window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
          window.addEventListener('mousemove', onMove);
          window.addEventListener('mouseup', onUp);
        }}
      >
        <span className="text-[11px] font-semibold text-[var(--text-primary)]">Browser</span>
        <button onClick={onClose} className="ml-auto text-[var(--text-secondary)] hover:text-[var(--red)] text-sm leading-none">✕</button>
      </div>
      <div className="flex-1 min-h-0 flex flex-col">
        <BrowserPanel />
      </div>
      <div
        onMouseDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
          resizeRef.current = { startX: e.clientX, startY: e.clientY, origW: size.w, origH: size.h };
          const onMove = (ev: MouseEvent) => {
            if (!resizeRef.current) return;
            setSize({ w: Math.max(400, resizeRef.current.origW + ev.clientX - resizeRef.current.startX), h: Math.max(300, resizeRef.current.origH + ev.clientY - resizeRef.current.startY) });
          };
          const onUp = () => { resizeRef.current = null; window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
          window.addEventListener('mousemove', onMove);
          window.addEventListener('mouseup', onUp);
        }}
        className="absolute bottom-0 right-0 w-4 h-4 cursor-se-resize"
        style={{ background: 'linear-gradient(135deg, transparent 50%, var(--border) 50%)' }}
      />
    </div>
  );
}

export default function Dashboard({ user }: { user: any }) {
  const [viewMode, setViewMode] = useState<'tasks' | 'sessions' | 'terminal' | 'docs' | 'projects' | 'pipelines' | 'workspace' | 'skills' | 'logs' | 'usage'>('terminal');
  // workspaceProject state kept for forge:open-terminal event compatibility
  const [workspaceProject, setWorkspaceProject] = useState<{ name: string; path: string } | null>(null);
  const [browserMode, setBrowserMode] = useState<'none' | 'float' | 'right' | 'left'>('none');
  const [showBrowserMenu, setShowBrowserMenu] = useState(false);
  const [browserWidth, setBrowserWidth] = useState(600);
  const browserDragRef = useRef<{ startX: number; startW: number } | null>(null);
  const [browserDragging, setBrowserDragging] = useState(false);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [showNewTask, setShowNewTask] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showMonitor, setShowMonitor] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
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
  const [displayName, setDisplayName] = useState(user?.name || 'Forge');
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

  // Fetch display name from settings
  const refreshDisplayName = useCallback(() => {
    fetch('/api/settings').then(r => r.json())
      .then((s: any) => { if (s.displayName) setDisplayName(s.displayName); })
      .catch(() => {});
  }, []);
  useEffect(() => { refreshDisplayName(); }, [refreshDisplayName]);

  // Listen for open-terminal events from ProjectManager
  useEffect(() => {
    const handler = (e: Event) => {
      const { projectPath, projectName, agentId, resumeMode, sessionId, profileEnv } = (e as CustomEvent).detail;
      setViewMode('terminal');
      setTimeout(() => {
        terminalRef.current?.openProjectTerminal?.(projectPath, projectName, agentId, resumeMode, sessionId, profileEnv);
      }, 300);
    };
    window.addEventListener('forge:open-terminal', handler);
    return () => window.removeEventListener('forge:open-terminal', handler);
  }, []);

  // Listen for navigation events (e.g. from ProjectDetail → Pipelines)
  const [pendingPipelineId, setPendingPipelineId] = useState<string | null>(null);
  useEffect(() => {
    const handler = (e: Event) => {
      const { view, pipelineId } = (e as CustomEvent).detail;
      if (view) setViewMode(view);
      if (pipelineId) setPendingPipelineId(pipelineId);
    };
    window.addEventListener('forge:navigate', handler);
    return () => window.removeEventListener('forge:navigate', handler);
  }, []);

  // Version check (on mount + every 10 min)
  useEffect(() => {
    const check = () => fetch('/api/version').then(r => r.json()).then(setVersionInfo).catch(() => {});
    check();
    const id = setInterval(check, 10 * 60 * 1000);
    return () => clearInterval(id);
  }, []);

  // Notifications: fetch on mount + when panel opens (no polling)
  const fetchNotifications = useCallback(() => {
    fetch('/api/notifications').then(r => r.json()).then(data => {
      setNotifications(data.notifications || []);
      setUnreadCount(data.unread || 0);
    }).catch(() => {});
  }, []);

  useEffect(() => { fetchNotifications(); }, [fetchNotifications]);

  // Refresh when notification panel opens
  useEffect(() => {
    if (showNotifications) fetchNotifications();
  }, [showNotifications, fetchNotifications]);

  // Heartbeat for online user tracking
  useEffect(() => {
    const ping = () => {
      fetch('/api/online', { method: 'POST' })
        .then(r => r.json())
        .then(setOnlineCount)
        .catch(() => {});
    };
    ping();
    const id = setInterval(ping, 60_000); // every 60s
    return () => clearInterval(id);
  }, []);

  const fetchData = useCallback(async () => {
    try {
      // Only fetch what's needed for current view
      const fetches: Promise<void>[] = [
        fetch('/api/projects').then(async r => { if (r.ok) setProjects(await r.json()); }),
      ];
      // Tasks + status only when relevant tabs are active
      if (viewMode === 'tasks' || viewMode === 'terminal') {
        fetches.push(
          fetch('/api/tasks').then(async r => { if (r.ok) setTasks(await r.json()); }),
        );
      }
      if (viewMode === 'usage') {
        fetches.push(
          fetch('/api/status').then(async r => { if (r.ok) { const s = await r.json(); setProviders(s.providers); setUsage(s.usage); } }),
        );
      }
      await Promise.all(fetches);
    } catch {}
  }, [viewMode]);

  useEffect(() => {
    fetchData();
    // Poll less aggressively: 10s instead of 5s
    const interval = setInterval(fetchData, 10000);
    return () => clearInterval(interval);
  }, [fetchData]);

  const activeTask = tasks.find(t => t.id === activeTaskId);
  const running = tasks.filter(t => t.status === 'running');
  const queued = tasks.filter(t => t.status === 'queued');

  return (
    <div className="h-screen flex">
      {/* Browser — left side */}
      {browserMode === 'left' && (
        <>
        <div style={{ width: browserWidth }} className="shrink-0 flex flex-col relative">
          <Suspense fallback={null}><BrowserPanel onClose={() => setBrowserMode('none')} /></Suspense>
          {browserDragging && <div className="absolute inset-0 z-10" />}
        </div>
        <div
          onMouseDown={(e) => {
            e.preventDefault();
            browserDragRef.current = { startX: e.clientX, startW: browserWidth };
            setBrowserDragging(true);
            const onMove = (ev: MouseEvent) => {
              if (!browserDragRef.current) return;
              setBrowserWidth(Math.max(320, Math.min(1200, browserDragRef.current.startW + (ev.clientX - browserDragRef.current.startX))));
            };
            const onUp = () => { browserDragRef.current = null; setBrowserDragging(false); window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
            window.addEventListener('mousemove', onMove);
            window.addEventListener('mouseup', onUp);
          }}
          className="w-1 bg-[var(--border)] cursor-col-resize shrink-0 hover:bg-[var(--accent)]/50"
        />
        </>
      )}

      {/* Forge main area */}
      <div className="flex-1 flex flex-col min-w-0 min-h-0 overflow-hidden">
      {/* Top bar */}
      <header className="h-12 border-b-2 border-[var(--border)] flex items-center justify-between px-4 shrink-0 bg-[var(--bg-secondary)]">
        <div className="flex items-center gap-4">
          <img src="/icon.png" alt="Forge" width={28} height={28} className="rounded" />
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
          <div className="flex items-center bg-[var(--bg-tertiary)] rounded p-0.5">
            {/* Workspace */}
            {(['terminal', 'projects'] as const).map(mode => (
              <button
                key={mode}
                onClick={() => setViewMode(mode)}
                className={`text-[11px] px-2.5 py-0.5 rounded transition-colors ${
                  viewMode === mode
                    ? 'bg-[var(--bg-secondary)] text-[var(--text-primary)] shadow-sm'
                    : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                }`}
              >
                {{ terminal: 'Vibe Coding', projects: 'Projects' }[mode]}
              </button>
            ))}
            <span className="w-[2px] h-4 bg-[var(--text-secondary)]/30 mx-1.5" />
            {/* Docs */}
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
            <span className="w-[2px] h-4 bg-[var(--text-secondary)]/30 mx-1.5" />
            {/* Automation */}
            {(['tasks', 'pipelines'] as const).map(mode => (
              <button
                key={mode}
                onClick={() => setViewMode(mode)}
                className={`text-[11px] px-2.5 py-0.5 rounded transition-colors ${
                  viewMode === mode
                    ? 'bg-[var(--bg-secondary)] text-[var(--text-primary)] shadow-sm'
                    : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                }`}
              >
                {{ tasks: 'Tasks', pipelines: 'Pipelines' }[mode]}
              </button>
            ))}
            <span className="w-[2px] h-4 bg-[var(--text-secondary)]/30 mx-1.5" />
            {/* Marketplace */}
            <button
              onClick={() => setViewMode('skills')}
              className={`text-[11px] px-2.5 py-0.5 rounded transition-colors ${
                viewMode === 'skills'
                  ? 'bg-[var(--bg-secondary)] text-[var(--text-primary)] shadow-sm'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              }`}
            >
              Marketplace
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
          {/* Help */}
          <button
            onClick={() => setShowHelp(v => !v)}
            className={`text-[10px] px-2 py-0.5 border rounded transition-colors ${
              showHelp
                ? 'border-[var(--accent)] text-[var(--accent)]'
                : 'border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:border-[var(--text-secondary)]'
            }`}
          >?</button>
          <div className="relative">
            <button
              onClick={() => setShowBrowserMenu(v => !v)}
              className={`text-[10px] px-2 py-0.5 border rounded transition-colors ${
                browserMode !== 'none'
                  ? 'border-blue-500 text-blue-400'
                  : 'border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:border-[var(--text-secondary)]'
              }`}
            >
              Browser
            </button>
            {showBrowserMenu && (
              <>
              <div className="fixed inset-0 z-40" onClick={() => setShowBrowserMenu(false)} />
              <div className="absolute top-full right-0 mt-1 z-50 bg-[var(--bg-secondary)] border border-[var(--border)] rounded shadow-lg py-1 min-w-[140px]">
                {browserMode !== 'none' && (
                  <button onClick={() => { setBrowserMode('none'); setShowBrowserMenu(false); }} className="w-full text-left px-3 py-1.5 text-[10px] text-red-400 hover:bg-[var(--bg-tertiary)]">
                    Close Browser
                  </button>
                )}
                <button onClick={() => { setBrowserMode('float'); setShowBrowserMenu(false); }} className={`w-full text-left px-3 py-1.5 text-[10px] hover:bg-[var(--bg-tertiary)] ${browserMode === 'float' ? 'text-[var(--accent)]' : 'text-[var(--text-primary)]'}`}>
                  Floating Window
                </button>
                <button onClick={() => { setBrowserMode('right'); setShowBrowserMenu(false); }} className={`w-full text-left px-3 py-1.5 text-[10px] hover:bg-[var(--bg-tertiary)] ${browserMode === 'right' ? 'text-[var(--accent)]' : 'text-[var(--text-primary)]'}`}>
                  Right Side
                </button>
                <button onClick={() => { setBrowserMode('left'); setShowBrowserMenu(false); }} className={`w-full text-left px-3 py-1.5 text-[10px] hover:bg-[var(--bg-tertiary)] ${browserMode === 'left' ? 'text-[var(--accent)]' : 'text-[var(--text-primary)]'}`}>
                  Left Side
                </button>
                <button onClick={() => {
                  const url = localStorage.getItem('forge-browser-url');
                  if (url) window.open(url, '_blank');
                  else { const u = prompt('Enter URL to open:'); if (u) window.open(u.trim(), '_blank'); }
                  setShowBrowserMenu(false);
                }} className="w-full text-left px-3 py-1.5 text-[10px] text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]">
                  New Tab
                </button>
              </div>
              </>
            )}
          </div>
          <button
            onClick={() => setViewMode('usage')}
            className={`text-[10px] px-2 py-0.5 border rounded transition-colors ${
              viewMode === 'usage'
                ? 'border-[var(--accent)] text-[var(--accent)]'
                : 'border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:border-[var(--text-secondary)]'
            }`}
          >Usage</button>
          <TunnelToggle />
          {onlineCount.total > 0 && (
            <span className="text-[10px] text-[var(--text-secondary)] flex items-center gap-1" title={`${onlineCount.total} online${onlineCount.remote > 0 ? `, ${onlineCount.remote} remote` : ''}`}>
              <span className="text-green-500">●</span>
              {onlineCount.total}
            </span>
          )}
          <span className="w-[2px] h-4 bg-[var(--text-secondary)]/30" />
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
              {displayName} <span className="text-[8px]">▾</span>
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
                  <button
                    onClick={() => { setViewMode('logs'); setShowUserMenu(false); }}
                    className="w-full text-left text-[11px] px-3 py-1.5 text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
                  >
                    Logs
                  </button>
                  <a
                    href="/mobile"
                    className="block w-full text-left text-[11px] px-3 py-1.5 text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
                  >
                    Mobile View
                  </a>
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
        ) : null}

        {/* Projects — keep alive to preserve state across tab switches */}
        <div className={`flex-1 flex flex-col min-h-0 ${viewMode !== 'projects' ? 'hidden' : ''}`}>
          <Suspense fallback={<div className="flex-1 flex items-center justify-center text-[var(--text-secondary)]">Loading...</div>}>
            <ProjectManager />
          </Suspense>
        </div>

        {/* Pipelines */}
        {viewMode === 'pipelines' && (
          <Suspense fallback={<div className="flex-1 flex items-center justify-center text-[var(--text-secondary)]">Loading...</div>}>
            <PipelineView
              onViewTask={(taskId) => { setViewMode('tasks'); setActiveTaskId(taskId); }}
              focusPipelineId={pendingPipelineId}
              onFocusHandled={() => setPendingPipelineId(null)}
            />
          </Suspense>
        )}


        {/* Skills */}
        {viewMode === 'skills' && (
          <Suspense fallback={<div className="flex-1 flex items-center justify-center text-[var(--text-secondary)]">Loading...</div>}>
            <SkillsPanel />
          </Suspense>
        )}


        {/* Usage */}
        {viewMode === 'usage' && (
          <Suspense fallback={<div className="flex-1 flex items-center justify-center text-[var(--text-secondary)]">Loading...</div>}>
            <UsagePanel />
          </Suspense>
        )}

        {/* Logs */}
        {viewMode === 'logs' && (
          <Suspense fallback={<div className="flex-1 flex items-center justify-center text-[var(--text-secondary)]">Loading...</div>}>
            <LogViewer />
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
      </div>{/* close Forge main area */}

      {/* Browser — right side */}
      {browserMode === 'right' && (
        <>
        <div
          onMouseDown={(e) => {
            e.preventDefault();
            browserDragRef.current = { startX: e.clientX, startW: browserWidth };
            setBrowserDragging(true);
            const onMove = (ev: MouseEvent) => {
              if (!browserDragRef.current) return;
              setBrowserWidth(Math.max(320, Math.min(1200, browserDragRef.current.startW - (ev.clientX - browserDragRef.current.startX))));
            };
            const onUp = () => { browserDragRef.current = null; setBrowserDragging(false); window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
            window.addEventListener('mousemove', onMove);
            window.addEventListener('mouseup', onUp);
          }}
          className="w-1 bg-[var(--border)] cursor-col-resize shrink-0 hover:bg-[var(--accent)]/50"
        />
        <div style={{ width: browserWidth }} className="shrink-0 flex flex-col relative">
          <Suspense fallback={null}><BrowserPanel onClose={() => setBrowserMode('none')} /></Suspense>
          {browserDragging && <div className="absolute inset-0 z-10" />}
        </div>
        </>
      )}

      {/* Browser — floating window */}
      {browserMode === 'float' && (
        <Suspense fallback={null}>
          <FloatingBrowser onClose={() => setBrowserMode('none')} />
        </Suspense>
      )}

      {showNewTask && (
        <Suspense fallback={null}>
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
        </Suspense>
      )}

      {showMonitor && <Suspense fallback={null}><MonitorPanel onClose={() => setShowMonitor(false)} /></Suspense>}

      {showSettings && (
        <Suspense fallback={null}>
          <SettingsModal onClose={() => { setShowSettings(false); fetchData(); refreshDisplayName(); }} />
        </Suspense>
      )}
      {showHelp && (
        <Suspense fallback={null}>
          <HelpDialog onClose={() => setShowHelp(false)} />
        </Suspense>
      )}
    </div>
  );
}
