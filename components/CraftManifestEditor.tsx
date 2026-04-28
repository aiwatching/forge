'use client';

// Inline editor for craft.yaml. Two views:
//   1. Form mode — quick fields for the common edits (version + bumps,
//      displayName, description, tags, requires).
//   2. Raw mode — full YAML textarea for anything the form doesn't surface.
// Saves to disk via PUT /api/craft-system/manifest. Persisted manifest is
// what the publish flow + marketplace install both read, so editing here is
// authoritative.

import React, { useState, useEffect, useMemo } from 'react';

interface Manifest {
  name?: string;
  displayName?: string;
  description?: string;
  version?: string;
  author?: string;
  tags?: string[];
  requires?: { hasFile?: string[]; hasGlob?: string[] };
  ui?: { tab?: string; showWhen?: string };
  server?: { entry?: string };
  [k: string]: any;
}

function bumpVersion(v: string, kind: 'patch' | 'minor' | 'major'): string {
  const parts = (v || '0.0.0').split('.').map(Number);
  while (parts.length < 3) parts.push(0);
  if (kind === 'major') { parts[0]++; parts[1] = 0; parts[2] = 0; }
  else if (kind === 'minor') { parts[1]++; parts[2] = 0; }
  else { parts[2]++; }
  return parts.join('.');
}

