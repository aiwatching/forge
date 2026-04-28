'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';

const TEMPLATES = [
  { label: '📊 Dashboard', text: 'A dashboard view that shows ' },
  { label: '🔍 Explorer', text: 'An explorer for browsing ' },
  { label: '⚡ Runner', text: 'A panel that runs ' },
  { label: '📝 Editor', text: 'An editor for ' },
  { label: '🧪 Tester', text: 'A tester that validates ' },
];

interface LogLine {
  text: string;
  kind: 'system' | 'user' | 'assistant' | 'tool' | 'result' | 'error';
  ts: number;
}

function classify(entry: any): LogLine['kind'] {
  if (entry?.subtype === 'error') return 'error';
  if (entry?.type === 'result') return 'result';
  if (entry?.type === 'system') return 'system';
  if (entry?.type === 'user') return 'user';
  if (entry?.type === 'assistant') return 'assistant';
  if (entry?.type === 'tool_use' || entry?.type === 'tool_result') return 'tool';
  return 'system';
}

function entryToText(entry: any): string {
  if (typeof entry?.text === 'string') return entry.text;
  if (typeof entry?.content === 'string') return entry.content;
  if (Array.isArray(entry?.content)) {
    return entry.content.map((c: any) => c?.text || c?.input?.command || c?.name || '').filter(Boolean).join(' ');
  }
  if (entry?.message?.content) {
    if (Array.isArray(entry.message.content)) {
      return entry.message.content.map((c: any) => c?.text || c?.input?.command || c?.name || '').filter(Boolean).join(' ');
    }
    return String(entry.message.content);
  }
  return JSON.stringify(entry).slice(0, 300);
}

const KIND_STYLE: Record<LogLine['kind'], string> = {
  system: 'text-gray-400',
  user: 'text-cyan-300',
  assistant: 'text-emerald-300',
  tool: 'text-yellow-300',
  result: 'text-emerald-400 font-semibold',
  error: 'text-red-400',
};

