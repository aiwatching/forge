'use client';

import { useState, useEffect, useRef, useCallback } from 'react';

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

interface DocItem {
  name: string;
  title: string;
}

export default function HelpDialog({ onClose }: { onClose: () => void }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [agent, setAgent] = useState<{ name: string; path: string } | null>(null);
  const [docs, setDocs] = useState<DocItem[]>([]);
  const [viewDoc, setViewDoc] = useState<string | null>(null);
  const [docContent, setDocContent] = useState('');
  const [tab, setTab] = useState<'chat' | 'docs'>('chat');
  const [position, setPosition] = useState({ x: window.innerWidth - 440, y: 60 });
  const [size, setSize] = useState({ w: 420, h: 520 });
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Check agent status
  useEffect(() => {
    fetch('/api/help?action=status').then(r => r.json())
      .then(data => { setAgent(data.agent); })
      .catch(() => {});
    fetch('/api/help?action=docs').then(r => r.json())
      .then(data => { setDocs(data.docs || []); })
      .catch(() => {});
  }, []);

  // Auto scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Focus input
  useEffect(() => { inputRef.current?.focus(); }, [tab]);

  const sendMessage = useCallback(async () => {
    if (!input.trim() || loading) return;
    const userMsg: Message = { role: 'user', content: input.trim() };
    const newMessages = [...messages, userMsg];
    setMessages(newMessages);
    setInput('');
    setLoading(true);

    try {
      const res = await fetch('/api/help', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'chat',
          message: userMsg.content,
          history: newMessages.slice(-10), // last 10 messages for context
        }),
      });
      const data = await res.json();
      if (data.error) {
        setMessages([...newMessages, { role: 'assistant', content: `Error: ${data.error}` }]);
      } else {
        setMessages([...newMessages, { role: 'assistant', content: data.response }]);
      }
    } catch {
      setMessages([...newMessages, { role: 'assistant', content: 'Failed to connect to help service.' }]);
    }
    setLoading(false);
  }, [input, messages, loading]);

  const loadDoc = async (name: string) => {
    setViewDoc(name);
    try {
      const res = await fetch(`/api/help?action=doc&name=${encodeURIComponent(name)}`);
      const data = await res.json();
      setDocContent(data.content || '');
    } catch { setDocContent('Failed to load'); }
  };

  // Drag handling
  const onDragStart = (e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startY: e.clientY, origX: position.x, origY: position.y };
    const onMove = (ev: MouseEvent) => {
      if (!dragRef.current) return;
      setPosition({
        x: Math.max(0, Math.min(window.innerWidth - size.w, dragRef.current.origX + ev.clientX - dragRef.current.startX)),
        y: Math.max(0, Math.min(window.innerHeight - 100, dragRef.current.origY + ev.clientY - dragRef.current.startY)),
      });
    };
    const onUp = () => {
      dragRef.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  // No agent → link to GitHub
  if (agent === null && !loading) {
    return null; // still loading status
  }

  return (
    <div
      className="fixed z-50 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg shadow-2xl flex flex-col overflow-hidden"
      style={{ left: position.x, top: position.y, width: size.w, height: size.h }}
    >
      {/* Title bar — draggable */}
      <div
        className="flex items-center gap-2 px-3 py-2 bg-[var(--bg-tertiary)] border-b border-[var(--border)] cursor-move shrink-0 select-none"
        onMouseDown={onDragStart}
      >
        <span className="text-[11px] font-semibold text-[var(--text-primary)]">Forge Help</span>
        {agent && <span className="text-[8px] text-[var(--green)]">{agent.name} connected</span>}
        <div className="ml-auto flex items-center gap-1">
          {/* Tab switcher */}
          <button
            onClick={() => setTab('chat')}
            className={`text-[9px] px-2 py-0.5 rounded ${tab === 'chat' ? 'bg-[var(--accent)]/20 text-[var(--accent)]' : 'text-[var(--text-secondary)]'}`}
          >Chat</button>
          <button
            onClick={() => { setTab('docs'); setViewDoc(null); }}
            className={`text-[9px] px-2 py-0.5 rounded ${tab === 'docs' ? 'bg-[var(--accent)]/20 text-[var(--accent)]' : 'text-[var(--text-secondary)]'}`}
          >Docs</button>
          <button onClick={onClose} className="text-[var(--text-secondary)] hover:text-[var(--red)] ml-1">✕</button>
        </div>
      </div>

      {tab === 'chat' ? (
        <>
          {/* Messages */}
          <div className="flex-1 overflow-y-auto p-3 space-y-3">
            {!agent ? (
              <div className="text-center space-y-2 py-4">
                <p className="text-xs text-[var(--text-secondary)]">No AI agent detected.</p>
                <a
                  href="https://github.com/aiwatching/forge"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-[var(--accent)] hover:underline"
                >
                  View documentation on GitHub →
                </a>
                <p className="text-[9px] text-[var(--text-secondary)] mt-2">
                  Install Claude Code to enable AI help:<br/>
                  <code className="text-[var(--accent)]">npm install -g @anthropic-ai/claude-code</code>
                </p>
              </div>
            ) : messages.length === 0 ? (
              <div className="text-center space-y-3 py-4">
                <p className="text-xs text-[var(--text-secondary)]">Ask me anything about Forge!</p>
                <div className="space-y-1">
                  {['How do I set up Telegram?', 'Configure remote access', 'How to create a pipeline?', 'Set up issue auto-fix'].map(q => (
                    <button
                      key={q}
                      onClick={() => { setInput(q); }}
                      className="block w-full text-left text-[10px] px-3 py-1.5 rounded bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--border)]"
                    >{q}</button>
                  ))}
                </div>
              </div>
            ) : (
              messages.map((msg, i) => (
                <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[85%] px-3 py-2 rounded-lg text-[11px] leading-relaxed ${
                    msg.role === 'user'
                      ? 'bg-[var(--accent)] text-white'
                      : 'bg-[var(--bg-tertiary)] text-[var(--text-primary)]'
                  }`}>
                    <pre className="whitespace-pre-wrap break-words font-sans">{msg.content}</pre>
                  </div>
                </div>
              ))
            )}
            {loading && (
              <div className="flex justify-start">
                <div className="px-3 py-2 rounded-lg bg-[var(--bg-tertiary)] text-[11px] text-[var(--text-secondary)]">
                  Thinking...
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* Input */}
          {agent && (
            <div className="px-3 py-2 border-t border-[var(--border)] shrink-0 flex gap-2">
              <input
                ref={inputRef}
                type="text"
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } }}
                placeholder="Ask about Forge..."
                className="flex-1 px-2 py-1 bg-[var(--bg-tertiary)] border border-[var(--border)] rounded text-[11px] text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)]"
                disabled={loading}
              />
              <button
                onClick={() => { setMessages([]); }}
                className="text-[9px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                title="Clear chat"
              >Clear</button>
              <button
                onClick={sendMessage}
                disabled={loading || !input.trim()}
                className="text-[9px] px-2 py-1 bg-[var(--accent)] text-white rounded hover:opacity-90 disabled:opacity-50"
              >Send</button>
            </div>
          )}
        </>
      ) : (
        /* Docs tab */
        <div className="flex-1 overflow-y-auto">
          {viewDoc ? (
            <>
              <div className="px-3 py-2 border-b border-[var(--border)] flex items-center gap-2 sticky top-0 bg-[var(--bg-secondary)]">
                <button onClick={() => setViewDoc(null)} className="text-[10px] text-[var(--accent)]">← Back</button>
                <span className="text-[10px] text-[var(--text-primary)] font-semibold">{viewDoc.replace(/^\d+-/, '').replace(/\.md$/, '')}</span>
              </div>
              <pre className="p-3 text-[11px] text-[var(--text-primary)] whitespace-pre-wrap break-words font-mono">
                {docContent}
              </pre>
            </>
          ) : (
            <div className="p-2">
              {docs.map(doc => (
                <button
                  key={doc.name}
                  onClick={() => loadDoc(doc.name)}
                  className="w-full text-left px-3 py-2 rounded hover:bg-[var(--bg-tertiary)] text-[11px] text-[var(--text-primary)] capitalize"
                >
                  {doc.title}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
