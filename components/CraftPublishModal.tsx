'use client';

import React, { useState, useEffect } from 'react';

interface PublishBundle {
  entry: any;
  files: { path: string; content: string }[];
  fileLinks?: { path: string; githubUrl: string }[];
  repo?: { owner: string; name: string; url: string };
  registryEditUrl?: string;
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
              <div className="flex-1 overflow-auto p-4 text-[11px] text-[var(--text-primary)] space-y-3">
                <div className="text-[var(--text-secondary)]">
                  Every publish goes through a pull request to{' '}
                  {bundle.repo
                    ? <a href={bundle.repo.url} target="_blank" rel="noreferrer" className="text-[var(--accent)] hover:underline">{bundle.repo.owner}/{bundle.repo.name}</a>
                    : 'the registry'} — GitHub auto-forks the repo if you don't have write access. Maintainers also use the PR flow; direct commits to main are not accepted.
                </div>
                <ol className="list-decimal pl-5 space-y-1.5">
                  {bundle.instructions.map((line, i) => <li key={i}>{line}</li>)}
                </ol>

                {bundle.fileLinks && bundle.fileLinks.length > 0 && (
                  <div className="mt-3 border border-[var(--border)] rounded p-2.5 space-y-1.5">
                    <div className="text-[10px] text-[var(--text-secondary)] mb-1">Step 1: Create each file in your fork (one click each)</div>
                    {bundle.fileLinks.map(fl => (
                      <a key={fl.path} href={fl.githubUrl} target="_blank" rel="noreferrer"
                        className="flex items-center gap-2 px-2 py-1.5 rounded bg-[var(--bg-tertiary)] hover:bg-[var(--accent)]/10 border border-[var(--border)] transition-colors">
                        <span className="text-[11px] font-mono text-[var(--text-primary)] flex-1">
                          {bundle.entry.name}/{fl.path}
                        </span>
                        <span className="text-[10px] px-2 py-0.5 rounded bg-[var(--accent)]/20 text-[var(--accent)]">
                          Open in GitHub →
                        </span>
                      </a>
                    ))}
                  </div>
                )}

                {bundle.registryEditUrl && (
                  <div className="border border-[var(--border)] rounded p-2.5 space-y-1.5">
                    <div className="text-[10px] text-[var(--text-secondary)] mb-1">Step 2: Append your craft to registry.json</div>
                    <a href={bundle.registryEditUrl} target="_blank" rel="noreferrer"
                      className="flex items-center gap-2 px-2 py-1.5 rounded bg-[var(--bg-tertiary)] hover:bg-[var(--accent)]/10 border border-[var(--border)] transition-colors">
                      <span className="text-[11px] font-mono text-[var(--text-primary)] flex-1">registry.json</span>
                      <button onClick={(e) => { e.preventDefault(); e.stopPropagation(); copy(JSON.stringify(bundle.entry, null, 2)); }}
                        className="text-[10px] px-2 py-0.5 rounded text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
                        title="Copy entry JSON to clipboard before opening editor">
                        📋 Copy entry
                      </button>
                      <span className="text-[10px] px-2 py-0.5 rounded bg-[var(--accent)]/20 text-[var(--accent)]">
                        Open editor →
                      </span>
                    </a>
                    <div className="text-[9px] text-[var(--text-secondary)] opacity-70">
                      In the editor, paste the entry inside the <code>crafts: [...]</code> array, then commit + open PR.
                    </div>
                  </div>
                )}

                <div className="mt-3 text-[var(--text-secondary)] text-[10px] opacity-70">
                  Need an alternative? Use the Files tab to copy each file's content manually, or the registry.json entry tab to copy the JSON snippet.
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