export function CraftBuilderModal({ projectPath, projectName, refineCraftName, onClose, onCreated }: {
  projectPath: string;
  projectName: string;
  refineCraftName?: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [log, setLog] = useState<LogLine[]>([]);
  const esRef = useRef<EventSource | null>(null);
  const logEndRef = useRef<HTMLDivElement | null>(null);
  const refining = !!refineCraftName;

  useEffect(() => {
    return () => { esRef.current?.close(); };
  }, []);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [log.length]);

  const cancel = useCallback(async () => {
    if (!taskId) return;
    await fetch(`/api/tasks/${taskId}/cancel`, { method: 'POST' }).catch(() => {});
    esRef.current?.close();
    setBusy(false);
    setLog(prev => [...prev, { text: '⛔ cancelled', kind: 'error', ts: Date.now() }]);
  }, [taskId]);

  const submit = async () => {
    if (!text.trim()) return;
    setBusy(true);
    setDone(false);
    setLog([{ text: '🚀 Spawning craft-builder task…', kind: 'system', ts: Date.now() }]);
    const res = await fetch('/api/craft-system/build', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectPath, projectName, request: text, craftName: refineCraftName }),
    });
    const j = await res.json();
    if (!j.ok) { setLog(prev => [...prev, { text: `❌ ${j.error || 'unknown'}`, kind: 'error', ts: Date.now() }]); setBusy(false); return; }
    setTaskId(j.taskId);
    setLog(prev => [...prev, { text: `📌 task ${j.taskId} started — Claude is generating files`, kind: 'system', ts: Date.now() }]);

    const es = new EventSource(`/api/tasks/${j.taskId}/stream`);
    esRef.current = es;
    es.onmessage = ev => {
      try {
        const d = JSON.parse(ev.data);
        if (d.type === 'log' && d.entry) {
          const kind = classify(d.entry);
          const text = entryToText(d.entry);
          if (text) setLog(prev => [...prev, { text, kind, ts: Date.now() }]);
        } else if (d.type === 'complete') {
          setLog(prev => [...prev, { text: '✅ Craft generation complete', kind: 'result', ts: Date.now() }]);
          setBusy(false);
          setDone(true);
          es.close();
          onCreated();   // refresh craft list, but keep modal open
        }
      } catch {}
    };
    es.onerror = () => { es.close(); setBusy(false); };
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={busy ? undefined : onClose}>
      <div className="bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg shadow-2xl w-[900px] max-w-[95vw] h-[80vh] flex flex-col"
        onClick={e => e.stopPropagation()}>
        <div className="px-4 py-2.5 border-b border-[var(--border)] flex items-center gap-2">
          <span className="text-sm font-semibold text-[var(--text-primary)]">
            {refining ? `⚙ Refine craft: ${refineCraftName}` : '+ New Craft'}
          </span>
          {busy && <span className="text-[10px] px-2 py-0.5 rounded bg-yellow-500/20 text-yellow-300 animate-pulse">running</span>}
          {done && <span className="text-[10px] px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300">done</span>}
          {taskId && <a href={`/?task=${taskId}`} target="_blank" rel="noreferrer" className="text-[10px] text-[var(--accent)] hover:underline">task {taskId} ↗</a>}
          <div className="flex-1" />
          {busy && <button onClick={cancel} className="text-[10px] px-2 py-1 rounded bg-red-500/20 text-red-300 hover:bg-red-500/30">⛔ Cancel</button>}
          <button onClick={onClose} className="text-[10px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]">✕</button>
        </div>

        {/* Input area */}
        <div className="px-4 py-3 border-b border-[var(--border)] space-y-2 shrink-0">
          {!refining && !taskId && (
            <div className="flex flex-wrap gap-1">
              {TEMPLATES.map(t => (
                <button key={t.label} onClick={() => setText(t.text)}
                  className="text-[10px] px-2 py-1 rounded bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:bg-[var(--accent)]/20 hover:text-[var(--accent)]">
                  {t.label}
                </button>
              ))}
            </div>
          )}
          <textarea
            value={text}
            onChange={e => setText(e.target.value)}
            autoFocus
            disabled={busy}
            placeholder={refining
              ? 'e.g. add a column for last-modified date'
              : 'e.g. dashboard of all our REST endpoints with migration status, allow batch run + AI fix on failures'}
            className="w-full text-xs bg-[var(--bg-tertiary)] border border-[var(--border)] rounded px-3 py-2 font-mono min-h-[80px] resize-vertical disabled:opacity-50"
          />
          <div className="flex justify-between items-center">
            <span className="text-[9px] text-[var(--text-secondary)] opacity-70">
              {refining ? 'Existing craft files will be re-fed; AI applies a minimal change.' : 'Forge spawns a Claude task in this project; the live log shows below.'}
            </span>
            <div className="flex gap-2">
              {done && (
                <button onClick={() => { setText(''); setLog([]); setDone(false); setTaskId(null); }}
                  className="text-xs px-3 py-1 rounded text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]">
                  + Another
                </button>
              )}
              <button onClick={submit} disabled={busy || !text.trim()}
                className="text-xs px-3 py-1 rounded bg-[var(--accent)]/30 text-[var(--accent)] hover:bg-[var(--accent)]/40 disabled:opacity-40">
                {busy ? '⏳ Generating…' : (refining ? 'Apply changes' : 'Generate craft')}
              </button>
            </div>
          </div>
        </div>

        {/* Terminal-style log */}
        <div className="flex-1 overflow-auto bg-black/60 p-3 text-[11px] font-mono leading-relaxed min-h-0">
          {log.length === 0 && <div className="text-[var(--text-secondary)] opacity-60">Type your request above and click Generate. Output will appear here.</div>}
          {log.map((line, i) => (
            <div key={i} className={`whitespace-pre-wrap break-all ${KIND_STYLE[line.kind]}`}>
              <span className="text-gray-600 select-none">[{new Date(line.ts).toLocaleTimeString()}]</span> {line.text}
            </div>
          ))}
          <div ref={logEndRef} />
        </div>

        {/* Footer */}
        <div className="px-4 py-2 border-t border-[var(--border)] flex items-center justify-between text-[10px] text-[var(--text-secondary)]">
          <span>{log.length} log lines{taskId ? ` · task ${taskId}` : ''}</span>
          <div className="flex gap-2">
            {done && (
              <button onClick={onClose}
                className="text-xs px-3 py-1 rounded bg-emerald-500/20 text-emerald-300 hover:bg-emerald-500/30">
                ✓ Open new tab
              </button>
            )}
            <button onClick={onClose}
              className="text-xs px-3 py-1 rounded text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]">
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