export default function CraftManifestEditor({ projectPath, craftName, onClose, onSaved }: {
  projectPath: string;
  craftName: string;
  onClose: () => void;
  onSaved?: (manifest: Manifest) => void;
}) {
  const [raw, setRaw] = useState<string>('');
  const [originalRaw, setOriginalRaw] = useState<string>('');
  const [parsed, setParsed] = useState<Manifest | null>(null);
  const [tab, setTab] = useState<'form' | 'raw'>('form');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Form-state (mirrors parsed; saving rebuilds the YAML via patch endpoint)
  const [version, setVersion] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [description, setDescription] = useState('');
  const [tagsText, setTagsText] = useState('');
  const [author, setAuthor] = useState('');
  const [showWhen, setShowWhen] = useState('');
  const [hasFileText, setHasFileText] = useState('');
  const [hasGlobText, setHasGlobText] = useState('');

  useEffect(() => {
    fetch(`/api/craft-system/manifest?projectPath=${encodeURIComponent(projectPath)}&name=${encodeURIComponent(craftName)}`)
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`${r.status}`)))
      .then(j => {
        setRaw(j.raw || '');
        setOriginalRaw(j.raw || '');
        const p = j.parsed || {};
        setParsed(p);
        setVersion(p.version || '0.1.0');
        setDisplayName(p.displayName || '');
        setDescription(p.description || '');
        setTagsText((p.tags || []).join(', '));
        setAuthor(p.author || '');
        setShowWhen(p.ui?.showWhen || '');
        setHasFileText((p.requires?.hasFile || []).join('\n'));
        setHasGlobText((p.requires?.hasGlob || []).join('\n'));
        if (j.parseError) setError(`YAML parse error: ${j.parseError}`);
      })
      .catch(e => setError(e?.message || String(e)));
  }, [projectPath, craftName]);

  const dirty = useMemo(() => {
    if (tab === 'raw') return raw !== originalRaw;
    if (!parsed) return false;
    return (
      version !== (parsed.version || '0.1.0') ||
      displayName !== (parsed.displayName || '') ||
      description !== (parsed.description || '') ||
      tagsText !== (parsed.tags || []).join(', ') ||
      author !== (parsed.author || '') ||
      showWhen !== (parsed.ui?.showWhen || '') ||
      hasFileText !== (parsed.requires?.hasFile || []).join('\n') ||
      hasGlobText !== (parsed.requires?.hasGlob || []).join('\n')
    );
  }, [tab, raw, originalRaw, parsed, version, displayName, description, tagsText, author, showWhen, hasFileText, hasGlobText]);

  const save = async () => {
    setBusy(true); setError(null);
    try {
      let body: any;
      if (tab === 'raw') {
        body = { projectPath, name: craftName, raw };
      } else {
        const tags = tagsText.split(',').map(s => s.trim()).filter(Boolean);
        const hasFile = hasFileText.split('\n').map(s => s.trim()).filter(Boolean);
        const hasGlob = hasGlobText.split('\n').map(s => s.trim()).filter(Boolean);
        const requires = (hasFile.length || hasGlob.length) ? { hasFile, hasGlob } : undefined;
        const ui = parsed?.ui ? { ...parsed.ui, ...(showWhen ? { showWhen } : {}) } : (showWhen ? { tab: 'ui.tsx', showWhen } : { tab: 'ui.tsx' });
        const patch: any = {
          version, displayName, description, tags, author,
          ...(requires ? { requires } : {}),
          ui,
        };
        // Strip empty strings so they don't pollute the yaml
        for (const k of Object.keys(patch)) {
          if (patch[k] === '' || patch[k] === undefined) delete patch[k];
        }
        body = { projectPath, name: craftName, patch };
      }
      const r = await fetch('/api/craft-system/manifest', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!r.ok || j.error) throw new Error(j.error || `${r.status}`);
      setRaw(j.raw);
      setOriginalRaw(j.raw);
      // Re-parse for the form view
      try {
        const YAML = await import('yaml');
        const p = YAML.parse(j.raw);
        setParsed(p);
        if (onSaved) onSaved(p);
      } catch {}
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg shadow-2xl w-[640px] max-w-[95vw] max-h-[88vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="px-4 py-2.5 border-b border-[var(--border)] flex items-center gap-2">
          <span className="text-sm font-semibold text-[var(--text-primary)]">📝 Edit manifest: {craftName}</span>
          {dirty && <span className="text-[9px] px-1.5 py-0.5 rounded bg-yellow-500/20 text-yellow-300">unsaved</span>}
          <div className="flex-1" />
          <div className="flex bg-[var(--bg-tertiary)] rounded p-0.5">
            {(['form', 'raw'] as const).map(t => (
              <button key={t} onClick={() => setTab(t)}
                className={`text-[10px] px-2 py-0.5 rounded ${tab === t ? 'bg-[var(--bg-secondary)] text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'}`}>
                {t === 'form' ? 'Form' : 'YAML'}
              </button>
            ))}
          </div>
          <button onClick={onClose} className="text-[10px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]">✕</button>
        </div>

        {error && <div className="m-3 p-2 text-[11px] text-red-300 bg-red-500/10 border border-red-500/30 rounded">{error}</div>}

        {tab === 'form' && parsed && (
          <div className="p-4 space-y-3 overflow-auto flex-1">
            <Field label="Display name (tab label)">
              <input value={displayName} onChange={e => setDisplayName(e.target.value)}
                className="w-full text-xs bg-[var(--bg-tertiary)] border border-[var(--border)] rounded px-2 py-1" />
            </Field>

            <Field label="Version">
              <div className="flex gap-1 items-center">
                <input value={version} onChange={e => setVersion(e.target.value)}
                  className="flex-1 text-xs bg-[var(--bg-tertiary)] border border-[var(--border)] rounded px-2 py-1 font-mono" />
                <button onClick={() => setVersion(bumpVersion(version, 'patch'))}
                  className="text-[10px] px-2 py-1 rounded bg-[var(--bg-tertiary)] hover:bg-[var(--accent)]/20 hover:text-[var(--accent)]"
                  title="x.y.Z+1">patch</button>
                <button onClick={() => setVersion(bumpVersion(version, 'minor'))}
                  className="text-[10px] px-2 py-1 rounded bg-[var(--bg-tertiary)] hover:bg-[var(--accent)]/20 hover:text-[var(--accent)]"
                  title="x.Y+1.0">minor</button>
                <button onClick={() => setVersion(bumpVersion(version, 'major'))}
                  className="text-[10px] px-2 py-1 rounded bg-[var(--bg-tertiary)] hover:bg-[var(--accent)]/20 hover:text-[var(--accent)]"
                  title="X+1.0.0">major</button>
              </div>
            </Field>

            <Field label="Description (one line)">
              <input value={description} onChange={e => setDescription(e.target.value)}
                className="w-full text-xs bg-[var(--bg-tertiary)] border border-[var(--border)] rounded px-2 py-1" />
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Tags (comma-separated)">
                <input value={tagsText} onChange={e => setTagsText(e.target.value)}
                  placeholder="openapi, java, dashboard"
                  className="w-full text-xs bg-[var(--bg-tertiary)] border border-[var(--border)] rounded px-2 py-1 font-mono" />
              </Field>
              <Field label="Author (github handle)">
                <input value={author} onChange={e => setAuthor(e.target.value)}
                  className="w-full text-xs bg-[var(--bg-tertiary)] border border-[var(--border)] rounded px-2 py-1 font-mono" />
              </Field>
            </div>

            <Field label="Show tab when (optional)" hint="hasFile(&quot;path&quot;) or `always`. Empty = always show.">
              <input value={showWhen} onChange={e => setShowWhen(e.target.value)}
                placeholder='hasFile("docs/openapi.json")'
                className="w-full text-xs bg-[var(--bg-tertiary)] border border-[var(--border)] rounded px-2 py-1 font-mono" />
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Requires hasFile (one per line)" hint="OR — any one match = compatible">
                <textarea value={hasFileText} onChange={e => setHasFileText(e.target.value)}
                  placeholder="docs/openapi.json"
                  className="w-full text-xs bg-[var(--bg-tertiary)] border border-[var(--border)] rounded px-2 py-1 font-mono min-h-[60px]" />
              </Field>
              <Field label="Requires hasGlob (one per line)">
                <textarea value={hasGlobText} onChange={e => setHasGlobText(e.target.value)}
                  placeholder="**/*.java"
                  className="w-full text-xs bg-[var(--bg-tertiary)] border border-[var(--border)] rounded px-2 py-1 font-mono min-h-[60px]" />
              </Field>
            </div>
          </div>
        )}

        {tab === 'raw' && (
          <div className="flex-1 flex flex-col overflow-hidden p-3">
            <textarea
              value={raw} onChange={e => setRaw(e.target.value)}
              spellCheck={false}
              className="flex-1 text-[11px] font-mono bg-[var(--bg-tertiary)] border border-[var(--border)] rounded p-2 resize-none"
            />
            <div className="text-[9px] text-[var(--text-secondary)] mt-1 opacity-70">
              Direct YAML. The <code>name</code> field must stay as <code className="text-[var(--accent)]">{craftName}</code>.
            </div>
          </div>
        )}

        <div className="px-4 py-2 border-t border-[var(--border)] flex justify-end gap-2">
          <button onClick={onClose}
            className="text-xs px-3 py-1 rounded text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]">
            Cancel
          </button>
          <button onClick={save} disabled={!dirty || busy}
            className="text-xs px-3 py-1 rounded bg-[var(--accent)]/30 text-[var(--accent)] hover:bg-[var(--accent)]/40 disabled:opacity-40">
            {busy ? '⏳' : 'Save manifest'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] text-[var(--text-secondary)] flex items-center gap-2">
        {label}
        {hint && <span className="opacity-60 font-normal">{hint}</span>}
      </span>
      {children}
    </label>
  );
}
