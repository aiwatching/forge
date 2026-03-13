'use client';

import { useState, useEffect, useRef, useCallback, memo, useImperativeHandle, forwardRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

// ─── Imperative API for parent components ────────────────────

export interface WebTerminalHandle {
  openSessionInTerminal: (sessionId: string, projectPath: string) => void;
}

// ─── Types ───────────────────────────────────────────────────

interface TmuxSession {
  name: string;
  created: string;
  attached: boolean;
  windows: number;
}

type SplitNode =
  | { type: 'terminal'; id: number; sessionName?: string }
  | { type: 'split'; id: number; direction: 'horizontal' | 'vertical'; ratio: number; first: SplitNode; second: SplitNode };

interface TabState {
  id: number;
  label: string;
  tree: SplitNode;
  ratios: Record<number, number>;
  activeId: number;
}

// ─── Layout persistence ──────────────────────────────────────

const STORAGE_KEY = 'mw-terminal-tabs';

function saveTabs(tabs: TabState[], activeTabId: number) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ tabs, activeTabId }));
  } catch {}
}

function loadTabs(): { tabs: TabState[]; activeTabId: number } | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return null;
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

function makeTerminal(sessionName?: string): SplitNode {
  return { type: 'terminal', id: nextId++, sessionName };
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

function collectSessionNames(tree: SplitNode): string[] {
  if (tree.type === 'terminal') return tree.sessionName ? [tree.sessionName] : [];
  return [...collectSessionNames(tree.first), ...collectSessionNames(tree.second)];
}

function collectAllSessionNames(tabs: TabState[]): string[] {
  return tabs.flatMap(t => collectSessionNames(t.tree));
}

// ─── Pending commands for new terminal panes ────────────────

const pendingCommands = new Map<number, string>();

// ─── Main component ─────────────────────────────────────────

const WebTerminal = forwardRef<WebTerminalHandle>(function WebTerminal(_props, ref) {
  const [tabs, setTabs] = useState<TabState[]>(() => {
    const tree = makeTerminal();
    return [{ id: nextId++, label: 'Terminal 1', tree, ratios: {}, activeId: firstTerminalId(tree) }];
  });
  const [activeTabId, setActiveTabId] = useState(() => tabs[0]?.id || 1);
  const [hydrated, setHydrated] = useState(false);
  const [tmuxSessions, setTmuxSessions] = useState<TmuxSession[]>([]);
  const [showSessionPicker, setShowSessionPicker] = useState(false);
  const [editingTabId, setEditingTabId] = useState<number | null>(null);
  const [editingLabel, setEditingLabel] = useState('');
  const [closeConfirm, setCloseConfirm] = useState<{ tabId: number; sessions: string[] } | null>(null);
  const dragTabRef = useRef<number | null>(null);

  // Restore from localStorage after mount (avoids hydration mismatch)
  useEffect(() => {
    const saved = loadTabs();
    if (saved && saved.tabs.length > 0) {
      initNextIdFromTabs(saved.tabs);
      setTabs(saved.tabs);
      setActiveTabId(saved.activeTabId);
    }
    setHydrated(true);
  }, []);

  // Persist on changes (only after hydration)
  useEffect(() => {
    if (hydrated) saveTabs(tabs, activeTabId);
  }, [tabs, activeTabId, hydrated]);

  const activeTab = tabs.find(t => t.id === activeTabId) || tabs[0];

  // ─── Imperative handle for parent ─────────────────────

  useImperativeHandle(ref, () => ({
    openSessionInTerminal(sessionId: string, projectPath: string) {
      const tree = makeTerminal();
      const paneId = firstTerminalId(tree);
      const cmd = `cd ${projectPath} && claude --resume ${sessionId}\n`;
      pendingCommands.set(paneId, cmd);
      const newTab: TabState = {
        id: nextId++,
        label: `claude ${sessionId.slice(0, 8)}`,
        tree,
        ratios: {},
        activeId: paneId,
      };
      setTabs(prev => [...prev, newTab]);
      setActiveTabId(newTab.id);
    },
  }));

  // ─── Tab operations ───────────────────────────────────

  const addTab = useCallback(() => {
    const tree = makeTerminal();
    const tabNum = tabs.length + 1;
    const newTab: TabState = { id: nextId++, label: `Terminal ${tabNum}`, tree, ratios: {}, activeId: firstTerminalId(tree) };
    setTabs(prev => [...prev, newTab]);
    setActiveTabId(newTab.id);
  }, [tabs.length]);

  const closeTab = useCallback((tabId: number) => {
    const tab = tabs.find(t => t.id === tabId);
    if (!tab) return;
    const sessions = collectSessionNames(tab.tree);
    if (sessions.length > 0) {
      setCloseConfirm({ tabId, sessions });
    } else {
      // No sessions, just close
      removeTab(tabId);
    }
  }, [tabs]);

  const removeTab = useCallback((tabId: number) => {
    setTabs(prev => {
      if (prev.length <= 1) return prev;
      return prev.filter(t => t.id !== tabId);
    });
    setActiveTabId(prev => {
      if (prev === tabId) {
        const idx = tabs.findIndex(t => t.id === tabId);
        const next = tabs[idx - 1] || tabs[idx + 1];
        return next?.id || tabs[0]?.id || 0;
      }
      return prev;
    });
  }, [tabs]);

  const closeTabWithAction = useCallback((action: 'detach' | 'kill') => {
    if (!closeConfirm) return;
    const { tabId, sessions } = closeConfirm;
    if (action === 'kill') {
      // Kill all tmux sessions in this tab
      const wsHost = window.location.hostname;
      const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      for (const sn of sessions) {
        const ws = new WebSocket(`${wsProtocol}//${wsHost}:3001`);
        ws.onopen = () => {
          ws.send(JSON.stringify({ type: 'kill', sessionName: sn }));
          setTimeout(() => ws.close(), 500);
        };
      }
    }
    // Both actions remove the tab; 'detach' keeps tmux sessions alive
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
    setTabs(prev => prev.map(t => t.id === tabId ? { ...t, label } : t));
    setEditingTabId(null);
  }, []);

  // ─── Update active tab's state ─────────────────────────

  const updateActiveTab = useCallback((updater: (tab: TabState) => TabState) => {
    setTabs(prev => prev.map(t => t.id === activeTabId ? updater(t) : t));
  }, [activeTabId]);

  const onSessionConnected = useCallback((paneId: number, sessionName: string) => {
    setTabs(prev => prev.map(t => ({
      ...t,
      tree: updateSessionName(t.tree, paneId, sessionName),
    })));
  }, []);

  const refreshSessions = useCallback(() => {
    const wsHost = window.location.hostname;
    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${wsProtocol}//${wsHost}:3001`);
    ws.onopen = () => ws.send(JSON.stringify({ type: 'list' }));
    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'sessions') setTmuxSessions(msg.sessions);
      } catch {}
      ws.close();
    };
    ws.onerror = () => ws.close();
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

  // Auto-refresh tmux sessions periodically to show detached count
  useEffect(() => {
    if (!hydrated) return;
    refreshSessions();
    const timer = setInterval(refreshSessions, 10000);
    return () => clearInterval(timer);
  }, [hydrated, refreshSessions]);

  const detachedCount = tmuxSessions.filter(s => !usedSessions.includes(s.name)).length;

  return (
    <div className="h-full w-full flex-1 flex flex-col bg-[#1a1a2e]">
      {/* Tab bar + toolbar */}
      <div className="flex items-center bg-[#12122a] border-b border-[#2a2a4a] shrink-0">
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
              className={`flex items-center gap-1 px-3 py-1 text-[11px] cursor-pointer border-r border-[#2a2a4a] select-none ${
                tab.id === activeTabId
                  ? 'bg-[#1a1a2e] text-white'
                  : 'text-gray-500 hover:text-gray-300 hover:bg-[#1a1a2e]/50'
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
                  className="bg-transparent border border-[#4a4a6a] rounded px-1 text-[11px] text-white outline-none w-20"
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
            onClick={addTab}
            className="px-2 py-1 text-[11px] text-gray-500 hover:text-white hover:bg-[#2a2a4a]"
            title="New terminal tab"
          >
            +
          </button>
        </div>

        {/* Toolbar */}
        <div className="flex items-center gap-1 px-2 ml-auto">
          <button onClick={() => onSplit('vertical')} className="text-[10px] px-2 py-0.5 text-gray-400 hover:text-white hover:bg-[#2a2a4a] rounded">
            Split Right
          </button>
          <button onClick={() => onSplit('horizontal')} className="text-[10px] px-2 py-0.5 text-gray-400 hover:text-white hover:bg-[#2a2a4a] rounded">
            Split Down
          </button>
          <button
            onClick={() => { refreshSessions(); setShowSessionPicker(v => !v); }}
            className={`text-[10px] px-2 py-0.5 rounded relative ${showSessionPicker ? 'text-white bg-[#7c5bf0]/30' : 'text-gray-400 hover:text-white hover:bg-[#2a2a4a]'}`}
          >
            Sessions
            {detachedCount > 0 && (
              <span className="ml-1 inline-flex items-center justify-center min-w-[14px] h-[14px] rounded-full bg-yellow-500/80 text-[8px] text-black font-bold px-1">
                {detachedCount}
              </span>
            )}
          </button>
          {activeTab && countTerminals(activeTab.tree) > 1 && (
            <button onClick={onClosePane} className="text-[10px] px-2 py-0.5 text-gray-400 hover:text-red-400 hover:bg-[#2a2a4a] rounded">
              Close Pane
            </button>
          )}
        </div>
      </div>

      {/* Session management panel */}
      {showSessionPicker && (
        <div className="bg-[#0e0e20] border-b border-[#2a2a4a] px-3 py-2 shrink-0 max-h-48 overflow-y-auto">
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
                <tr className="text-gray-500 text-left border-b border-[#2a2a4a]">
                  <th className="py-1 pr-3 font-medium">Session</th>
                  <th className="py-1 pr-3 font-medium">Created</th>
                  <th className="py-1 pr-3 font-medium">Status</th>
                  <th className="py-1 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {tmuxSessions.map(s => {
                  const inUse = usedSessions.includes(s.name);
                  return (
                    <tr key={s.name} className="border-b border-[#2a2a4a]/50 hover:bg-[#1a1a2e]">
                      <td className="py-1.5 pr-3 font-mono text-gray-300">{s.name.replace('mw-', '')}</td>
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
                              // Open in a new tab
                              const tree = makeTerminal(s.name);
                              const newTab: TabState = { id: nextId++, label: s.name.replace('mw-', ''), tree, ratios: {}, activeId: firstTerminalId(tree) };
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
                            const wsHost = window.location.hostname;
                            const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
                            const ws = new WebSocket(`${wsProtocol}//${wsHost}:3001`);
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

      {/* Close confirmation dialog */}
      {closeConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setCloseConfirm(null)}>
          <div className="bg-[#1a1a2e] border border-[#2a2a4a] rounded-lg p-4 shadow-xl max-w-sm" onClick={(e) => e.stopPropagation()}>
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
          />
        </div>
      ))}
    </div>
  );
});

