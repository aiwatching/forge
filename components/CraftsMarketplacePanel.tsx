'use client';

// Read-only browse view of the global crafts registry, used inside the
// Dashboard Marketplace tab. Installation requires a target project; we
// surface a project picker per row that lists the user's recent projects.

import React, { useState, useEffect, useMemo } from 'react';

interface RegistryItem {
  name: string;
  displayName: string;
  description?: string;
  version: string;
  author?: string;
  tags?: string[];
  requires?: { hasFile?: string[]; hasGlob?: string[] };
  files?: string[];
  sourceUrl?: string;
}

interface ProjectInfo {
  path: string;
  name: string;
}

export default function CraftsMarketplacePanel({ searchQuery = '' }: { searchQuery?: string }) {
  const [items, setItems] = useState<RegistryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const refresh = async (force = false) => {
    setLoading(true); setError(null);
    try {
      const r = await fetch(`/api/craft-system/registry${force ? '?refresh=1' : ''}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `${r.status}`);
      setItems(j.items || []);
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setLoading(false); }
  };

  // Force-refresh on mount so we don't show stale entries right after a publish landed.
  useEffect(() => { refresh(true); }, []);

  // Pull recent projects (favorites + last opened) for the install picker
  useEffect(() => {
    Promise.all([
      fetch('/api/favorites').then(r => r.ok ? r.json() : []).catch(() => []),
      fetch('/api/projects').then(r => r.ok ? r.json() : []).catch(() => []),
    ]).then(([favs, all]) => {
      const favSet = new Set<string>(Array.isArray(favs) ? favs : []);
      const list = Array.isArray(all) ? all : [];
      const ranked = list.map((p: any) => ({
        path: p.path,
        name: p.name || p.path.split('/').pop(),
        fav: favSet.has(p.path),
      }));
      ranked.sort((a, b) => Number(b.fav) - Number(a.fav) || a.name.localeCompare(b.name));
      setProjects(ranked);
    }).catch(() => {});
  }, []);

  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return items;
    return items.filter(it =>
      `${it.name} ${it.displayName} ${it.description || ''} ${(it.tags || []).join(' ')}`
        .toLowerCase().includes(q)
    );
  }, [items, searchQuery]);

  const flash = (msg: string) => { setToast(msg); setTimeout(() => setToast(null), 2500); };

  const install = async (name: string, projectPath: string) => {
    setBusyId(`${name}::${projectPath}`);
    try {
      const r = await fetch('/api/craft-system/marketplace/install', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectPath, name }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'install failed');
      flash(`Installed ${name} → ${projectPath.split('/').pop()}`);
    } catch (e: any) { flash(`Failed: ${e?.message || e}`); }
    finally { setBusyId(null); }
  };

  return (
    <div className="flex-1 overflow-auto relative">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-[var(--border)] bg-[var(--bg-secondary)]/30 sticky top-0 z-10">
        <span className="text-[10px] text-[var(--text-secondary)]">{items.length} craft{items.length === 1 ? '' : 's'} in registry</span>
        <div className="flex-1" />
        <button onClick={() => refresh(true)} disabled={loading}
          className="text-[10px] px-2 py-0.5 rounded text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]">
          {loading ? '⏳' : '↻ Sync'}
        </button>
      </div>

      {error && (
        <div className="m-4 p-2 text-[11px] text-red-300 bg-red-500/10 border border-red-500/30 rounded">
          {error}
        </div>
      )}

      {!loading && filtered.length === 0 && (
        <div className="p-8 text-center text-xs text-[var(--text-secondary)]">
          {items.length === 0
            ? 'No crafts in the registry yet. Build one in any project, then click 📦 Publish to submit it.'
            : 'No crafts match your search.'}
        </div>
      )}

      {filtered.map(it => (
        <div key={it.name} className="px-4 py-3 border-b border-[var(--border)]/50 flex items-start gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[12px] font-semibold text-[var(--text-primary)]">{it.displayName}</span>
              <span className="text-[9px] font-mono text-[var(--text-secondary)]">{it.name}</span>
              <span className="text-[9px] px-1.5 py-0.5 rounded bg-[var(--bg-tertiary)] text-[var(--text-secondary)]">v{it.version}</span>
              {it.author && <span className="text-[9px] text-[var(--text-secondary)]">by {it.author}</span>}
              {it.sourceUrl && (
                <a href={it.sourceUrl} target="_blank" rel="noreferrer" className="text-[9px] text-[var(--accent)] hover:underline">
                  source ↗
                </a>
              )}
            </div>
            {it.description && <div className="text-[11px] text-[var(--text-secondary)] mt-0.5">{it.description}</div>}
            {it.tags && it.tags.length > 0 && (
              <div className="flex gap-1 mt-1 flex-wrap">
                {it.tags.map(t => (
                  <span key={t} className="text-[9px] px-1.5 py-0.5 rounded bg-[var(--bg-tertiary)] text-[var(--text-secondary)]">{t}</span>
                ))}
              </div>
            )}
            {it.requires && (it.requires.hasFile?.length || it.requires.hasGlob?.length) && (
              <div className="text-[9px] text-[var(--text-secondary)] opacity-70 mt-1 font-mono">
                requires: {[...(it.requires.hasFile || []), ...(it.requires.hasGlob || [])].join(', ')}
              </div>
            )}
          </div>

          {/* Install picker */}
          <div className="shrink-0">
            <ProjectPickerInstall
              craftName={it.name}
              projects={projects}
              busy={busyId?.startsWith(it.name + '::') || false}
              onInstall={(p) => install(it.name, p)}
            />
          </div>
        </div>
      ))}

      {toast && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 px-3 py-1.5 text-xs rounded bg-[var(--bg-tertiary)] border border-[var(--border)] shadow-lg z-50">
          {toast}
        </div>
      )}
    </div>
  );
}

function ProjectPickerInstall({ craftName, projects, busy, onInstall }: {
  craftName: string; projects: { path: string; name: string }[]; busy: boolean; onInstall: (p: string) => void;
}) {
  const [open, setOpen] = useState(false);
  if (projects.length === 0) {
    return <span className="text-[10px] text-[var(--text-secondary)] italic">no projects</span>;
  }
  return (
    <div className="relative">
      <button onClick={() => setOpen(v => !v)} disabled={busy}
        className="text-[10px] px-2.5 py-1 rounded bg-[var(--accent)]/30 text-[var(--accent)] hover:bg-[var(--accent)]/40 disabled:opacity-40">
        {busy ? '⏳' : 'Install ▾'}
      </button>
      {open && !busy && (
        <div className="absolute right-0 mt-1 z-30 bg-[var(--bg-primary)] border border-[var(--border)] rounded shadow-xl min-w-[240px] max-h-72 overflow-auto">
          <div className="px-2 py-1 text-[10px] text-[var(--text-secondary)] border-b border-[var(--border)]">Install to which project?</div>
          {projects.map(p => (
            <button key={p.path} onClick={() => { setOpen(false); onInstall(p.path); }}
              className="w-full text-left px-2 py-1 text-[10px] hover:bg-[var(--bg-tertiary)]">
              <div className="font-medium text-[var(--text-primary)]">{p.name}</div>
              <div className="text-[9px] text-[var(--text-secondary)] truncate">{p.path}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
