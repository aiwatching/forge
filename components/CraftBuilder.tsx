'use client';

import React, { useState, useEffect, useRef } from 'react';

const TEMPLATES = [
  { label: '📊 Dashboard', text: 'A dashboard view that shows ' },
  { label: '🔍 Explorer', text: 'An explorer for browsing ' },
  { label: '⚡ Runner', text: 'A panel that runs ' },
  { label: '📝 Editor', text: 'An editor for ' },
  { label: '🧪 Tester', text: 'A tester that validates ' },
];

export function CraftBuilderModal({ projectPath, projectName, refineCraftName, onClose, onCreated }: {
  projectPath: string;
  projectName: string;
  refineCraftName?: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const esRef = useRef<EventSource | null>(null);
  const refining = !!refineCraftName;

  useEffect(() => () => { esRef.current?.close(); }, []);

  const submit = async () => {
    if (!text.trim()) return;
    setBusy(true);
    setLog([]);
    const res = await fetch('/api/crafts/_build', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectPath, projectName, request: text, craftName: refineCraftName }),
    });
    const j = await res.json();
    if (!j.ok) { setLog([`Failed: ${j.error || 'unknown'}`]); setBusy(false); return; }
    setTaskId(j.taskId);
    const es = new EventSource(`/api/tasks/${j.taskId}/stream`);
    esRef.current = es;
    es.onmessage = ev => {
      try {
        const d = JSON.parse(ev.data);
        if (d.type === 'log' && d.entry) {
          const text = typeof d.entry.text === 'string' ? d.entry.text : JSON.stringify(d.entry).slice(0, 200);
          setLog(prev => [...prev, text].slice(-200));
        } else if (d.type === 'complete') {
          setLog(prev => [...prev, '✓ Done']);
          setBusy(false);
          es.close();
          // Wait a beat then refresh craft list
          setTimeout(() => { onCreated(); }, 600);
        }
      } catch {}
    };
    es.onerror = () => { es.close(); setBusy(false); };
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg shadow-xl w-[640px] max-w-[95vw] max-h-[90vh] flex flex-col"
        onClick={e => e.stopPropagation()}>
        <div className="px-4 py-2.5 border-b border-[var(--border)] flex items-center gap-2">
          <span className="text-sm font-semibold text-[var(--text-primary)]">
            {refining ? `⚙ Refine craft: ${refineCraftName}` : '+ New Craft'}
          </span>
          <div className="flex-1" />
          <button onClick={onClose} className="text-[10px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]">✕</button>
        </div>

        <div className="p-4 space-y-3 flex-1 overflow-auto">
          {!refining && (
            <div>
              <div className="text-[10px] text-[var(--text-secondary)] mb-1">Quick start templates</div>
              <div className="flex flex-wrap gap-1">
                {TEMPLATES.map(t => (
                  <button key={t.label} onClick={() => setText(t.text)}
                    className="text-[10px] px-2 py-1 rounded bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:bg-[var(--accent)]/20 hover:text-[var(--accent)]">
                    {t.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div>
            <div className="text-[10px] text-[var(--text-secondary)] mb-1">
              {refining ? 'What should change?' : 'What should this craft do?'}
            </div>
            <textarea
              value={text}
              onChange={e => setText(e.target.value)}
              autoFocus
              disabled={busy}
              placeholder={refining
                ? 'e.g. add a column for last-modified date'
                : 'e.g. dashboard of all our REST endpoints with migration status, allow batch run + AI fix on failures'}
              className="w-full text-xs bg-[var(--bg-tertiary)] border border-[var(--border)] rounded px-3 py-2 font-mono min-h-[120px] resize-vertical"
            />
            <div className="text-[9px] text-[var(--text-secondary)] mt-1 opacity-70">
              Forge will spawn a background task in this project that uses the <code>craft-builder</code> skill to generate the files.
            </div>
          </div>

          {(busy || log.length > 0) && (
            <div className="bg-black/30 rounded p-2 text-[10px] font-mono max-h-48 overflow-auto">
              {log.length === 0 && <div className="text-[var(--text-secondary)]">Starting…</div>}
              {log.slice(-30).map((l, i) => <div key={i} className="text-[var(--text-primary)] whitespace-pre-wrap break-all opacity-80">{l}</div>)}
            </div>
          )}
        </div>

        <div className="px-4 py-2 border-t border-[var(--border)] flex justify-end gap-2">
          <button onClick={onClose}
            className="text-xs px-3 py-1 rounded text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]">
            Close
          </button>
          {taskId && (
            <a href={`/?task=${taskId}`} target="_blank" rel="noreferrer"
              className="text-xs px-3 py-1 rounded text-[var(--accent)] hover:bg-[var(--accent)]/10">
              Open task →
            </a>
          )}
          <button onClick={submit} disabled={busy || !text.trim()}
            className="text-xs px-3 py-1 rounded bg-[var(--accent)]/30 text-[var(--accent)] hover:bg-[var(--accent)]/40 disabled:opacity-40">
            {busy ? '⏳ Generating…' : (refining ? 'Apply changes' : 'Generate craft')}
          </button>
        </div>
      </div>
    </div>
  );
}
