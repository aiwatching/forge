'use client';

import React, { useState, useEffect } from 'react';

interface PublishBundle {
  entry: any;
  files: { path: string; content: string }[];
  instructions: string[];
}

export default function CraftPublishModal({ projectPath, craftName, onClose }: {
  projectPath: string;
  craftName: string;
  onClose: () => void;
}) {
  const [bundle, setBundle] = useState<PublishBundle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<'instructions' | 'entry' | 'files'>('instructions');
  const [activeFile, setActiveFile] = useState<string>('');

  useEffect(() => {
    fetch('/api/craft-system/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectPath, name: craftName }),
    })
      .then(async r => { if (!r.ok) throw new Error((await r.json()).error || `${r.status}`); return r.json(); })
      .then((j: PublishBundle) => {
        setBundle(j);
        setActiveFile(j.files[0]?.path || '');
      })
      .catch(e => setError(e?.message || String(e)));
  }, [projectPath, craftName]);

  const copy = (text: string) => navigator.clipboard.writeText(text).catch(() => {});

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg shadow-2xl w-[820px] max-w-[95vw] h-[80vh] flex flex-col"
        onClick={e => e.stopPropagation()}>
        <div className="px-4 py-2.5 border-b border-[var(--border)] flex items-center gap-2">
          <span className="text-sm font-semibold text-[var(--text-primary)]">📦 Publish craft: {craftName}</span>
          <div className="flex-1" />
          <button onClick={onClose} className="text-[10px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]">✕</button>
        </div>

        {error && <div className="m-4 p-2 text-xs text-red-300 bg-red-500/10 border border-red-500/30 rounded">{error}</div>}
        {!bundle && !error && <div className="p-4 text-xs text-[var(--text-secondary)]">Bundling craft files…</div>}

        {bundle && (
          <>
            <div className="px-4 pt-2 flex gap-1 text-xs border-b border-[var(--border)]">
              {(['instructions', 'entry', 'files'] as const).map(t => (
                <button key={t} onClick={() => setTab(t)}
                  className={`px-3 py-1 rounded-t ${tab === t ? 'bg-[var(--bg-tertiary)] text-[var(--accent)]' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'}`}>
                  {t === 'instructions' ? 'How to publish' : t === 'entry' ? 'registry.json entry' : `Files (${bundle.files.length})`}
                </button>
              ))}
            </div>

            {tab === 'instructions' && (
              <div className="flex-1 overflow-auto p-4 text-[11px] text-[var(--text-primary)] space-y-2">
                <div className="text-[var(--text-secondary)] mb-2">
                  Forge doesn't have a one-click publish flow yet — the marketplace is a public GitHub repo
                  (<code className="text-[var(--accent)]">forge-crafts</code> by default), and publishing means opening a PR.
                </div>
                <ol className="list-decimal pl-5 space-y-1">
                  {bundle.instructions.map((line, i) => <li key={i}>{line}</li>)}
                </ol>
                <div className="mt-3 text-[var(--text-secondary)] text-[10px] opacity-70">
                  Tip: switch to the Files tab to copy each file's content; switch to the registry.json tab for the JSON snippet.
                </div>
              </div>
            )}

            {tab === 'entry' && (
              <div className="flex-1 overflow-auto p-4 flex flex-col">
                <div className="flex items-center mb-2">
                  <span className="text-[10px] text-[var(--text-secondary)]">Append this object to the <code>crafts</code> array in <code>registry.json</code>:</span>
                  <div className="flex-1" />
                  <button onClick={() => copy(JSON.stringify(bundle.entry, null, 2))}
                    className="text-[10px] px-2 py-1 rounded text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]">📋 Copy</button>
                </div>
                <pre className="flex-1 overflow-auto bg-[var(--bg-tertiary)]/40 rounded p-3 text-[11px] font-mono text-[var(--text-primary)] whitespace-pre-wrap">
                  {JSON.stringify(bundle.entry, null, 2)}
                </pre>
              </div>
            )}

            {tab === 'files' && (
              <div className="flex-1 flex min-h-0">
                <div className="w-48 border-r border-[var(--border)] overflow-auto">
                  {bundle.files.map(f => (
                    <button key={f.path} onClick={() => setActiveFile(f.path)}
                      className={`w-full text-left px-3 py-1.5 text-[11px] font-mono ${activeFile === f.path ? 'bg-[var(--accent)]/10 text-[var(--accent)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]'}`}>
                      {f.path}
                    </button>
                  ))}
                </div>
                <div className="flex-1 flex flex-col">
                  <div className="px-3 py-1.5 border-b border-[var(--border)] flex items-center text-[10px] text-[var(--text-secondary)]">
                    <span className="font-mono">{activeFile}</span>
                    <div className="flex-1" />
                    <button onClick={() => copy(bundle.files.find(f => f.path === activeFile)?.content || '')}
                      className="px-2 py-0.5 rounded hover:bg-[var(--bg-tertiary)]">📋 Copy</button>
                  </div>
                  <pre className="flex-1 overflow-auto p-3 text-[11px] font-mono text-[var(--text-primary)] whitespace-pre-wrap break-words">
                    {bundle.files.find(f => f.path === activeFile)?.content}
                  </pre>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