export default WebTerminal;

// ─── Pane renderer ───────────────────────────────────────────

function PaneRenderer({
  node, activeId, onFocus, ratios, setRatios, onSessionConnected,
}: {
  node: SplitNode;
  activeId: number;
  onFocus: (id: number) => void;
  ratios: Record<number, number>;
  setRatios: React.Dispatch<React.SetStateAction<Record<number, number>>>;
  onSessionConnected: (paneId: number, sessionName: string) => void;
}) {
  if (node.type === 'terminal') {
    return (
      <div className={`h-full w-full ${activeId === node.id ? 'ring-1 ring-[#7c5bf0]/50 ring-inset' : ''}`} onMouseDown={() => onFocus(node.id)}>
        <MemoTerminalPane id={node.id} sessionName={node.sessionName} onSessionConnected={onSessionConnected} />
      </div>
    );
  }

  const ratio = ratios[node.id] ?? node.ratio;

  return (
    <DraggableSplit splitId={node.id} direction={node.direction} ratio={ratio} setRatios={setRatios}>
      <PaneRenderer node={node.first} activeId={activeId} onFocus={onFocus} ratios={ratios} setRatios={setRatios} onSessionConnected={onSessionConnected} />
      <PaneRenderer node={node.second} activeId={activeId} onFocus={onFocus} ratios={ratios} setRatios={setRatios} onSessionConnected={onSessionConnected} />
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
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      // Commit final ratio to React state (single re-render)
      setRatios(prev => ({ ...prev, [splitId]: lastRatio }));
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
  onSessionConnected,
}: {
  id: number;
  sessionName?: string;
  onSessionConnected: (paneId: number, sessionName: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const sessionNameRef = useRef(sessionName);
  sessionNameRef.current = sessionName;

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      theme: {
        background: '#1a1a2e',
        foreground: '#e0e0e0',
        cursor: '#7c5bf0',
        selectionBackground: '#7c5bf044',
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
    term.open(containerRef.current);
    requestAnimationFrame(() => fit.fit());

    const wsHost = window.location.hostname;
    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${wsProtocol}//${wsHost}:3001`);

    ws.onopen = () => {
      const cols = term.cols;
      const rows = term.rows;
      const sn = sessionNameRef.current;

      if (sn) {
        ws.send(JSON.stringify({ type: 'attach', sessionName: sn, cols, rows }));
      } else {
        ws.send(JSON.stringify({ type: 'create', cols, rows }));
      }
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'output') {
          term.write(msg.data);
        } else if (msg.type === 'connected') {
          onSessionConnected(id, msg.sessionName);
          // Send pending command if any (e.g. claude --resume)
          const cmd = pendingCommands.get(id);
          if (cmd) {
            pendingCommands.delete(id);
            setTimeout(() => {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'input', data: cmd }));
              }
            }, 500);
          }
        } else if (msg.type === 'exit') {
          term.write('\r\n\x1b[90m[session ended]\x1b[0m\r\n');
        }
      } catch {}
    };

    ws.onclose = () => {
      term.write('\r\n\x1b[90m[disconnected — session persists in tmux]\x1b[0m\r\n');
    };

    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input', data }));
    });

    let resizeRaf = 0;
    const handleResize = () => {
      if (resizeRaf) cancelAnimationFrame(resizeRaf);
      resizeRaf = requestAnimationFrame(() => {
        resizeRaf = 0;
        const el = containerRef.current;
        if (!el || el.offsetWidth === 0 || el.offsetHeight === 0) return; // hidden tab
        try {
          fit.fit();
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
        } catch {}
      });
    };

    const resizeObserver = new ResizeObserver(handleResize);
    resizeObserver.observe(containerRef.current);

    return () => {
      if (resizeRaf) cancelAnimationFrame(resizeRaf);
      resizeObserver.disconnect();
      ws.close();
      term.dispose();
    };
  }, [id, onSessionConnected]);

  return <div ref={containerRef} className="h-full w-full" />;
});
