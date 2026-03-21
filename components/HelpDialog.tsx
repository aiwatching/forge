'use client';

import { useState, useEffect, useRef, lazy, Suspense } from 'react';

interface DocItem {
  name: string;
  title: string;
}

const HelpTerminal = lazy(() => import('./HelpTerminal'));

export default function HelpDialog({ onClose }: { onClose: () => void }) {
  const [docs, setDocs] = useState<DocItem[]>([]);
  const [agent, setAgent] = useState<{ name: string } | null | undefined>(undefined); // undefined = loading
  const [viewDoc, setViewDoc] = useState<string | null>(null);
  const [docContent, setDocContent] = useState('');
  const [search, setSearch] = useState('');
  const [tab, setTab] = useState<'docs' | 'chat'>('docs');
  const [position, setPosition] = useState({ x: Math.max(0, window.innerWidth - 520), y: 50 });
  const [size, setSize] = useState({ w: 500, h: 560 });
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);
  const resizeRef = useRef<{ startX: number; startY: number; origW: number; origH: number } | null>(null);

  useEffect(() => {
    fetch('/api/help?action=status').then(r => r.json())
      .then(data => setAgent(data.agent || null)).catch(() => setAgent(null));
    fetch('/api/help?action=docs').then(r => r.json())
      .then(data => setDocs(data.docs || [])).catch(() => {});
  }, []);

  const loadDoc = async (name: string) => {
    setViewDoc(name);
    try {
      const res = await fetch(`/api/help?action=doc&name=${encodeURIComponent(name)}`);
      const data = await res.json();
      setDocContent(data.content || '');
    } catch { setDocContent('Failed to load'); }
  };

  // Drag
  const onDragStart = (e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startY: e.clientY, origX: position.x, origY: position.y };
    const onMove = (ev: MouseEvent) => {
      if (!dragRef.current) return;
      setPosition({
        x: Math.max(0, dragRef.current.origX + ev.clientX - dragRef.current.startX),
        y: Math.max(0, dragRef.current.origY + ev.clientY - dragRef.current.startY),
      });
    };
    const onUp = () => { dragRef.current = null; window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  // Resize
  const onResizeStart = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    resizeRef.current = { startX: e.clientX, startY: e.clientY, origW: size.w, origH: size.h };
    const onMove = (ev: MouseEvent) => {
      if (!resizeRef.current) return;
      setSize({
        w: Math.max(350, resizeRef.current.origW + ev.clientX - resizeRef.current.startX),
        h: Math.max(300, resizeRef.current.origH + ev.clientY - resizeRef.current.startY),
      });
    };
    const onUp = () => { resizeRef.current = null; window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const filtered = search ? docs.filter(d => d.title.toLowerCase().includes(search.toLowerCase())) : docs;

  return (
    <div
      className="fixed z-50 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg shadow-2xl flex flex-col overflow-hidden"
      style={{ left: position.x, top: position.y, width: size.w, height: size.h }}
    >
      {/* Title bar */}
      <div
        className="flex items-center gap-2 px-3 py-2 bg-[var(--bg-tertiary)] border-b border-[var(--border)] cursor-move shrink-0 select-none"
        onMouseDown={onDragStart}
      >
        <span className="text-[11px] font-semibold text-[var(--text-primary)]">Forge Help</span>
        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={() => { setTab('docs'); setViewDoc(null); }}
            className={`text-[9px] px-2 py-0.5 rounded ${tab === 'docs' ? 'bg-[var(--accent)]/20 text-[var(--accent)]' : 'text-[var(--text-secondary)]'}`}
          >Docs</button>
          {agent && (
            <button
              onClick={() => setTab('chat')}
              className={`text-[9px] px-2 py-0.5 rounded ${tab === 'chat' ? 'bg-[var(--accent)]/20 text-[var(--accent)]' : 'text-[var(--text-secondary)]'}`}
            >AI Chat</button>
          )}
          <button onClick={onClose} className="text-[var(--text-secondary)] hover:text-[var(--red)] ml-1 text-sm leading-none">✕</button>
        </div>
      </div>

      {tab === 'chat' ? (
        /* Embedded terminal */
        <div className="flex-1 min-h-0">
          <Suspense fallback={<div className="flex-1 flex items-center justify-center text-xs text-[var(--text-secondary)]">Loading terminal...</div>}>
            <HelpTerminal />
          </Suspense>
        </div>
      ) : viewDoc ? (
        /* Doc view */
        <>
          <div className="px-3 py-1.5 border-b border-[var(--border)] flex items-center gap-2 shrink-0">
            <button onClick={() => setViewDoc(null)} className="text-[10px] text-[var(--accent)]">← Back</button>
            <span className="text-[10px] text-[var(--text-primary)] font-semibold truncate">
              {docs.find(d => d.name === viewDoc)?.title || viewDoc}
            </span>
          </div>
          <div className="flex-1 overflow-y-auto p-3">
            <pre className="text-[11px] text-[var(--text-primary)] whitespace-pre-wrap break-words font-mono leading-relaxed">
              {docContent}
            </pre>
          </div>
        </>
      ) : (
        /* Doc list */
        <>
          <div className="px-3 py-2 border-b border-[var(--border)] shrink-0">
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search help topics..."
              className="w-full px-2 py-1 bg-[var(--bg-tertiary)] border border-[var(--border)] rounded text-[10px] text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)]"
              autoFocus
            />
          </div>
          {!agent && agent !== undefined && (
            <div className="px-3 py-2 bg-[var(--yellow)]/10 border-b border-[var(--border)] shrink-0">
              <p className="text-[9px] text-[var(--text-secondary)]">
                Install Claude Code for AI help: <code className="text-[var(--accent)]">npm i -g @anthropic-ai/claude-code</code>
              </p>
            </div>
          )}
          <div className="flex-1 overflow-y-auto">
            {filtered.map(doc => (
              <button
                key={doc.name}
                onClick={() => loadDoc(doc.name)}
                className="w-full text-left px-3 py-2.5 border-b border-[var(--border)]/30 hover:bg-[var(--bg-tertiary)] text-[11px] text-[var(--text-primary)] capitalize"
              >
                {doc.title}
              </button>
            ))}
          </div>
          <div className="px-3 py-2 border-t border-[var(--border)] shrink-0">
            <a href="https://github.com/aiwatching/forge" target="_blank" rel="noopener noreferrer"
              className="text-[9px] text-[var(--text-secondary)] hover:text-[var(--accent)]">GitHub →</a>
          </div>
        </>
      )}

      {/* Resize handle */}
      <div
        onMouseDown={onResizeStart}
        className="absolute bottom-0 right-0 w-4 h-4 cursor-se-resize"
        style={{ background: 'linear-gradient(135deg, transparent 50%, var(--border) 50%)' }}
      />
    </div>
  );
}
