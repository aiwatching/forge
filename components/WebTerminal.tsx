'use client';

import { useState, useEffect, useRef, useCallback, memo, useImperativeHandle, forwardRef } from 'react';
import { TerminalSessionPickerLazy, fetchProjectSessions } from './TerminalLauncher';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { SearchAddon } from '@xterm/addon-search';
import '@xterm/xterm/css/xterm.css';

// ─── Imperative API for parent components ────────────────────

export interface WebTerminalHandle {
  openSessionInTerminal: (sessionId: string, projectPath: string) => void;
  openProjectTerminal: (projectPath: string, projectName: string, agentId?: string, resumeMode?: boolean, sessionId?: string, profileEnv?: Record<string, string>) => void;
}

export interface WebTerminalProps {
  onActiveSession?: (sessionName: string | null) => void;
  onCodeOpenChange?: (open: boolean) => void;
}

// ─── Types ───────────────────────────────────────────────────

interface TmuxSession {
  name: string;
  created: string;
  attached: boolean;
  windows: number;
}

type SplitNode =
  | { type: 'terminal'; id: number; sessionName?: string; projectPath?: string }
  | { type: 'split'; id: number; direction: 'horizontal' | 'vertical'; ratio: number; first: SplitNode; second: SplitNode };

interface TabState {
  id: number;
  label: string;
  tree: SplitNode;
  ratios: Record<number, number>;
  activeId: number;
  projectPath?: string;
  bellEnabled?: boolean;
  agent?: string; // agent ID (e.g., 'claude', 'codex', 'aider')
}

// ─── Layout persistence ──────────────────────────────────────

function getWsUrl() {
  if (typeof window === 'undefined') return `ws://localhost:${parseInt(process.env.TERMINAL_PORT || '8404')}`;
  const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsHost = window.location.hostname;
  // When accessed via tunnel or non-localhost, use the Next.js proxy path
  if (wsHost !== 'localhost' && wsHost !== '127.0.0.1') {
    return `${wsProtocol}//${window.location.host}/terminal-ws`;
  }
  // Terminal port = web port + 1
  const webPort = parseInt(window.location.port) || 8403;
  return `${wsProtocol}//${wsHost}:${webPort + 1}`;
}

/** Load shared terminal state via API (always available, doesn't depend on terminal WebSocket server) */
async function loadSharedState(): Promise<{ tabs: TabState[]; activeTabId: number; sessionLabels: Record<string, string> } | null> {
  try {
    const res = await fetch('/api/terminal-state');
    if (!res.ok) return null;
    const d = await res.json();
    if (d && Array.isArray(d.tabs) && d.tabs.length > 0 && typeof d.activeTabId === 'number') {
      return { tabs: d.tabs, activeTabId: d.activeTabId, sessionLabels: d.sessionLabels || {} };
    }
    return null;
  } catch {
    return null;
  }
}

/** Save shared terminal state to server (fire-and-forget) */
function saveSharedState(tabs: TabState[], activeTabId: number, sessionLabels: Record<string, string>) {
  try {
    const ws = new WebSocket(getWsUrl());
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'save-state', data: { tabs, activeTabId, sessionLabels } }));
      setTimeout(() => ws.close(), 200);
    };
    ws.onerror = () => ws.close();
  } catch {}
}

// ─── Split tree helpers ──────────────────────────────────────

let nextId = 1;

function initNextId(tree: SplitNode) {
  if (tree.type === 'terminal') {
    nextId = Math.max(nextId, tree.id + 1);
  } else {
    nextId = Math.max(nextId, tree.id + 1);
    initNextId(tree.first);
    initNextId(tree.second);
  }
}

function initNextIdFromTabs(tabs: TabState[]) {
  for (const tab of tabs) {
    nextId = Math.max(nextId, tab.id + 1);
    initNextId(tab.tree);
  }
}

function makeTerminal(sessionName?: string, projectPath?: string): SplitNode {
  return { type: 'terminal', id: nextId++, sessionName, projectPath };
}

function makeSplit(direction: 'horizontal' | 'vertical', first: SplitNode, second: SplitNode): SplitNode {
  return { type: 'split', id: nextId++, direction, ratio: 0.5, first, second };
}

function splitNodeById(tree: SplitNode, targetId: number, direction: 'horizontal' | 'vertical'): SplitNode {
  if (tree.type === 'terminal') {
    if (tree.id === targetId) return makeSplit(direction, tree, makeTerminal());
    return tree;
  }
  return { ...tree, first: splitNodeById(tree.first, targetId, direction), second: splitNodeById(tree.second, targetId, direction) };
}

function removeNodeById(tree: SplitNode, targetId: number): SplitNode | null {
  if (tree.type === 'terminal') return tree.id === targetId ? null : tree;
  if (tree.first.type === 'terminal' && tree.first.id === targetId) return tree.second;
  if (tree.second.type === 'terminal' && tree.second.id === targetId) return tree.first;
  const f = removeNodeById(tree.first, targetId);
  if (f !== tree.first) return f ? { ...tree, first: f } : tree.second;
  const s = removeNodeById(tree.second, targetId);
  if (s !== tree.second) return s ? { ...tree, second: s } : tree.first;
  return tree;
}

function updateSessionName(tree: SplitNode, targetId: number, sessionName: string): SplitNode {
  if (tree.type === 'terminal') {
    return tree.id === targetId ? { ...tree, sessionName } : tree;
  }
  return { ...tree, first: updateSessionName(tree.first, targetId, sessionName), second: updateSessionName(tree.second, targetId, sessionName) };
}

function countTerminals(tree: SplitNode): number {
  if (tree.type === 'terminal') return 1;
  return countTerminals(tree.first) + countTerminals(tree.second);
}

function firstTerminalId(n: SplitNode): number {
  return n.type === 'terminal' ? n.id : firstTerminalId(n.first);
}

function collectPaneIds(tree: SplitNode): number[] {
  if (tree.type === 'terminal') return [tree.id];
  return [...collectPaneIds(tree.first), ...collectPaneIds(tree.second)];
}

function collectSessionNames(tree: SplitNode): string[] {
  if (tree.type === 'terminal') return tree.sessionName ? [tree.sessionName] : [];
  return [...collectSessionNames(tree.first), ...collectSessionNames(tree.second)];
}

function collectAllSessionNames(tabs: TabState[]): string[] {
  return tabs.flatMap(t => collectSessionNames(t.tree));
}

// ─── Mouse Toggle Button ─────────────────────────────────────

function MouseToggle() {
  const [mouseOn, setMouseOn] = useState(true);

  const toggle = () => {
    const next = !mouseOn;
    try {
      const wsUrl = getWsUrl();
      const ws = new WebSocket(wsUrl);
      ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'tmux-mouse', mouse: next }));
        setTimeout(() => ws.close(), 300);
      };
      ws.onerror = () => ws.close();
    } catch {}
    setMouseOn(next);
  };

  return (
    <div className="flex items-center gap-1 mr-2">
      <span className="text-[8px] text-gray-600">
        {mouseOn ? 'scroll: trackpad · copy: Shift+drag' : 'scroll: Ctrl+B [ · copy: drag'}
      </span>
      <button onClick={toggle} title={mouseOn ? 'Click to disable mouse (easier text select)' : 'Click to enable mouse (trackpad scroll)'}
        className={`text-[9px] px-1.5 py-0.5 rounded border transition-colors ${mouseOn ? 'border-green-600/40 text-green-400 bg-green-500/10' : 'border-gray-600 text-gray-500'}`}>
        🖱️ {mouseOn ? 'ON' : 'OFF'}
      </button>
    </div>
  );
}

// ─── Pending commands for new terminal panes ────────────────

const pendingCommands = new Map<number, string>();

// ─── Bell notification tracking ─────────────────────────────

const bellEnabledPanes = new Set<number>();
const bellPaneLabels = new Map<number, string>();
const bellLastFired = new Map<string, number>(); // tabLabel -> timestamp
const BELL_COOLDOWN = 120000; // 2min cooldown between bells

function fireBellNotification(paneId: number) {
  const label = bellPaneLabels.get(paneId) || 'Terminal';
  const now = Date.now();
  const last = bellLastFired.get(label) || 0;
  if (now - last < BELL_COOLDOWN) return;
  bellLastFired.set(label, now);

  // Browser notification
  if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
    new Notification('Forge — Terminal Idle', { body: `"${label}" appears to have finished.`, icon: '/icon.png' });
  }

  // Telegram + in-app via API
  fetch('/api/terminal-bell', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tabLabel: label }),
  }).catch(() => {});
}

