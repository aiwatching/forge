'use client';

import React, { useState, useEffect, useMemo } from 'react';

interface MarketItem {
  name: string;
  displayName: string;
  description?: string;
  version: string;
  author?: string;
  tags?: string[];
  requires?: { hasFile?: string[]; hasGlob?: string[] };
  installed: boolean;
  installedVersion?: string;
  hasUpdate: boolean;
  compatible: boolean;
}

export default function CraftMarketplaceModal({ projectPath, onClose, onInstalled }: {
  projectPath: string;
  onClose: () => void;
  onInstalled: () => void;
}) {
  const [items, setItems] = useState<MarketItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'all' | 'compatible' | 'installed'>('compatible');

  const refresh = async (force = false) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/craft-system/marketplace?projectPath=${encodeURIComponent(projectPath)}${force ? '&refresh=1' : ''}`);
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || `${res.status}`);
      setItems(j.items || []);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  };

  // Always force-refresh on initial open so users see what's actually on the
  // remote (the server-side cache is short, but a freshly published craft
  // could otherwise sit hidden for the cache TTL).
  useEffect(() => { refresh(true); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter(it => {
      if (filter === 'compatible' && !it.compatible) return false;
      if (filter === 'installed' && !it.installed) return false;
      if (q && !`${it.name} ${it.displayName} ${it.description || ''} ${(it.tags || []).join(' ')}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [items, search, filter]);

  const install = async (name: string) => {
    setBusyId(name);
    try {
      const res = await fetch('/api/craft-system/marketplace/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectPath, name }),
      });
      const j = await res.json();
      if (!j.ok) throw new Error(j.error || 'install failed');
      onInstalled();
      await refresh();
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setBusyId(null);
    }
  };

  const uninstall = async (name: string) => {
    if (!confirm(`Uninstall craft "${name}"? Files at .forge/crafts/${name}/ will be deleted.`)) return;
    setBusyId(name);
    try {
      const res = await fetch('/api/craft-system/marketplace/uninstall', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectPath, name }),
      });
      const j = await res.json();
      if (!j.ok) throw new Error(j.error || 'uninstall failed');
      onInstalled();
      await refresh();
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg shadow-2xl w-[800px] max-w-[95vw] h-[80vh] flex flex-col"
        onClick={e => e.stopPropagation()}>
        <div className="px-4 py-2.5 border-b border-[var(--border)] flex items-center gap-2">
          <span className="text-sm font-semibold text-[var(--text-primary)]">🛒 Crafts Marketplace</span>
          <span className="text-[10px] text-[var(--text-secondary)]">{items.length} craft{items.length === 1 ? '' : 's'} in registry</span>
          <div className="flex-1" />
          <button onClick={() => refresh(true)}
            className="text-[10px] px-2 py-1 rounded text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
            title="Re-fetch the registry">↻</button>
          <button onClick={onClose} className="text-[10px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]">✕</button>
        </div>

        {/* Filter bar */}
        <div className="px-4 py-2 border-b border-[var(--border)] flex items-center gap-2 text-xs">
          <input
            value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search name / description / tag…"
            className="flex-1 text-xs bg-[var(--bg-tertiary)] border border-[var(--border)] rounded px-2 py-1"
          />
          <select value={filter} onChange={e => setFilter(e.target.value as any)}
            className="text-xs bg-[var(--bg-tertiary)] border border-[var(--border)] rounded px-2 py-1">
            <option value="compatible">Compatible</option>
            <option value="all">All</option>
            <option value="installed">Installed</option>
          </select>
        </div>

        {error && (
          <div className="px-4 py-2 text-[11px] text-red-300 bg-red-500/10 border-b border-red-500/30">
            {error}
          </div>
        )}

        {/* List */}
        <div className="flex-1 overflow-auto">
          {loading && <div className="p-4 text-xs text-[var(--text-secondary)]">Loading marketplace…</div>}
          {!loading && filtered.length === 0 && (
            <div className="p-6 text-center text-xs text-[var(--text-secondary)]">
              {items.length === 0
                ? 'No crafts in the registry yet. Configure `craftsRepoUrl` in settings to point at your own.'
                : 'No crafts match your filter.'}
            </div>
          )}
          {filtered.map(it => (
            <div key={it.name} className="px-4 py-2.5 border-b border-[var(--border)]/50 flex items-start gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[12px] font-semibold text-[var(--text-primary)]">{it.displayName}</span>
                  <span className="text-[9px] font-mono text-[var(--text-secondary)]">{it.name}</span>
                  <span className="text-[9px] px-1.5 py-0.5 rounded bg-[var(--bg-tertiary)] text-[var(--text-secondary)]">v{it.version}</span>
                  {it.author && <span className="text-[9px] text-[var(--text-secondary)]">by {it.author}</span>}
                  {it.installed && <span className="text-[9px] px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300">installed{it.installedVersion ? ` v${it.installedVersion}` : ''}</span>}
                  {it.hasUpdate && <span className="text-[9px] px-1.5 py-0.5 rounded bg-yellow-500/20 text-yellow-300">update available</span>}
                  {!it.compatible && <span className="text-[9px] px-1.5 py-0.5 rounded bg-orange-500/20 text-orange-300" title={JSON.stringify(it.requires)}>incompatible with this project</span>}
                </div>
                {it.description && <div className="text-[11px] text-[var(--text-secondary)] mt-0.5">{it.description}</div>}
                {it.tags && it.tags.length > 0 && (
                  <div className="flex gap-1 mt-1 flex-wrap">
                    {it.tags.map(t => (
                      <span key={t} className="text-[9px] px-1.5 py-0.5 rounded bg-[var(--bg-tertiary)] text-[var(--text-secondary)]">{t}</span>
                    ))}
                  </div>
                )}
              </div>
              <div className="flex flex-col gap-1 shrink-0">
                {!it.installed && (
                  <button onClick={() => install(it.name)} disabled={busyId === it.name || !it.compatible}
                    className="text-[10px] px-2.5 py-1 rounded bg-[var(--accent)]/30 text-[var(--accent)] hover:bg-[var(--accent)]/40 disabled:opacity-40">
                    {busyId === it.name ? '…' : 'Install'}
                  </button>
                )}
                {it.installed && it.hasUpdate && (
                  <button onClick={async () => {
                      setBusyId(it.name);
                      try {
                        const res = await fetch('/api/craft-system/marketplace/update', {
                          method: 'POST', headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ projectPath, name: it.name }),
                        });
                        const j = await res.json();
                        if (!j.ok) throw new Error(j.error || 'update failed');
                        onInstalled();
                        await refresh();
                      } catch (e: any) { setError(e?.message || String(e)); }
                      finally { setBusyId(null); }
                    }}
                    disabled={busyId === it.name}
                    className="text-[10px] px-2.5 py-1 rounded bg-yellow-500/20 text-yellow-300 hover:bg-yellow-500/30 disabled:opacity-40"
                    title={`Update v${it.installedVersion} → v${it.version}, preserves your data/`}>
                    {busyId === it.name ? '…' : `Update → v${it.version}`}
                  </button>
                )}
                {it.installed && (
                  <button onClick={() => uninstall(it.name)} disabled={busyId === it.name}
                    className="text-[10px] px-2.5 py-1 rounded text-red-300 hover:bg-red-500/10 disabled:opacity-40">
                    Uninstall
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
