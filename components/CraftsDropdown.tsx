'use client';

// Compact crafts menu for the project tab bar. Shows the active craft as a
// chip (with ⚙ refine + 🗑 delete shortcuts) plus a dropdown listing all
// available crafts. Replaces the previous flat tab-per-craft layout that
// blew the workspace bar wide once a few crafts existed.

import React, { useState, useRef, useEffect, useMemo } from 'react';

interface Craft {
  name: string;
  displayName: string;
  description?: string;
  scope: 'builtin' | 'project' | string;
}

export default function CraftsDropdown({
  crafts,
  activeTab,
  projectPath,
  onPick,
  onNew,
  onRefine,
  onDelete,
  onMarketplace,
  onPublish,
  onEditManifest,
}: {
  crafts: Craft[];
  activeTab: string;
  projectPath: string;
  onPick: (name: string) => void;
  onNew: () => void;
  onRefine: (name: string) => void;
  onDelete: (name: string, displayName: string) => void;
  onMarketplace: () => void;
  onPublish: (name: string) => void;
  onEditManifest: (name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [updates, setUpdates] = useState<{ name: string; from?: string; to: string }[]>([]);

  // Background poll for available updates. Cheap (just a registry version compare).
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const r = await fetch(`/api/craft-system/marketplace/updates?projectPath=${encodeURIComponent(projectPath)}`);
        if (!r.ok) return;
        const j = await r.json();
        if (!cancelled) setUpdates(j.updates || []);
      } catch {}
    };
    poll();
    // Re-check whenever the dropdown opens, plus every 5 minutes in background
    const id = setInterval(poll, 5 * 60_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [projectPath, crafts.length]);

  const updatesByName = useMemo(() => {
    const m = new Map<string, { from?: string; to: string }>();
    for (const u of updates) m.set(u.name, { from: u.from, to: u.to });
    return m;
  }, [updates]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const activeName = activeTab.startsWith('craft:') ? activeTab.slice('craft:'.length) : null;
  const active = activeName ? crafts.find(c => c.name === activeName) : null;

  return (
    <div className="relative inline-flex items-stretch gap-0.5" ref={popoverRef}>
      {/* Active craft chip with refine + delete */}
      {active && (
        <>
          <button
            onClick={() => onPick(active.name)}
            className="text-[11px] font-medium px-2.5 py-1 rounded bg-[var(--accent)]/20 text-[var(--accent)] shadow-sm ring-1 ring-[var(--accent)]/40"
            title={active.description || active.displayName}
          >
            {active.displayName}
          </button>
          {active.scope === 'project' && (
            <>
              <button onClick={() => onEditManifest(active.name)}
                className="text-[10px] px-1.5 py-0.5 rounded text-[var(--text-secondary)] hover:bg-[var(--accent)]/20 hover:text-[var(--accent)]"
                title="Edit craft.yaml (version, displayName, tags, requires)">📝</button>
              <button onClick={() => onRefine(active.name)}
                className="text-[10px] px-1.5 py-0.5 rounded text-[var(--text-secondary)] hover:bg-[var(--accent)]/20 hover:text-[var(--accent)]"
                title="Refine this craft (AI iterates on it)">⚙</button>
              <button onClick={() => onPublish(active.name)}
                className="text-[10px] px-1.5 py-0.5 rounded text-[var(--text-secondary)] hover:bg-[var(--accent)]/20 hover:text-[var(--accent)]"
                title="Publish to the crafts marketplace">📦</button>
              <button onClick={() => onDelete(active.name, active.displayName)}
                className="text-[10px] px-1.5 py-0.5 rounded text-[var(--text-secondary)] hover:bg-red-500/20 hover:text-red-300"
                title="Delete this craft">🗑</button>
            </>
          )}
        </>
      )}

      {/* Dropdown trigger */}
      <button
        onClick={() => setOpen(v => !v)}
        className={`relative text-[11px] font-medium px-2.5 py-1 rounded transition-all ${
          open ? 'bg-[var(--bg-tertiary)] text-[var(--accent)]' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-secondary)]'
        }`}
        title={updates.length > 0 ? `${updates.length} craft update${updates.length === 1 ? '' : 's'} available` : `${crafts.length} craft${crafts.length === 1 ? '' : 's'}`}
      >
        {active ? '▾' : `🛠 Crafts ${crafts.length > 0 ? `(${crafts.length})` : ''} ▾`}
        {updates.length > 0 && (
          <span className="absolute -top-1 -right-1 min-w-[14px] h-[14px] px-1 rounded-full bg-yellow-500 text-black text-[8px] font-bold leading-[14px] flex items-center justify-center"
            title={`${updates.length} update${updates.length === 1 ? '' : 's'} available`}>
            {updates.length}
          </span>
        )}
      </button>

      {/* Dropdown menu */}
      {open && (
        <div className="absolute top-full left-0 mt-1 z-30 bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg shadow-xl min-w-[260px] max-w-[400px] py-1">
          {crafts.length === 0 && (
            <div className="px-3 py-2 text-[11px] text-[var(--text-secondary)] italic">
              No crafts yet — click + Craft to add one.
            </div>
          )}
          {crafts.map(c => {
            const isActive = c.name === activeName;
            const upd = updatesByName.get(c.name);
            return (
              <div key={c.name}
                className={`group flex items-center gap-2 px-2 py-1.5 cursor-pointer ${
                  isActive ? 'bg-[var(--accent)]/10' : 'hover:bg-[var(--bg-tertiary)]'
                }`}
                onClick={() => { onPick(c.name); setOpen(false); }}
              >
                <span className={`flex-1 text-[11px] truncate ${isActive ? 'text-[var(--accent)] font-semibold' : 'text-[var(--text-primary)]'}`}>
                  {c.displayName}
                </span>
                {upd && (
                  <span className="text-[8px] px-1 py-0.5 rounded bg-yellow-500/20 text-yellow-300"
                    title={`Update available: ${upd.from || '?'} → ${upd.to}`}>
                    ↑ {upd.to}
                  </span>
                )}
                {c.description && <span className="text-[9px] text-[var(--text-secondary)] truncate max-w-[120px] opacity-0 group-hover:opacity-100">{c.description}</span>}
                {c.scope === 'builtin' && (
                  <span className="text-[8px] px-1 py-0.5 rounded bg-[var(--bg-tertiary)] text-[var(--text-secondary)]">builtin</span>
                )}
              </div>
            );
          })}
          {updates.length > 0 && (
            <button onClick={() => { setOpen(false); onMarketplace(); }}
              className="w-full px-3 py-2 text-left bg-yellow-500/10 hover:bg-yellow-500/15 border-t border-yellow-500/30 text-[10px] text-yellow-300 flex items-center gap-2">
              <span>⚠ {updates.length} update{updates.length === 1 ? '' : 's'} available — open Marketplace to apply</span>
              <span className="ml-auto opacity-70">→</span>
            </button>
          )}
          {crafts.length > 0 && <div className="border-t border-[var(--border)] my-1" />}
          <div className="px-2 py-1 flex items-center gap-1">
            <button onClick={() => { setOpen(false); onNew(); }}
              className="text-[10px] px-2 py-1 rounded bg-[var(--accent)]/20 text-[var(--accent)] hover:bg-[var(--accent)]/30 flex-1 text-left"
              title="Build a new craft">
              + New craft
            </button>
            <button onClick={() => { setOpen(false); onMarketplace(); }}
              className="text-[10px] px-2 py-1 rounded text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--accent)]"
              title="Browse the crafts marketplace">
              🛒 Marketplace
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