// ─── Global drag lock — suppress terminal fit() during split drag ──

let globalDragging = false;

// ─── Main component ─────────────────────────────────────────

const WebTerminal = forwardRef<WebTerminalHandle, WebTerminalProps>(function WebTerminal({ onActiveSession, onCodeOpenChange }, ref) {
  const [tabs, setTabs] = useState<TabState[]>(() => {
    const tree = makeTerminal();
    return [{ id: nextId++, label: 'Terminal 1', tree, ratios: {}, activeId: firstTerminalId(tree) }];
  });
  const [activeTabId, setActiveTabId] = useState(() => tabs[0]?.id || 1);
  const [hydrated, setHydrated] = useState(false);
  const stateLoadedRef = useRef(false);
  const [tmuxSessions, setTmuxSessions] = useState<TmuxSession[]>([]);
  const [showSessionPicker, setShowSessionPicker] = useState(false);
  const [editingTabId, setEditingTabId] = useState<number | null>(null);
  const [editingLabel, setEditingLabel] = useState('');
  const [closeConfirm, setCloseConfirm] = useState<{ tabId: number; sessions: string[] } | null>(null);
  const sessionLabelsRef = useRef<Record<string, string>>({});
  const dragTabRef = useRef<number | null>(null);
  const [refreshKeys, setRefreshKeys] = useState<Record<number, number>>({});
  const [tabCodeOpen, setTabCodeOpen] = useState<Record<number, boolean>>({});
  const [showNewTabModal, setShowNewTabModal] = useState(false);
  const [vibePickerInfo, setVibePickerInfo] = useState<{ projectPath: string; projectName: string; agentId: string; profileEnv?: Record<string, string>; supportsSession: boolean; currentSessionId: string | null } | null>(null);
  const [projectRoots, setProjectRoots] = useState<string[]>([]);
  const [allProjects, setAllProjects] = useState<{ name: string; path: string; root: string }[]>([]);
  const [skipPermissions, setSkipPermissions] = useState(false);
  const [expandedRoot, setExpandedRoot] = useState<string | null>(null);
  const [availableAgents, setAvailableAgents] = useState<{ id: string; name: string; detected?: boolean }[]>([]);
  const [selectedAgent, setSelectedAgent] = useState<string>('');
  const [defaultAgentId, setDefaultAgentId] = useState('claude');

  // Restore shared state from server after mount
  useEffect(() => {
    // Fetch settings for skipPermissions
    fetch('/api/settings').then(r => r.json())
      .then((s: any) => { if (s.skipPermissions) setSkipPermissions(true); })
      .catch(() => {});
    // Load state + projects together, then patch missing projectPath
    Promise.all([
      loadSharedState(),
      fetch('/api/projects').then(r => r.json()).catch(() => []),
    ]).then(([saved, projects]) => {
      const projList: { name: string; path: string; root: string }[] = Array.isArray(projects) ? projects : [];
      setAllProjects(projList);
      setProjectRoots([...new Set(projList.map(p => p.root))]);

      if (saved && saved.tabs.length > 0) {
        initNextIdFromTabs(saved.tabs);
        // Patch missing projectPath by matching tab label to project name
        for (const tab of saved.tabs) {
          if (!tab.projectPath) {
            const match = projList.find(p => p.name.toLowerCase() === tab.label.toLowerCase());
            if (match) {
              tab.projectPath = match.path;
              // Also patch tree node
              if (tab.tree.type === 'terminal') tab.tree.projectPath = match.path;
            }
          }
        }
        setTabs(saved.tabs);
        setActiveTabId(saved.activeTabId);
        sessionLabelsRef.current = saved.sessionLabels || {};
        stateLoadedRef.current = true;
      }
      setHydrated(true);
    });
  }, []);

  // Persist to server on changes (debounced, only after hydration)
  const saveTimerRef = useRef(0);
  useEffect(() => {
    if (!hydrated) return;
    // Collect all active session names from current tabs
    const activeSessionNames = new Set<string>();
    for (const tab of tabs) {
      for (const sn of collectSessionNames(tab.tree)) {
        activeSessionNames.add(sn);
      }
    }
    // Only keep labels for active sessions (clean up stale entries)
    const labels: Record<string, string> = {};
    for (const sn of activeSessionNames) {
      labels[sn] = sessionLabelsRef.current[sn] || '';
    }
    for (const tab of tabs) {
      for (const sn of collectSessionNames(tab.tree)) {
        labels[sn] = tab.label;
      }
    }
    sessionLabelsRef.current = labels;
    // Debounced save to server
    clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      saveSharedState(tabs, activeTabId, labels);
    }, 500);
  }, [tabs, activeTabId, hydrated]);

  const activeTab = tabs.find(t => t.id === activeTabId) || tabs[0];

  // Notify parent when active terminal session or code state changes
  useEffect(() => {
    if (!activeTab) return;
    if (onActiveSession) {
      const sessions = collectSessionNames(activeTab.tree);
      onActiveSession(sessions[0] || null);
    }
    if (onCodeOpenChange) {
      onCodeOpenChange(tabCodeOpen[activeTab.id] ?? false);
    }
  }, [activeTabId, activeTab, onActiveSession, onCodeOpenChange, tabCodeOpen]);

  // ─── Imperative handle for parent ─────────────────────

  useImperativeHandle(ref, () => ({
    async openSessionInTerminal(sessionId: string, projectPath: string) {
      const tree = makeTerminal(undefined, projectPath);
      const paneId = firstTerminalId(tree);
      const sf = skipPermissions ? ' --dangerously-skip-permissions' : '';
      let mcpFlag = '';
      try { const { getMcpFlag } = await import('@/lib/session-utils'); mcpFlag = await getMcpFlag(projectPath); } catch {}
      const cmd = `cd "${projectPath}" && claude --resume ${sessionId}${sf}${mcpFlag}\n`;
      pendingCommands.set(paneId, cmd);
      const projectName = projectPath.split('/').pop() || 'Terminal';
      const newTab: TabState = {
        id: nextId++,
        label: projectName,
        tree,
        ratios: {},
        activeId: paneId,
        projectPath,
      };
      setTabs(prev => [...prev, newTab]);
      setTimeout(() => setActiveTabId(newTab.id), 0);
    },
    async openProjectTerminal(projectPath: string, projectName: string, agentId?: string, resumeMode?: boolean, sessionId?: string, profileEnv?: Record<string, string>) {
      const agent = agentId || 'claude';

      // Resolve agent info via API — get correct cliCmd, cliType, supportsSession
      let agentCmd = 'claude';
      let supportsSession = true;
      let agentSkipFlag = '';
      try {
        const resolveRes = await fetch(`/api/agents?resolve=${encodeURIComponent(agent)}`);
        const info = await resolveRes.json();
        agentCmd = info.cliCmd || 'claude';
        supportsSession = info.supportsSession ?? true;
        // Merge profile env if not already provided
        if (!profileEnv && (info.env || info.model)) {
          const pe: Record<string, string> = { ...(info.env || {}) };
          if (info.model) pe.CLAUDE_MODEL = info.model;
          profileEnv = pe;
        }
        // Get skip-permissions flag from agent config
        const agentsRes = await fetch('/api/agents');
        const agentsData = await agentsRes.json();
        const agentConfig = (agentsData.agents || []).find((a: any) => a.id === agent);
        agentSkipFlag = agentConfig?.skipPermissionsFlag || '';
      } catch {}

      // Resume flag: explicit sessionId > fixedSession > -c (only for session-capable agents)
      let resumeFlag = '';
      if (supportsSession) {
        if (sessionId) resumeFlag = ` --resume ${sessionId}`;
        else if (resumeMode) resumeFlag = ' -c';
        // Override with fixedSession if no explicit sessionId
        if (!sessionId && projectPath) {
          try {
            const { resolveFixedSession } = await import('@/lib/session-utils');
            const fixedId = await resolveFixedSession(projectPath);
            if (fixedId) resumeFlag = ` --resume ${fixedId}`;
          } catch {}
        }
      }

      // Model flag from profile
      const modelFlag = profileEnv?.CLAUDE_MODEL ? ` --model ${profileEnv.CLAUDE_MODEL}` : '';

      // Build env exports from profile (exclude CLAUDE_MODEL — passed via --model)
      const envExports = profileEnv
        ? Object.entries(profileEnv)
            .filter(([k]) => k !== 'CLAUDE_MODEL')
            .map(([k, v]) => `export ${k}="${v}"`)
            .join(' && ')
        : '';
      const envPrefix = envExports ? envExports + ' && ' : '';

      // Skip-permissions flag
      let sf = '';
      if (skipPermissions) {
        sf = agentSkipFlag ? ` ${agentSkipFlag}` : (agentCmd === 'claude' ? ' --dangerously-skip-permissions' : '');
      }

      // MCP config for claude-code agents
      let mcpFlag = '';
      if (agentCmd === 'claude' && projectPath) {
        try { const { getMcpFlag } = await import('@/lib/session-utils'); mcpFlag = await getMcpFlag(projectPath); } catch {}
      }

      let targetTabId: number | null = null;

      setTabs(prev => {
        // Reuse existing tab only if same project AND same agent
        const existing = prev.find(t => t.projectPath === projectPath && (!t.agent || t.agent === agent));
        if (existing) {
          targetTabId = existing.id;
          return prev;
        }
        const tree = makeTerminal(undefined, projectPath);
        const paneId = firstTerminalId(tree);
        pendingCommands.set(paneId, `${envPrefix}cd "${projectPath}" && ${agentCmd}${resumeFlag}${modelFlag}${sf}${mcpFlag}\n`);
        const newTab: TabState = {
          id: nextId++,
          label: agent !== 'claude' ? `${projectName} (${agentCmd})` : projectName,
          tree,
          ratios: {},
          activeId: paneId,
          projectPath,
          agent,
        };
        targetTabId = newTab.id;
        return [...prev, newTab];
      });

      // Set active tab after React processes the state update
      setTimeout(() => {
        if (targetTabId !== null) setActiveTabId(targetTabId);
      }, 0);
    },
  }), [skipPermissions]);

  // ─── Tab operations ───────────────────────────────────

  const addTab = useCallback((projectPath?: string) => {
    const tree = makeTerminal(undefined, projectPath);
    const tabNum = tabs.length + 1;
    const label = projectPath ? projectPath.split('/').pop() || `Terminal ${tabNum}` : `Terminal ${tabNum}`;
    const newTab: TabState = { id: nextId++, label, tree, ratios: {}, activeId: firstTerminalId(tree), projectPath };
    setTabs(prev => [...prev, newTab]);
    setActiveTabId(newTab.id);
  }, [tabs.length]);

  const removeTab = useCallback((tabId: number) => {
    setTabs(prev => {
      if (prev.length <= 1) return prev;
      const filtered = prev.filter(t => t.id !== tabId);
      // Also fix activeTabId if needed
      setActiveTabId(curActive => {
        if (curActive === tabId) {
          const idx = prev.findIndex(t => t.id === tabId);
          const next = prev[idx - 1] || prev[idx + 1];
          return next?.id || prev[0]?.id || 0;
        }
        return curActive;
      });
      return filtered;
    });
  }, []);

  const closeTab = useCallback((tabId: number) => {
    setTabs(prev => {
      const tab = prev.find(t => t.id === tabId);
      if (!tab) return prev;
      const sessions = collectSessionNames(tab.tree);
      if (sessions.length > 0) {
        setCloseConfirm({ tabId, sessions });
        return prev; // don't remove yet, show dialog
      }
      // No sessions, just close directly
      if (prev.length <= 1) return prev;
      const filtered = prev.filter(t => t.id !== tabId);
      setActiveTabId(curActive => {
        if (curActive === tabId) {
          const idx = prev.findIndex(t => t.id === tabId);
          const next = prev[idx - 1] || prev[idx + 1];
          return next?.id || prev[0]?.id || 0;
        }
        return curActive;
      });
      return filtered;
    });
  }, []);

  const closeTabWithAction = useCallback((action: 'detach' | 'kill') => {
    if (!closeConfirm) return;
    const { tabId, sessions } = closeConfirm;
    if (action === 'kill') {
      for (const sn of sessions) {
        const ws = new WebSocket(getWsUrl());
        ws.onopen = () => {
          ws.send(JSON.stringify({ type: 'kill', sessionName: sn }));
          setTimeout(() => ws.close(), 500);
        };
      }
    }
    removeTab(tabId);
    setCloseConfirm(null);
  }, [closeConfirm, removeTab]);

  const moveTab = useCallback((fromId: number, toId: number) => {
    if (fromId === toId) return;
    setTabs(prev => {
      const fromIdx = prev.findIndex(t => t.id === fromId);
      const toIdx = prev.findIndex(t => t.id === toId);
      if (fromIdx < 0 || toIdx < 0) return prev;
      const next = [...prev];
      const [moved] = next.splice(fromIdx, 1);
      next.splice(toIdx, 0, moved);
      return next;
    });
  }, []);

  const renameTab = useCallback((tabId: number, newLabel: string) => {
    const label = newLabel.trim();
    if (!label) return;
    setTabs(prev => {
      const tab = prev.find(t => t.id === tabId);
      if (tab) {
        const sessions = collectSessionNames(tab.tree);
        for (const sn of sessions) {
          sessionLabelsRef.current[sn] = label;
        }
      }
      return prev.map(t => t.id === tabId ? { ...t, label } : t);
    });
    setEditingTabId(null);
  }, []);

  // ─── Update active tab's state ─────────────────────────

  const updateActiveTab = useCallback((updater: (tab: TabState) => TabState) => {
    setTabs(prev => prev.map(t => t.id === activeTabId ? updater(t) : t));
  }, [activeTabId]);

  const onSessionConnected = useCallback((paneId: number, sessionName: string) => {
    stateLoadedRef.current = true; // Allow saving once a session is connected
    setTabs(prev => prev.map(t => ({
      ...t,
      tree: updateSessionName(t.tree, paneId, sessionName),
    })));
  }, []);

  const refreshSessions = useCallback(() => {
    // Use a short-lived WS to list sessions, with abort guard
    let closed = false;
    const ws = new WebSocket(getWsUrl());
    const timeout = setTimeout(() => { closed = true; ws.close(); }, 3000);
    ws.onopen = () => {
      if (closed) return;
      ws.send(JSON.stringify({ type: 'list' }));
    };
    ws.onmessage = (e) => {
      clearTimeout(timeout);
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'sessions') setTmuxSessions(msg.sessions);
      } catch {}
      ws.close();
    };
    ws.onerror = () => { clearTimeout(timeout); ws.close(); };
  }, []);

  const onSplit = useCallback((dir: 'horizontal' | 'vertical') => {
    if (!activeTab) return;
    updateActiveTab(t => ({ ...t, tree: splitNodeById(t.tree, t.activeId, dir) }));
  }, [activeTab, updateActiveTab]);

  const onClosePane = useCallback(() => {
    if (!activeTab) return;
    updateActiveTab(t => {
      if (countTerminals(t.tree) <= 1) return t;
      const newTree = removeNodeById(t.tree, t.activeId) || t.tree;
      return { ...t, tree: newTree, activeId: firstTerminalId(newTree) };
    });
  }, [activeTab, updateActiveTab]);

  const closePaneById = useCallback((id: number) => {
    updateActiveTab(t => {
      if (countTerminals(t.tree) <= 1) return t;
      const newTree = removeNodeById(t.tree, id) || t.tree;
      const newActiveId = t.activeId === id ? firstTerminalId(newTree) : t.activeId;
      return { ...t, tree: newTree, activeId: newActiveId };
    });
  }, [updateActiveTab]);

  const setActiveId = useCallback((id: number) => {
    updateActiveTab(t => ({ ...t, activeId: id }));
  }, [updateActiveTab]);

  const setRatios = useCallback((updater: React.SetStateAction<Record<number, number>>) => {
    updateActiveTab(t => ({
      ...t,
      ratios: typeof updater === 'function' ? updater(t.ratios) : updater,
    }));
  }, [updateActiveTab]);

  const usedSessions = collectAllSessionNames(tabs);

  // Toggle bell for a tab
  const toggleBell = useCallback((tabId: number) => {
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      Notification.requestPermission();
    }
    setTabs(prev => prev.map(t => t.id === tabId ? { ...t, bellEnabled: !t.bellEnabled } : t));
  }, []);

  // Sync bell state to module-level sets for MemoTerminalPane to read
  useEffect(() => {
    bellEnabledPanes.clear();
    bellPaneLabels.clear();
    for (const tab of tabs) {
      if (tab.bellEnabled) {
        const paneIds = collectPaneIds(tab.tree);
        for (const id of paneIds) {
          bellEnabledPanes.add(id);
          bellPaneLabels.set(id, tab.label);
        }
      }
    }
  }, [tabs]);

  // Auto-refresh tmux sessions periodically to show detached count
  useEffect(() => {
    if (!hydrated) return;
    refreshSessions();
    const timer = setInterval(refreshSessions, 10000);
    return () => clearInterval(timer);
  }, [hydrated, refreshSessions]);

  const detachedCount = tmuxSessions.filter(s => !usedSessions.includes(s.name)).length;

  return (
    <div className="h-full w-full flex-1 flex flex-col bg-[var(--term-bg)] overflow-hidden">
      {/* Tab bar + toolbar */}
      <div className="flex items-center bg-[var(--term-bar)] border-b border-[var(--term-border)] shrink-0">
        {/* Tabs */}
        <div className="flex items-center overflow-x-auto">
          {tabs.map(tab => (
            <div
              key={tab.id}
              draggable={editingTabId !== tab.id}
              onDragStart={(e) => {
                dragTabRef.current = tab.id;
                e.dataTransfer.effectAllowed = 'move';
                // Make drag image semi-transparent
                if (e.currentTarget instanceof HTMLElement) {
                  e.dataTransfer.setDragImage(e.currentTarget, 0, 0);
                }
              }}
              onDragOver={(e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (dragTabRef.current !== null) {
                  moveTab(dragTabRef.current, tab.id);
                  dragTabRef.current = null;
                }
              }}
              onDragEnd={() => { dragTabRef.current = null; }}
              className={`flex items-center gap-1 px-3 py-1 text-[11px] cursor-pointer border-r border-[var(--term-border)] select-none ${
                tab.id === activeTabId
                  ? 'bg-[var(--term-bg)] text-white'
                  : 'text-gray-500 hover:text-gray-300 hover:bg-[var(--term-bg)]/50'
              }`}
              onClick={() => setActiveTabId(tab.id)}
            >
              {editingTabId === tab.id ? (
                <input
                  autoFocus
                  value={editingLabel}
                  onChange={(e) => setEditingLabel(e.target.value)}
                  onBlur={() => renameTab(tab.id, editingLabel)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') renameTab(tab.id, editingLabel);
                    if (e.key === 'Escape') setEditingTabId(null);
                  }}
                  onClick={(e) => e.stopPropagation()}
                  className="bg-transparent border border-[var(--term-border)] rounded px-1 text-[11px] text-white outline-none w-20"
                />
              ) : (
                <span
                  className="truncate max-w-[100px]"
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    setEditingTabId(tab.id);
                    setEditingLabel(tab.label);
                  }}
                >
                  {tab.label}
                </span>
              )}
              {tab.agent && tab.agent !== 'claude' && (
                <span className="text-[8px] text-[var(--accent)] ml-0.5">{tab.agent}</span>
              )}
              <button
                onClick={(e) => { e.stopPropagation(); toggleBell(tab.id); }}
                className={`text-[10px] ml-1 ${tab.bellEnabled ? 'text-yellow-400' : 'text-gray-600 hover:text-gray-400'}`}
                title={tab.bellEnabled ? 'Disable notification' : 'Enable notification when idle'}
              >{tab.bellEnabled ? '🔔' : '🔕'}</button>
              {tabs.length > 1 && (
                <button
                  onClick={(e) => { e.stopPropagation(); closeTab(tab.id); }}
                  className="text-[9px] text-gray-600 hover:text-red-400 ml-1"
                >
                  x
                </button>
              )}
            </div>
          ))}
          <button
            onClick={() => {
              setShowNewTabModal(true);
              setSelectedAgent('');
              // Refresh projects + agents when opening modal
              fetch('/api/projects').then(r => r.json())
                .then((p: { name: string; path: string; root: string }[]) => {
                  if (!Array.isArray(p)) return;
                  setAllProjects(p);
                  setProjectRoots([...new Set(p.map(proj => proj.root))]);
                })
                .catch(() => {});
              fetch('/api/agents').then(r => r.json())
                .then(data => {
                  setAvailableAgents((data.agents || []).filter((a: any) => a.enabled));
                  setDefaultAgentId(data.defaultAgent || 'claude');
                })
                .catch(() => {});
            }}
            className="px-2 py-1 text-[11px] text-gray-500 hover:text-white hover:bg-[var(--term-border)]"
            title="New tab"
          >
            +
          </button>
        </div>

        {/* Toolbar */}
        <div className="flex items-center gap-1 px-2 ml-auto">
          <MouseToggle />
          <button onClick={() => onSplit('vertical')} className="text-[10px] px-2 py-0.5 text-gray-400 hover:text-white hover:bg-[var(--term-border)] rounded">
            Split Right
          </button>
          <button onClick={() => onSplit('horizontal')} className="text-[10px] px-2 py-0.5 text-gray-400 hover:text-white hover:bg-[var(--term-border)] rounded">
            Split Down
          </button>
          <button
            onClick={() => { refreshSessions(); setShowSessionPicker(v => !v); }}
            className={`text-[10px] px-2 py-0.5 rounded relative ${showSessionPicker ? 'text-white bg-[#7c5bf0]/30' : 'text-gray-400 hover:text-white hover:bg-[var(--term-border)]'}`}
          >
            Sessions
            {detachedCount > 0 && (
              <span className="ml-1 inline-flex items-center justify-center min-w-[14px] h-[14px] rounded-full bg-yellow-500/80 text-[8px] text-black font-bold px-1">
                {detachedCount}
              </span>
            )}
          </button>
          <button
            onClick={() => {
              if (!activeTab) return;
              setRefreshKeys(prev => ({ ...prev, [activeTab.activeId]: (prev[activeTab.activeId] || 0) + 1 }));
            }}
            className="text-[11px] px-3 py-1 text-black bg-yellow-400 hover:bg-yellow-300 rounded font-bold"
            title="Refresh terminal (fix garbled display)"
          >
            Refresh
          </button>
          {onCodeOpenChange && activeTab && (
            <button
              onClick={() => {
                const current = tabCodeOpen[activeTab.id] ?? false;
                const next = !current;
                setTabCodeOpen(prev => ({ ...prev, [activeTab.id]: next }));
                onCodeOpenChange(next);
              }}
              className={`text-[11px] px-3 py-1 rounded font-bold ${(tabCodeOpen[activeTab.id] ?? false) ? 'text-white bg-red-500 hover:bg-red-400' : 'text-red-400 border border-red-500 hover:bg-red-500 hover:text-white'}`}
              title={(tabCodeOpen[activeTab.id] ?? false) ? 'Hide code panel' : 'Show code panel'}
            >
              Code
            </button>
          )}
        </div>
      </div>

      {/* Session management panel */}
      {showSessionPicker && (
        <div className="bg-[var(--term-bar)] border-b border-[var(--term-border)] px-3 py-2 shrink-0 max-h-48 overflow-y-auto">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[10px] text-gray-400 font-semibold uppercase">Tmux Sessions</span>
            <button
              onClick={refreshSessions}
              className="text-[9px] text-gray-500 hover:text-white"
            >
              Refresh
            </button>
          </div>
          {tmuxSessions.length === 0 ? (
            <p className="text-[10px] text-gray-500">No persistent sessions. New terminals auto-create tmux sessions.</p>
          ) : (
            <table className="w-full text-[10px]">
              <thead>
                <tr className="text-gray-500 text-left border-b border-[var(--term-border)]">
                  <th className="py-1 pr-3 font-medium">Session</th>
                  <th className="py-1 pr-3 font-medium">Created</th>
                  <th className="py-1 pr-3 font-medium">Status</th>
                  <th className="py-1 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {tmuxSessions.map(s => {
                  const inUse = usedSessions.includes(s.name);
                  const savedLabel = sessionLabelsRef.current[s.name];
                  return (
                    <tr key={s.name} className="border-b border-[var(--term-border)]/50 hover:bg-[var(--term-bg)]">
                      <td className="py-1.5 pr-3 text-gray-300">
                        {savedLabel ? (
                          <><span>{savedLabel}</span> <span className="font-mono text-gray-600 text-[9px]">{s.name.replace('mw-', '')}</span></>
                        ) : (
                          <span className="font-mono">{s.name.replace('mw-', '')}</span>
                        )}
                      </td>
                      <td className="py-1.5 pr-3 text-gray-500">{new Date(s.created).toLocaleString()}</td>
                      <td className="py-1.5 pr-3">
                        {inUse ? (
                          <span className="text-green-400">● connected</span>
                        ) : (
                          <span className="text-yellow-500">○ detached</span>
                        )}
                      </td>
                      <td className="py-1.5 text-right space-x-2">
                        {!inUse && (
                          <button
                            onClick={() => {
                              // Open in a new tab, restore saved label if available
                              const tree = makeTerminal(s.name);
                              const label = sessionLabelsRef.current[s.name] || s.name.replace('mw-', '');
                              const newTab: TabState = { id: nextId++, label, tree, ratios: {}, activeId: firstTerminalId(tree) };
                              setTabs(prev => [...prev, newTab]);
                              setActiveTabId(newTab.id);
                              setShowSessionPicker(false);
                            }}
                            className="text-[#7c5bf0] hover:text-white"
                          >
                            Attach
                          </button>
                        )}
                        <button
                          onClick={() => {
                            if (!confirm(`Kill session ${s.name}?`)) return;
                            const ws = new WebSocket(getWsUrl());
                            ws.onopen = () => {
                              ws.send(JSON.stringify({ type: 'kill', sessionName: s.name }));
                              setTimeout(() => { ws.close(); refreshSessions(); }, 500);
                            };
                          }}
                          className="text-red-400/60 hover:text-red-400"
                        >
                          Kill
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* New tab modal */}
      {showNewTabModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => { setShowNewTabModal(false); setExpandedRoot(null); }}>
          <div className="bg-[var(--term-bg)] border border-[var(--term-border)] rounded-lg shadow-xl w-[350px] max-h-[70vh] flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="px-4 py-3 border-b border-[var(--term-border)]">
              <h3 className="text-sm font-semibold text-white">New Tab</h3>
            </div>
            <div className="flex-1 overflow-y-auto p-2">
              {/* Plain terminal */}
              <button
                onClick={() => { addTab(); setShowNewTabModal(false); setExpandedRoot(null); }}
                className="w-full text-left px-3 py-2 rounded hover:bg-[var(--term-border)] text-[12px] text-gray-300 flex items-center gap-2"
              >
                <span className="text-gray-500">▸</span> Terminal (no agent)
              </button>

              {/* Project roots */}
              {projectRoots.length > 0 && (
                <div className="mt-2 pt-2 border-t border-[var(--term-border)]">
                  <div className="px-3 py-1 text-[9px] text-gray-500 uppercase">Agent in Project</div>
                  {projectRoots.map(root => {
                    const rootName = root.split('/').pop() || root;
                    const isExpanded = expandedRoot === root;
                    const rootProjects = allProjects.filter(p => p.root === root);
                    return (
                      <div key={root}>
                        <button
                          onClick={() => setExpandedRoot(isExpanded ? null : root)}
                          className="w-full text-left px-3 py-2 rounded hover:bg-[var(--term-border)] text-[12px] text-gray-300 flex items-center gap-2"
                        >
                          <span className="text-gray-500 text-[10px] w-3">{isExpanded ? '▾' : '▸'}</span>
                          <span>{rootName}</span>
                          <span className="text-[9px] text-gray-600 ml-auto">{rootProjects.length}</span>
                        </button>
                        {isExpanded && (
                          <div className="ml-4">
                            {rootProjects.map(p => (
                              <div key={p.path} className="flex items-center gap-1 px-3 py-1.5 rounded hover:bg-[var(--term-border)]/50 text-[11px]" title={p.path}>
                                <span className="text-gray-600 text-[10px]">↳</span>
                                <span className="text-gray-300 truncate">{p.name}</span>
                                <AgentButtons
                                  agents={availableAgents}
                                  defaultAgentId={defaultAgentId}
                                  onSelect={async (a) => {
                                    setShowNewTabModal(false); setExpandedRoot(null);
                                    try {
                                      const resolveRes = await fetch(`/api/agents?resolve=${encodeURIComponent(a.id)}`);
                                      const info = await resolveRes.json();
                                      const profileEnv: Record<string, string> = { ...(info.env || {}) };
                                      if (info.model) profileEnv.CLAUDE_MODEL = info.model;
                                      let currentSessionId: string | null = null;
                                      if (info.supportsSession) {
                                        try {
                                          const { resolveFixedSession } = await import('@/lib/session-utils');
                                          currentSessionId = await resolveFixedSession(p.path) || null;
                                        } catch {}
                                      }
                                      setVibePickerInfo({
                                        projectPath: p.path, projectName: p.name, agentId: a.id,
                                        profileEnv: Object.keys(profileEnv).length > 0 ? profileEnv : undefined,
                                        supportsSession: info.supportsSession ?? true,
                                        currentSessionId,
                                      });
                                    } catch {
                                      // Fallback: open directly without picker
                                      window.dispatchEvent(new CustomEvent('forge:open-terminal', {
                                        detail: { projectPath: p.path, projectName: p.name, agentId: a.id },
                                      }));
                                    }
                                  }}
                                />
                              </div>
                            ))}
                            {rootProjects.length === 0 && (
                              <div className="px-3 py-1.5 text-[10px] text-gray-600">No projects</div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
            <div className="px-4 py-2 border-t border-[var(--term-border)]">
              <button
                onClick={() => { setShowNewTabModal(false); setExpandedRoot(null); }}
                className="w-full text-center text-[11px] text-gray-500 hover:text-gray-300 py-1"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Close confirmation dialog */}
      {closeConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setCloseConfirm(null)}>
          <div className="bg-[var(--term-bg)] border border-[var(--term-border)] rounded-lg p-4 shadow-xl max-w-sm" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-sm font-semibold text-white mb-2">Close Tab</h3>
            <p className="text-xs text-gray-400 mb-1">
              This tab has {closeConfirm.sessions.length} active session{closeConfirm.sessions.length > 1 ? 's' : ''}:
            </p>
            <div className="text-[10px] text-gray-500 font-mono mb-3 space-y-0.5">
              {closeConfirm.sessions.map(s => (
                <div key={s}>• {s.replace('mw-', '')}</div>
              ))}
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => closeTabWithAction('detach')}
                className="flex-1 px-3 py-1.5 text-[11px] rounded bg-[#2a2a4a] text-gray-300 hover:bg-[#3a3a5a] hover:text-white"
              >
                Hide Tab
                <span className="block text-[9px] text-gray-500 mt-0.5">Session keeps running</span>
              </button>
              <button
                onClick={() => closeTabWithAction('kill')}
                className="flex-1 px-3 py-1.5 text-[11px] rounded bg-red-500/20 text-red-400 hover:bg-red-500/30"
              >
                Kill Session
                <span className="block text-[9px] text-red-400/60 mt-0.5">Permanently close</span>
              </button>
            </div>
            <button
              onClick={() => setCloseConfirm(null)}
              className="w-full mt-2 px-3 py-1 text-[10px] text-gray-500 hover:text-gray-300"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* VibeCoding Terminal Session Picker */}
      {vibePickerInfo && (
        <TerminalSessionPickerLazy
          agentLabel={vibePickerInfo.projectName}
          currentSessionId={vibePickerInfo.currentSessionId}
          supportsSession={vibePickerInfo.supportsSession}
          fetchSessions={() => fetchProjectSessions(vibePickerInfo.projectName)}
          onSelect={(sel) => {
            const info = vibePickerInfo;
            setVibePickerInfo(null);
            const detail: any = { projectPath: info.projectPath, projectName: info.projectName, agentId: info.agentId, profileEnv: info.profileEnv };
            if (sel.mode !== 'new') { detail.resumeMode = true; detail.sessionId = sel.sessionId; }
            window.dispatchEvent(new CustomEvent('forge:open-terminal', { detail }));
          }}
          onCancel={() => setVibePickerInfo(null)}
        />
      )}

      {/* Terminal panes — render all tabs, hide inactive */}
      {tabs.map(tab => (
        <div key={tab.id} className={`flex-1 min-h-0 ${tab.id === activeTabId ? '' : 'hidden'}`}>
          <PaneRenderer
            node={tab.tree}
            activeId={tab.activeId}
            onFocus={tab.id === activeTabId ? setActiveId : () => {}}
            ratios={tab.ratios}
            setRatios={tab.id === activeTabId ? setRatios : () => {}}
            onSessionConnected={onSessionConnected}
            refreshKeys={refreshKeys}
            skipPermissions={skipPermissions}
            canClose={countTerminals(tab.tree) > 1}
            onClosePane={tab.id === activeTabId ? closePaneById : undefined}
          />
        </div>
      ))}
    </div>
  );
});

export default WebTerminal;

// ─── Pane renderer ───────────────────────────────────────────

// ─── Agent shortcut buttons (inline with project name) ──────

function AgentButtons({ agents, defaultAgentId, onSelect }: {
  agents: { id: string; name: string; detected?: boolean }[];
  defaultAgentId: string;
  onSelect: (agent: { id: string; name: string }) => void;
}) {
  const [showMore, setShowMore] = useState(false);
  const MAX_INLINE = 3;

  const getAbbr = (id: string) =>
    id === 'claude' ? 'C' : id === 'codex' ? 'X' : id === 'aider' ? 'A' : id.charAt(0).toUpperCase();

  const btnClass = (id: string, detected?: boolean) => {
    if (detected === false) return 'w-5 h-5 flex items-center justify-center rounded text-[9px] font-bold bg-gray-800/50 text-gray-600 cursor-not-allowed';
    if (id === defaultAgentId) return 'w-5 h-5 flex items-center justify-center rounded text-[9px] font-bold bg-green-500/30 text-green-400 hover:bg-green-500 hover:text-white';
    return 'w-5 h-5 flex items-center justify-center rounded text-[9px] font-bold bg-green-900/30 text-green-300/70 hover:bg-green-700/50 hover:text-green-200';
  };

  const inline = agents.slice(0, MAX_INLINE);
  const overflow = agents.slice(MAX_INLINE);

  return (
    <div className="flex items-center gap-0.5 ml-auto shrink-0 relative">
      {inline.map(a => (
        <button
          key={a.id}
          title={a.detected === false ? `${a.name} (not installed)` : `Open with ${a.name}`}
          onClick={() => { if (a.detected !== false) onSelect(a); }}
          className={btnClass(a.id, a.detected)}
        >
          {getAbbr(a.id)}
        </button>
      ))}
      {overflow.length > 0 && (
        <>
          <button
            title="More agents"
            onClick={(e) => { e.stopPropagation(); setShowMore(v => !v); }}
            className="w-5 h-5 flex items-center justify-center rounded text-[9px] bg-gray-700/50 text-gray-400 hover:bg-gray-600 hover:text-white"
          >…</button>
          {showMore && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setShowMore(false)} />
              <div className="absolute right-0 top-6 z-50 bg-[var(--term-bg)] border border-[var(--term-border)] rounded shadow-lg py-1 min-w-[120px]">
                {overflow.map(a => (
                  <button
                    key={a.id}
                    onClick={() => { if (a.detected !== false) { setShowMore(false); onSelect(a); } }}
                    className={`w-full text-left px-3 py-1 text-[10px] flex items-center gap-2 ${a.detected === false ? 'text-gray-600 cursor-not-allowed' : 'text-gray-300 hover:bg-[var(--term-border)]'}`}
                  >
                    <span className={btnClass(a.id, a.detected) + ' w-4 h-4 text-[8px]'}>{getAbbr(a.id)}</span>
                    {a.name} {a.detected === false ? '(not installed)' : ''}
                  </button>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

function PaneRenderer({
  node, activeId, onFocus, ratios, setRatios, onSessionConnected, refreshKeys, skipPermissions, canClose, onClosePane,
}: {
  node: SplitNode;
  activeId: number;
  onFocus: (id: number) => void;
  ratios: Record<number, number>;
  setRatios: React.Dispatch<React.SetStateAction<Record<number, number>>>;
  onSessionConnected: (paneId: number, sessionName: string) => void;
  refreshKeys: Record<number, number>;
  skipPermissions?: boolean;
  canClose?: boolean;
  onClosePane?: (id: number) => void;
}) {
  if (node.type === 'terminal') {
    return (
      <div className={`h-full w-full relative group/pane ${activeId === node.id ? 'ring-1 ring-[#7c5bf0]/50 ring-inset' : ''}`} onMouseDown={() => onFocus(node.id)}>
        <MemoTerminalPane key={`${node.id}-${refreshKeys[node.id] || 0}`} id={node.id} sessionName={node.sessionName} projectPath={node.projectPath} skipPermissions={skipPermissions} onSessionConnected={onSessionConnected} />
        {canClose && onClosePane && (
          <button
            onClick={(e) => { e.stopPropagation(); if (confirm('Close this pane?')) onClosePane(node.id); }}
            className="absolute top-1.5 right-1.5 z-10 w-6 h-6 flex items-center justify-center rounded bg-red-500/80 text-white hover:bg-red-500 opacity-0 group-hover/pane:opacity-100 transition-opacity text-xs font-bold shadow"
            title="Close this pane"
          >✕</button>
        )}
      </div>
    );
  }

  const ratio = ratios[node.id] ?? node.ratio;

  return (
    <DraggableSplit splitId={node.id} direction={node.direction} ratio={ratio} setRatios={setRatios}>
      <PaneRenderer node={node.first} activeId={activeId} onFocus={onFocus} ratios={ratios} setRatios={setRatios} onSessionConnected={onSessionConnected} refreshKeys={refreshKeys} skipPermissions={skipPermissions} canClose={canClose} onClosePane={onClosePane} />
      <PaneRenderer node={node.second} activeId={activeId} onFocus={onFocus} ratios={ratios} setRatios={setRatios} onSessionConnected={onSessionConnected} refreshKeys={refreshKeys} skipPermissions={skipPermissions} canClose={canClose} onClosePane={onClosePane} />
    </DraggableSplit>
  );
}

// ─── Draggable split — uses pointer capture for reliable drag ─

function DraggableSplit({
  splitId, direction, ratio, setRatios, children,
}: {
  splitId: number;
  direction: 'horizontal' | 'vertical';
  ratio: number;
  setRatios: React.Dispatch<React.SetStateAction<Record<number, number>>>;
  children: [React.ReactNode, React.ReactNode];
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const firstRef = useRef<HTMLDivElement>(null);
  const secondRef = useRef<HTMLDivElement>(null);
  const dividerRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const ratioRef = useRef(ratio);
  const isVert = direction === 'vertical';

  // Keep ref in sync — avoid re-registering listeners on every ratio change
  ratioRef.current = ratio;

  // Apply ratio to DOM (only when not dragging — drag updates imperatively)
  useEffect(() => {
    if (draggingRef.current) return;
    if (!firstRef.current || !secondRef.current) return;
    const prop = isVert ? 'width' : 'height';
    firstRef.current.style[prop] = `calc(${ratio * 100}% - 4px)`;
    secondRef.current.style[prop] = `calc(${(1 - ratio) * 100}% - 4px)`;
  }, [ratio, isVert]);

  // Pointer capture drag — registered once, uses refs
  useEffect(() => {
    const divider = dividerRef.current;
    const container = containerRef.current;
    const first = firstRef.current;
    const second = secondRef.current;
    if (!divider || !container || !first || !second) return;

    const vertical = isVert;
    const prop = vertical ? 'width' : 'height';
    let lastRatio = ratioRef.current;

    const onPointerDown = (e: PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      divider.setPointerCapture(e.pointerId);
      draggingRef.current = true;
      globalDragging = true;
      lastRatio = ratioRef.current;
      document.body.style.cursor = vertical ? 'col-resize' : 'row-resize';
      document.body.style.userSelect = 'none';
    };

    const onPointerMove = (e: PointerEvent) => {
      if (!draggingRef.current) return;
      const rect = container.getBoundingClientRect();
      let r = vertical
        ? (e.clientX - rect.left) / rect.width
        : (e.clientY - rect.top) / rect.height;
      r = Math.max(0.1, Math.min(0.9, r));
      lastRatio = r;
      // Imperative DOM update — no React re-render during drag
      first.style[prop] = `calc(${r * 100}% - 4px)`;
      second.style[prop] = `calc(${(1 - r) * 100}% - 4px)`;
    };

    const onPointerUp = () => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      globalDragging = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      // Commit final ratio to React state (single re-render)
      setRatios(prev => ({ ...prev, [splitId]: lastRatio }));
      // Trigger a global resize so all terminals fit() once after drag ends
      window.dispatchEvent(new Event('terminal-drag-end'));
    };

    divider.addEventListener('pointerdown', onPointerDown);
    divider.addEventListener('pointermove', onPointerMove);
    divider.addEventListener('pointerup', onPointerUp);
    divider.addEventListener('lostpointercapture', onPointerUp);

    return () => {
      divider.removeEventListener('pointerdown', onPointerDown);
      divider.removeEventListener('pointermove', onPointerMove);
      divider.removeEventListener('pointerup', onPointerUp);
      divider.removeEventListener('lostpointercapture', onPointerUp);
    };
    // Only re-register if direction or splitId changes (not on every ratio change)
  }, [isVert, splitId, setRatios]);

  return (
    <div ref={containerRef} className="h-full w-full" style={{ display: 'flex', flexDirection: isVert ? 'row' : 'column' }}>
      <div ref={firstRef} style={{ minWidth: 0, minHeight: 0, overflow: 'hidden', [isVert ? 'width' : 'height']: `calc(${ratio * 100}% - 4px)` }}>
        {children[0]}
      </div>
      <div
        ref={dividerRef}
        className={`shrink-0 ${isVert ? 'w-2 cursor-col-resize' : 'h-2 cursor-row-resize'} bg-[#2a2a4a] hover:bg-[#7c5bf0] active:bg-[#7c5bf0] transition-colors`}
        style={{ touchAction: 'none', zIndex: 10 }}
      />
      <div ref={secondRef} style={{ minWidth: 0, minHeight: 0, overflow: 'hidden', [isVert ? 'width' : 'height']: `calc(${(1 - ratio) * 100}% - 4px)` }}>
        {children[1]}
      </div>
    </div>
  );
}

// ─── Terminal pane with tmux session support ──────────────────

const MemoTerminalPane = memo(function TerminalPane({
  id,
  sessionName,
  projectPath,
  skipPermissions,
  onSessionConnected,
}: {
  id: number;
  sessionName?: string;
  projectPath?: string;
  skipPermissions?: boolean;
  onSessionConnected: (paneId: number, sessionName: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const sessionNameRef = useRef(sessionName);
  sessionNameRef.current = sessionName;
  const projectPathRef = useRef(projectPath);
  const skipPermRef = useRef(skipPermissions);
  skipPermRef.current = skipPermissions;
  projectPathRef.current = projectPath;

  useEffect(() => {
    if (!containerRef.current) return;

    let disposed = false; // guard against post-cleanup writes (React Strict Mode)
    let bellArmed = false; // armed after user presses Enter
    let bellNewBytes = 0;
    let bellIdleTimer = 0;
    let bellArmedAt = 0; // timestamp when armed

    // Read terminal theme from CSS variables
    const cs = getComputedStyle(document.documentElement);
    const tv = (name: string) => cs.getPropertyValue(name).trim();
    const termBg = tv('--term-bg') || '#1a1a2e';
    const termFg = tv('--term-fg') || '#e0e0e0';
    const termCursor = tv('--term-cursor') || '#7c5bf0';
    const isLight = document.documentElement.getAttribute('data-theme') === 'light';

    const term = new Terminal({
      allowProposedApi: true,
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      scrollback: 10000,
      logger: { trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      theme: isLight ? {
        background: termBg,
        foreground: termFg,
        cursor: termCursor,
        selectionBackground: termCursor + '44',
        black: '#1a1a1a',
        red: '#d32f2f',
        green: '#388e3c',
        yellow: '#f57f17',
        blue: '#1976d2',
        magenta: '#7b1fa2',
        cyan: '#0097a7',
        white: '#424242',
        brightBlack: '#757575',
        brightRed: '#e53935',
        brightGreen: '#43a047',
        brightYellow: '#f9a825',
        brightBlue: '#1e88e5',
        brightMagenta: '#8e24aa',
        brightCyan: '#00acc1',
        brightWhite: '#1a1a1a',
      } : {
        background: termBg,
        foreground: termFg,
        cursor: termCursor,
        selectionBackground: termCursor + '66',
        black: '#1a1a2e',
        red: '#ff6b6b',
        green: '#69db7c',
        yellow: '#ffd43b',
        blue: '#7c5bf0',
        magenta: '#da77f2',
        cyan: '#66d9ef',
        white: '#e0e0e0',
        brightBlack: '#555',
        brightRed: '#ff8787',
        brightGreen: '#8ce99a',
        brightYellow: '#ffe066',
        brightBlue: '#9775fa',
        brightMagenta: '#e599f7',
        brightCyan: '#99e9f2',
        brightWhite: '#ffffff',
      },
    });

    const fit = new FitAddon();
    term.loadAddon(fit);

    // Wait for container to be visible and have stable dimensions before opening
    let initDone = false;
    const el = containerRef.current;

    function initTerminal() {
      if (initDone || disposed || !el) return;
      // Don't init if inside a hidden tab or too small
      if (el.closest('.hidden') || el.offsetWidth < 50 || el.offsetHeight < 30) return;
      initDone = true;
      term.open(el);
      // WebGL: GPU-accelerated rendering with canvas fallback
      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => webgl.dispose());
        term.loadAddon(webgl);
      } catch {}
      // Unicode 11: correct width for CJK characters
      try {
        const unicode11 = new Unicode11Addon();
        term.loadAddon(unicode11);
        term.unicode.activeVersion = '11';
      } catch {}
      // Search: Ctrl/Cmd+F to find text in terminal buffer
      try {
        const search = new SearchAddon();
        term.loadAddon(search);
        searchAddonRef.current = search;
      } catch {}
      try { fit.fit(); } catch {}
      connect();
    }

    // Try immediately, then observe for visibility changes
    requestAnimationFrame(() => {
      if (disposed) return;
      initTerminal();
    });

    // If not visible yet (hidden tab), use IntersectionObserver to detect when it becomes visible
    const visObserver = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting) {
        initTerminal();
      }
    });
    visObserver.observe(el);

    // ── WebSocket with auto-reconnect ──

    const wsUrl = getWsUrl();
    let ws: WebSocket | null = null;
    let reconnectTimer = 0;
    let connectedSession: string | null = null;
    let createRetries = 0;
    const MAX_CREATE_RETRIES = 2;
    let reconnectAttempts = 0;
    let isNewlyCreated = false;

    function connect() {
      if (disposed) return;
      const socket = new WebSocket(wsUrl);
      ws = socket;

      socket.onopen = () => {
        if (disposed) { socket.close(); return; }
        if (socket.readyState !== WebSocket.OPEN) return;
        const cols = term.cols;
        const rows = term.rows;

        if (connectedSession) {
          // Reconnect to the same session
          socket.send(JSON.stringify({ type: 'attach', sessionName: connectedSession, cols, rows }));
        } else {
          const sn = sessionNameRef.current;
          if (sn) {
            socket.send(JSON.stringify({ type: 'attach', sessionName: sn, cols, rows }));
          } else if (createRetries < MAX_CREATE_RETRIES) {
            createRetries++;
            isNewlyCreated = true;
            socket.send(JSON.stringify({ type: 'create', cols, rows }));
          } else {
            term.write('\r\n\x1b[91m[failed to create session — check server logs]\x1b[0m\r\n');
          }
        }
      };

      ws.onmessage = (event) => {
        if (disposed || !initDone) return;
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'output') {
            try { term.write(msg.data); } catch {};
            // Bell: detect claude completion
            // Bell: idle detection after user submits prompt
            if (bellEnabledPanes.has(id) && bellArmed) {
              bellNewBytes += (msg.data as string).length;
              clearTimeout(bellIdleTimer);
              if (bellNewBytes > 2000) {
                // 10s idle = claude finished
                bellIdleTimer = window.setTimeout(() => {
                  bellArmed = false;
                  fireBellNotification(id);
                }, 10000);
                // Fallback: if 90s since armed with activity, force fire
                if (Date.now() - bellArmedAt > 90000) {
                  bellArmed = false;
                  clearTimeout(bellIdleTimer);
                  fireBellNotification(id);
                }
              }
            }
          } else if (msg.type === 'connected') {
            connectedSession = msg.sessionName;
            createRetries = 0;
            reconnectAttempts = 0;
            onSessionConnected(id, msg.sessionName);
            // Auto-run claude for project tabs (only if no pendingCommand already set)
            if (isNewlyCreated && projectPathRef.current && !pendingCommands.has(id)) {
              isNewlyCreated = false;
              const pp = projectPathRef.current;
              import('@/lib/session-utils').then(({ resolveFixedSession, buildResumeFlag, getMcpFlag }) => {
                Promise.all([resolveFixedSession(pp), getMcpFlag(pp)]).then(([fixedId, mcpFlag]) => {
                  const resumeFlag = buildResumeFlag(fixedId, true);
                  const skipFlag = skipPermRef.current ? ' --dangerously-skip-permissions' : '';
                  setTimeout(() => {
                    if (!disposed && ws?.readyState === WebSocket.OPEN) {
                      ws.send(JSON.stringify({ type: 'input', data: `cd "${pp}" && claude${resumeFlag}${skipFlag}${mcpFlag}\n` }));
                    }
                  }, 300);
                });
              });
            }
            isNewlyCreated = false;
            // Force tmux to redraw by toggling size, then send reset
            setTimeout(() => {
              if (disposed || ws?.readyState !== WebSocket.OPEN) return;
              const c = term.cols, r = term.rows;
              ws!.send(JSON.stringify({ type: 'resize', cols: c - 1, rows: r }));
              setTimeout(() => {
                if (disposed || ws?.readyState !== WebSocket.OPEN) return;
                ws!.send(JSON.stringify({ type: 'resize', cols: c, rows: r }));
              }, 50);
            }, 100);
            const cmd = pendingCommands.get(id);
            if (cmd) {
              pendingCommands.delete(id);
              setTimeout(() => {
                if (!disposed && ws?.readyState === WebSocket.OPEN) {
                  ws.send(JSON.stringify({ type: 'input', data: cmd }));
                }
              }, 500);
            }
          } else if (msg.type === 'error') {
            // Session no longer exists — auto-create a new one
            if (!connectedSession && msg.message?.includes('no longer exists') && createRetries < MAX_CREATE_RETRIES) {
              createRetries++;
              isNewlyCreated = true;
              term.write(`\r\n\x1b[93m[${msg.message} — creating new session...]\x1b[0m\r\n`);
              if (socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({ type: 'create', cols: term.cols, rows: term.rows }));
              }
            } else {
              term.write(`\r\n\x1b[93m[${msg.message || 'error'}]\x1b[0m\r\n`);
            }
          } else if (msg.type === 'exit') {
            term.write('\r\n\x1b[90m[session ended]\x1b[0m\r\n');
          }
        } catch {}
      };

      ws.onclose = () => {
        if (disposed) return;
        reconnectAttempts++;
        // Exponential backoff: 2s, 4s, 8s, ... max 30s
        const delay = Math.min(2000 * Math.pow(2, reconnectAttempts - 1), 30000);
        term.write(`\r\n\x1b[90m[disconnected — reconnecting in ${delay / 1000}s...]\x1b[0m\r\n`);
        reconnectTimer = window.setTimeout(connect, delay);
      };

      ws.onerror = () => {
        // onclose will fire after this, triggering reconnect
      };
    }

    // NOTE: connect() is called inside initTerminal() — do NOT call it here.
    // Calling it both here and in initTerminal() causes duplicate WebSocket
    // connections to the same tmux session, resulting in doubled output.

    term.attachCustomKeyEventHandler((event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'f' && event.type === 'keydown') {
        setShowSearch(true);
        setTimeout(() => searchInputRef.current?.focus(), 0);
        return false;
      }
      if (event.key === 'Escape' && event.type === 'keydown') {
        setShowSearch(false);
        searchAddonRef.current?.clearDecorations();
      }
      // Ctrl+Shift+C / Cmd+Shift+C → copy selection to clipboard
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key === 'C' && event.type === 'keydown') {
        const sel = term.getSelection();
        if (sel) {
          if (navigator.clipboard && window.isSecureContext) {
            navigator.clipboard.writeText(sel);
          } else {
            const ta = document.createElement('textarea');
            ta.value = sel;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
          }
        }
        return false;
      }
      // Ctrl+Shift+V / Cmd+Shift+V → paste from clipboard
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key === 'V' && event.type === 'keydown') {
        if (navigator.clipboard && window.isSecureContext) {
          navigator.clipboard.readText().then(text => { if (text) term.paste(text); });
        }
        return false;
      }
      return true;
    });

    term.onData((data) => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input', data }));
      // Arm bell on Enter (user submitted a new prompt)
      if (data === '\r' || data === '\n') {
        bellArmed = true;
        bellNewBytes = 0;
        bellArmedAt = Date.now();
        clearTimeout(bellIdleTimer);
      }
    });

    // ── Resize handling ──

    let resizeTimer = 0;
    let lastW = 0;
    let lastH = 0;

    const doFit = () => {
      if (disposed) return;
      const el = containerRef.current;
      if (!el || el.offsetWidth === 0 || el.offsetHeight === 0) return;
      // Skip if container is inside a hidden tab (prevents wrong resize)
      if (el.closest('.hidden')) return;
      // Skip unreasonably small sizes — xterm crashes if rows/cols go below 2
      if (el.offsetWidth < 100 || el.offsetHeight < 50) return;
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      if (w === lastW && h === lastH) return;
      lastW = w;
      lastH = h;
      try {
        fit.fit();
        // Skip if xterm computed unreasonable dimensions
        if (term.cols < 2 || term.rows < 2) return;
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
        }
      } catch {}
    };

    const handleResize = () => {
      if (globalDragging) return;
      clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(doFit, 150);
    };

    const onDragEnd = () => {
      clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(doFit, 50);
    };
    window.addEventListener('terminal-drag-end', onDragEnd);

    const resizeObserver = new ResizeObserver(() => {
      if (!initDone) { initTerminal(); return; }
      handleResize();
    });
    resizeObserver.observe(containerRef.current);

    // ── Cleanup ──

    const mountTime = Date.now();

    return () => {
      disposed = true;
      visObserver.disconnect();
      clearTimeout(resizeTimer);
      clearTimeout(reconnectTimer);
      window.removeEventListener('terminal-drag-end', onDragEnd);
      resizeObserver.disconnect();
      // Strict Mode cleanup: if disposed within 2s of mount and we created a
      // new session (not attaching), kill the orphaned tmux session
      const isStrictModeCleanup = Date.now() - mountTime < 2000;
      const isNewSession = !sessionNameRef.current && connectedSession;
      if (ws) {
        if (isStrictModeCleanup && isNewSession && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'kill', sessionName: connectedSession }));
        }
        ws.onclose = null;
        ws.close();
      }
      term.dispose();
    };
  }, [id, onSessionConnected]);

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="h-full w-full" />
      {showSearch && (
        <div className="absolute top-1 right-2 flex items-center gap-1 px-2 py-1 rounded border border-[var(--term-border)] shadow-lg z-10"
          style={{ background: 'var(--term-bg, #1a1b26)' }}
          onClick={e => e.stopPropagation()}>
          <input
            ref={searchInputRef}
            type="text"
            value={searchQuery}
            onChange={e => {
              setSearchQuery(e.target.value);
              if (e.target.value) searchAddonRef.current?.findNext(e.target.value, { regex: false, caseSensitive: false, decorations: { matchOverviewRuler: '#888', activeMatchColorOverviewRuler: '#ff0' } });
              else searchAddonRef.current?.clearDecorations();
            }}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                if (e.shiftKey) searchAddonRef.current?.findPrevious(searchQuery, { regex: false, caseSensitive: false, decorations: { matchOverviewRuler: '#888', activeMatchColorOverviewRuler: '#ff0' } });
                else searchAddonRef.current?.findNext(searchQuery, { regex: false, caseSensitive: false, decorations: { matchOverviewRuler: '#888', activeMatchColorOverviewRuler: '#ff0' } });
              }
              if (e.key === 'Escape') {
                setShowSearch(false);
                searchAddonRef.current?.clearDecorations();
              }
            }}
            placeholder="Search..."
            className="bg-transparent text-[11px] text-[var(--term-fg,#c0caf5)] outline-none w-32 placeholder-gray-600"
            autoFocus
          />
          <button onClick={() => searchAddonRef.current?.findPrevious(searchQuery, { regex: false, caseSensitive: false, decorations: { matchOverviewRuler: '#888', activeMatchColorOverviewRuler: '#ff0' } })}
            className="text-[10px] text-gray-500 hover:text-gray-300 px-1" title="Previous (Shift+Enter)">▲</button>
          <button onClick={() => searchAddonRef.current?.findNext(searchQuery, { regex: false, caseSensitive: false, decorations: { matchOverviewRuler: '#888', activeMatchColorOverviewRuler: '#ff0' } })}
            className="text-[10px] text-gray-500 hover:text-gray-300 px-1" title="Next (Enter)">▼</button>
          <button onClick={() => { setShowSearch(false); searchAddonRef.current?.clearDecorations(); }}
            className="text-[10px] text-gray-500 hover:text-gray-300 px-1" title="Close (Esc)">✕</button>
        </div>
      )}
    </div>
  );
});
