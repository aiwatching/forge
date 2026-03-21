'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import TabBar from './TabBar';
import ProjectDetail from './ProjectDetail';

interface Project {
  name: string;
  path: string;
  root: string;
  hasGit: boolean;
  language: string | null;
}

interface ProjectTab {
  id: number;
  projectPath: string;
  projectName: string;
  hasGit: boolean;
  mountedAt: number; // timestamp for LRU eviction
}

const MAX_MOUNTED_TABS = 5;
function genTabId(): number { return Date.now() + Math.floor(Math.random() * 10000); }

export default function ProjectManager() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [showClone, setShowClone] = useState(false);
  const [cloneUrl, setCloneUrl] = useState('');
  const [cloneLoading, setCloneLoading] = useState(false);
  const [gitResult, setGitResult] = useState<{ ok?: boolean; error?: string } | null>(null);
  const [favorites, setFavorites] = useState<string[]>([]); // array of project paths

  // Tab state
  const [tabs, setTabs] = useState<ProjectTab[]>([]);
  const [activeTabId, setActiveTabId] = useState(0);
  const [tabsLoaded, setTabsLoaded] = useState(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Fetch projects
  useEffect(() => {
    fetch('/api/projects').then(r => r.json())
      .then((p: Project[]) => { if (Array.isArray(p)) setProjects(p); })
      .catch(() => {});
  }, []);

  // Load favorites from DB
  useEffect(() => {
    fetch('/api/favorites').then(r => r.json())
      .then(favs => { if (Array.isArray(favs)) setFavorites(favs); })
      .catch(() => {});
  }, []);

  // Load tabs from API
  useEffect(() => {
    fetch('/api/tabs?type=projects').then(r => r.json())
      .then(data => {
        if (Array.isArray(data.tabs) && data.tabs.length > 0) {
          const maxId = Math.max(...data.tabs.map((t: any) => t.id || 0));
          setTabs(data.tabs.map((t: any) => ({ ...t, mountedAt: Date.now() })));
          setActiveTabId(data.activeTabId || data.tabs[0].id);
        }
        setTabsLoaded(true);
      })
      .catch(() => setTabsLoaded(true));
  }, []);

  // Persist tabs (debounced)
  const persistTabs = useCallback((newTabs: ProjectTab[], newActiveId: number) => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      fetch('/api/tabs?type=projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tabs: newTabs.map(t => ({ id: t.id, projectPath: t.projectPath, projectName: t.projectName, hasGit: t.hasGit })),
          activeTabId: newActiveId,
        }),
      }).catch(() => {});
    }, 500);
  }, []);

  // Save favorites to settings
  const saveFavorite = useCallback((projectPath: string, add: boolean) => {
    fetch('/api/favorites', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: add ? 'add' : 'remove', projectPath }),
    }).then(r => r.json())
      .then(favs => { if (Array.isArray(favs)) setFavorites(favs); })
      .catch(() => {});
  }, []);

  const toggleFavorite = useCallback((projectPath: string) => {
    const isFav = favorites.includes(projectPath);
    // Optimistic update
    setFavorites(prev => isFav ? prev.filter(p => p !== projectPath) : [...prev, projectPath]);
    saveFavorite(projectPath, !isFav);
  }, [favorites, saveFavorite]);

  // Open a project in a tab
  const openProjectTab = useCallback((p: Project) => {
    setTabs(prev => {
      const existing = prev.find(t => t.projectPath === p.path);
      if (existing) {
        // Activate existing tab
        const updated = prev.map(t => t.id === existing.id ? { ...t, mountedAt: Date.now() } : t);
        setActiveTabId(existing.id);
        persistTabs(updated, existing.id);
        return updated;
      }
      // Create new tab
      const newTab: ProjectTab = {
        id: genTabId(),
        projectPath: p.path,
        projectName: p.name,
        hasGit: p.hasGit,
        mountedAt: Date.now(),
      };
      const updated = [...prev, newTab];
      setActiveTabId(newTab.id);
      persistTabs(updated, newTab.id);
      return updated;
    });
  }, [persistTabs]);

  const activateTab = useCallback((id: number) => {
    setActiveTabId(id);
    setTabs(prev => {
      const updated = prev.map(t => t.id === id ? { ...t, mountedAt: Date.now() } : t);
      persistTabs(updated, id);
      return updated;
    });
  }, [persistTabs]);

  const closeTab = useCallback((id: number) => {
    setTabs(prev => {
      const idx = prev.findIndex(t => t.id === id);
      const updated = prev.filter(t => t.id !== id);
      if (id === activeTabId && updated.length > 0) {
        // Activate nearest tab
        const newIdx = Math.min(idx, updated.length - 1);
        const newActiveId = updated[newIdx].id;
        setActiveTabId(newActiveId);
        persistTabs(updated, newActiveId);
      } else if (updated.length === 0) {
        setActiveTabId(0);
        persistTabs(updated, 0);
      } else {
        persistTabs(updated, activeTabId);
      }
      return updated;
    });
  }, [activeTabId, persistTabs]);

  // Determine which tabs to mount (max 5, LRU eviction)
  const mountedTabIds = new Set<number>();
  // Always mount active tab
  if (activeTabId) mountedTabIds.add(activeTabId);
  // Add rest sorted by mountedAt desc
  const sortedByRecency = [...tabs].sort((a, b) => b.mountedAt - a.mountedAt);
  for (const t of sortedByRecency) {
    if (mountedTabIds.size >= MAX_MOUNTED_TABS) break;
    mountedTabIds.add(t.id);
  }

  const handleClone = async () => {
    if (!cloneUrl.trim()) return;
    setCloneLoading(true);
    setGitResult(null);
    try {
      const res = await fetch('/api/git', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'clone', repoUrl: cloneUrl.trim() }),
      });
      const data = await res.json();
      if (data.ok) {
        setCloneUrl('');
        setShowClone(false);
        const pRes = await fetch('/api/projects');
        const pData = await pRes.json();
        if (Array.isArray(pData)) setProjects(pData);
        setGitResult({ ok: true });
      } else {
        setGitResult(data);
      }
    } catch (e: any) {
      setGitResult({ error: e.message });
    }
    setCloneLoading(false);
  };

  // Group projects by root
  const roots = [...new Set(projects.map(p => p.root))];
  const favoriteProjects = projects.filter(p => favorites.includes(p.path));

  return (
    <div className="flex-1 flex min-h-0">
      {/* Left sidebar — project list */}
      <aside className="w-64 border-r border-[var(--border)] flex flex-col shrink-0">
        <div className="px-3 py-2 border-b border-[var(--border)] flex items-center justify-between">
          <span className="text-[11px] font-semibold text-[var(--text-primary)]">Projects</span>
          <button
            onClick={() => setShowClone(v => !v)}
            className={`text-[10px] px-2 py-0.5 rounded ${showClone ? 'text-white bg-[var(--accent)]' : 'text-[var(--accent)] hover:bg-[var(--accent)]/10'}`}
          >
            + Clone
          </button>
        </div>

        {/* Clone form */}
        {showClone && (
          <div className="p-2 border-b border-[var(--border)] space-y-2">
            <input
              value={cloneUrl}
              onChange={e => setCloneUrl(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleClone()}
              placeholder="https://github.com/user/repo.git"
              className="w-full text-xs bg-[var(--bg-tertiary)] border border-[var(--border)] rounded px-2 py-1.5 text-[var(--text-primary)] font-mono focus:outline-none focus:border-[var(--accent)]"
            />
            <button
              onClick={handleClone}
              disabled={cloneLoading || !cloneUrl.trim()}
              className="w-full text-[10px] px-2 py-1 bg-[var(--accent)] text-white rounded hover:opacity-90 disabled:opacity-50"
            >
              {cloneLoading ? 'Cloning...' : 'Clone Repository'}
            </button>
          </div>
        )}

        {/* Project list */}
        <div className="flex-1 overflow-y-auto">
          {/* Favorites section */}
          {favoriteProjects.length > 0 && (
            <div>
              <div className="px-3 py-1 text-[9px] text-[var(--yellow)] uppercase bg-[var(--bg-tertiary)] flex items-center gap-1">
                <span>★</span> Favorites
              </div>
              {favoriteProjects.map(p => (
                <button
                  key={`fav-${p.path}`}
                  onClick={() => openProjectTab(p)}
                  className={`w-full text-left px-3 py-1.5 text-xs border-b border-[var(--border)]/30 flex items-center gap-2 ${
                    tabs.find(t => t.id === activeTabId)?.projectPath === p.path ? 'bg-[var(--accent)]/10 text-[var(--accent)]' : 'hover:bg-[var(--bg-tertiary)] text-[var(--text-primary)]'
                  }`}
                >
                  <span
                    onClick={(e) => { e.stopPropagation(); toggleFavorite(p.path); }}
                    className="text-[13px] text-[var(--yellow)] shrink-0 cursor-pointer leading-none"
                    title="Remove from favorites"
                  >★</span>
                  <span className="truncate">{p.name}</span>
                  {p.language && <span className="text-[8px] text-[var(--text-secondary)] ml-auto shrink-0">{p.language}</span>}
                  {p.hasGit && <span className="text-[8px] text-[var(--accent)] shrink-0">git</span>}
                </button>
              ))}
            </div>
          )}

          {/* All projects by root */}
          {roots.map(root => {
            const rootName = root.split('/').pop() || root;
            const rootProjects = projects.filter(p => p.root === root).sort((a, b) => a.name.localeCompare(b.name));
            return (
              <div key={root}>
                <div className="px-3 py-1 text-[9px] text-[var(--text-secondary)] uppercase bg-[var(--bg-tertiary)]">
                  {rootName}
                </div>
                {rootProjects.map(p => (
                  <button
                    key={p.path}
                    onClick={() => openProjectTab(p)}
                    className={`w-full text-left px-3 py-1.5 text-xs border-b border-[var(--border)]/30 flex items-center gap-2 ${
                      tabs.find(t => t.id === activeTabId)?.projectPath === p.path ? 'bg-[var(--accent)]/10 text-[var(--accent)]' : 'hover:bg-[var(--bg-tertiary)] text-[var(--text-primary)]'
                    }`}
                  >
                    <span
                      onClick={(e) => { e.stopPropagation(); toggleFavorite(p.path); }}
                      className={`text-[13px] shrink-0 cursor-pointer leading-none ${favorites.includes(p.path) ? 'text-[var(--yellow)]' : 'text-[var(--text-secondary)]/30 hover:text-[var(--yellow)]'}`}
                      title={favorites.includes(p.path) ? 'Remove from favorites' : 'Add to favorites'}
                    >{favorites.includes(p.path) ? '★' : '☆'}</span>
                    <span className="truncate">{p.name}</span>
                    {p.language && <span className="text-[8px] text-[var(--text-secondary)] ml-auto shrink-0">{p.language}</span>}
                    {p.hasGit && <span className="text-[8px] text-[var(--accent)] shrink-0">git</span>}
                  </button>
                ))}
              </div>
            );
          })}
        </div>
      </aside>

      {/* Main area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Tab bar */}
        {tabs.length > 0 && (
          <TabBar
            tabs={tabs.map(t => ({ id: t.id, label: t.projectName }))}
            activeId={activeTabId}
            onActivate={activateTab}
            onClose={closeTab}
          />
        )}

        {/* Tab content */}
        {tabs.length > 0 ? (
          <div className="flex-1 flex flex-col min-h-0 relative">
            {tabs.map(tab => {
              if (!mountedTabIds.has(tab.id)) return null;
              const isActive = tab.id === activeTabId;
              return (
                <div
                  key={tab.id}
                  className="flex-1 flex flex-col min-h-0"
                  style={{ display: isActive ? 'flex' : 'none' }}
                >
                  <ProjectDetail
                    projectPath={tab.projectPath}
                    projectName={tab.projectName}
                    hasGit={tab.hasGit}
                  />
                </div>
              );
            })}
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center text-[var(--text-secondary)]">
            <div className="text-center space-y-2">
              <p className="text-sm">Select a project</p>
              <p className="text-xs">{projects.length} projects across {roots.length} directories</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
