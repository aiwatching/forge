'use client';

import { useState, useEffect, useRef, useCallback } from 'react';

interface Project { name: string; path: string }
interface SessionInfo { sessionId: string; summary?: string; firstPrompt?: string; modified?: string }
interface ChatMessage { role: 'user' | 'assistant' | 'system'; content: string; timestamp: string }

export default function MobileView() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [showSessions, setShowSessions] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [tunnelUrl, setTunnelUrl] = useState<string | null>(null);
  const [debug, setDebug] = useState<string[]>([]);
  const [showDebug, setShowDebug] = useState(false);
  const showDebugRef = useRef(false);
  const [hasSession, setHasSession] = useState(false); // whether to use -c flag
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Fetch projects
  useEffect(() => {
    fetch('/api/projects').then(r => r.json())
      .then(data => { if (Array.isArray(data)) setProjects(data); })
      .catch(() => {});
    fetch('/api/tunnel').then(r => r.json())
      .then(data => { setTunnelUrl(data.url || null); })
      .catch(() => {});
  }, []);

  // Auto-scroll
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages]);

  // Fetch sessions for project
  const fetchSessions = useCallback(async (projectName: string) => {
    try {
      const res = await fetch(`/api/claude-sessions/${encodeURIComponent(projectName)}`);
      const data = await res.json();
      const list = Array.isArray(data) ? data : [];
      setSessions(list);
      setHasSession(list.length > 0);
      return list;
    } catch { setSessions([]); return []; }
  }, []);

  // Load session history
  const loadHistory = useCallback(async (projectName: string, sessionId: string) => {
    try {
      const res = await fetch(`/api/claude-sessions/${encodeURIComponent(projectName)}/entries?sessionId=${encodeURIComponent(sessionId)}`);
      const data = await res.json();
      const entries = data.entries || [];
      // Convert entries to chat messages (only user + assistant_text)
      const chatMessages: ChatMessage[] = [];
      for (const e of entries) {
        if (e.type === 'user') {
          chatMessages.push({ role: 'user', content: e.content, timestamp: e.timestamp || '' });
        } else if (e.type === 'assistant_text') {
          chatMessages.push({ role: 'assistant', content: e.content, timestamp: e.timestamp || '' });
        }
      }
      setMessages(chatMessages);
    } catch {}
  }, []);

  // Select project
  const selectProject = useCallback(async (project: Project) => {
    setSelectedProject(project);
    setShowSessions(false);
    setMessages([]);

    const sessionList = await fetchSessions(project.name);
    // Load last session history if exists
    if (sessionList.length > 0) {
      await loadHistory(project.name, sessionList[0].sessionId);
    }
  }, [fetchSessions, loadHistory]);

  // View specific session
  const viewSession = useCallback(async (sessionId: string) => {
    if (!selectedProject) return;
    setShowSessions(false);
    setMessages([]);
    await loadHistory(selectedProject.name, sessionId);
  }, [selectedProject, loadHistory]);

  // Send message
  const sendMessage = async () => {
    const text = input.trim();
    if (!text || !selectedProject || loading) return;

    // Add user message
    setMessages(prev => [...prev, { role: 'user', content: text, timestamp: new Date().toISOString() }]);
    setInput('');
    setLoading(true);
    setDebug(d => [...d.slice(-20), `Send: "${text.slice(0, 40)}" resume=${hasSession}`]);
    inputRef.current?.focus();

    // Stream response from API
    const abort = new AbortController();
    abortRef.current = abort;
    let assistantText = '';

    try {
      const res = await fetch('/api/mobile-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: text,
          projectPath: selectedProject.path,
          resume: hasSession,
        }),
        signal: abort.signal,
      });

      const reader = res.body?.getReader();
      if (!reader) throw new Error('No reader');

      const decoder = new TextDecoder();

      // Add empty assistant message to fill in
      setMessages(prev => [...prev, { role: 'assistant', content: '...', timestamp: new Date().toISOString() }]);

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        for (const line of chunk.split('\n')) {
          if (!line.startsWith('data: ')) continue;
          try {
            const data = JSON.parse(line.slice(6));
            if (data.type === 'chunk') {
              assistantText += data.text;
              if (showDebugRef.current) setDebug(d => [...d.slice(-30), `chunk: +${data.text.length} chars`]);
            } else if (data.type === 'stderr') {
              if (showDebugRef.current) setDebug(d => [...d.slice(-30), `stderr: ${data.text.slice(0, 60)}`]);
            } else if (data.type === 'error') {
              assistantText = `Error: ${data.message}`;
            } else if (data.type === 'done') {
              if (showDebugRef.current) setDebug(d => [...d.slice(-30), `done: exit ${data.code}`]);
            }
          } catch {}
        }

        // Update assistant message with latest text
        if (assistantText) {
          let displayText = assistantText;
          try {
            const parsed = JSON.parse(assistantText);
            if (parsed.result) displayText = parsed.result;
          } catch {}
          setMessages(prev => {
            const updated = [...prev];
            updated[updated.length - 1] = { role: 'assistant', content: displayText, timestamp: new Date().toISOString() };
            return updated;
          });
        }
      }

      // Final parse
      try {
        const parsed = JSON.parse(assistantText);
        const finalText = parsed.result || assistantText;
        setMessages(prev => {
          const updated = [...prev];
          updated[updated.length - 1] = { role: 'assistant', content: finalText, timestamp: new Date().toISOString() };
          return updated;
        });
      } catch {}

      // After first message, future ones should use -c
      setHasSession(true);
      setDebug(d => [...d.slice(-20), `Response complete`]);
    } catch (e: any) {
      if (e.name !== 'AbortError') {
        setDebug(d => [...d.slice(-20), `Error: ${e.message}`]);
        setMessages(prev => [...prev.slice(0, -1), { role: 'system', content: `Failed: ${e.message}`, timestamp: new Date().toISOString() }]);
      }
    }

    setLoading(false);
    abortRef.current = null;
  };

  // Stop generation
  const stopGeneration = () => {
    if (abortRef.current) abortRef.current.abort();
  };

  // Close tunnel
  const closeTunnel = async () => {
    if (!confirm('Close tunnel? You will lose remote access.')) return;
    await fetch('/api/tunnel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'stop' }),
    });
    setTunnelUrl(null);
  };

  return (
    <div className="h-[100dvh] flex flex-col bg-[#0d1117] text-[#e6edf3]">
      {/* Header */}
      <header className="shrink-0 flex items-center gap-1.5 px-2 py-2 bg-[#161b22] border-b border-[#30363d]">
        <span className="text-xs font-bold text-[#7c5bf0]">Forge</span>
        <select
          value={selectedProject?.path || ''}
          onChange={e => {
            const p = projects.find(p => p.path === e.target.value);
            if (p) selectProject(p);
          }}
          className="flex-1 bg-[#0d1117] border border-[#30363d] rounded px-2 py-1 text-xs text-[#e6edf3] min-w-0"
        >
          <option value="">Project</option>
          {projects.map(p => (
            <option key={p.path} value={p.path}>{p.name}</option>
          ))}
        </select>
        {selectedProject && (
          <>
            <button
              onClick={() => { setShowSessions(v => !v); if (!showSessions) fetchSessions(selectedProject.name); }}
              className="text-xs px-2 py-1 border border-[#30363d] rounded text-[#8b949e] active:bg-[#30363d]"
            >Sessions</button>
            <button
              onClick={async () => {
                const list = await fetchSessions(selectedProject.name);
                if (list.length > 0) {
                  await loadHistory(selectedProject.name, list[0].sessionId);
                  setDebug(d => [...d.slice(-20), `Refreshed: ${list[0].sessionId.slice(0, 8)}`]);
                }
              }}
              className="text-sm px-3 py-1 border border-[#30363d] rounded text-[#8b949e] active:bg-[#30363d]"
            >↻</button>
          </>
        )}
        {tunnelUrl && (
          <button onClick={closeTunnel} className="text-xs px-1.5 py-1 border border-green-700 rounded text-green-400" title={tunnelUrl}>●</button>
        )}
      </header>

      {/* Session list */}
      {showSessions && (
        <div className="shrink-0 max-h-[40vh] overflow-y-auto bg-[#161b22] border-b border-[#30363d]">
          {sessions.length === 0 ? (
            <div className="px-3 py-4 text-xs text-[#8b949e] text-center">No sessions found</div>
          ) : sessions.map(s => (
            <button
              key={s.sessionId}
              onClick={() => viewSession(s.sessionId)}
              className="w-full text-left px-3 py-2 border-b border-[#30363d]/50 hover:bg-[#1c2128] text-xs"
            >
              <div className="flex items-center gap-2">
                <span className="text-[#e6edf3] font-mono truncate">{s.sessionId.slice(0, 12)}</span>
                {s.modified && <span className="text-[#8b949e] ml-auto shrink-0">{new Date(s.modified).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>}
              </div>
              {(s.summary || s.firstPrompt) && (
                <div className="text-[#8b949e] mt-0.5 truncate">{s.summary || s.firstPrompt}</div>
              )}
            </button>
          ))}
        </div>
      )}

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-2 min-h-0 space-y-3">
        {!selectedProject ? (
          <div className="h-full flex items-center justify-center text-sm text-[#8b949e]">
            Select a project to start
          </div>
        ) : messages.length === 0 ? (
          <div className="h-full flex items-center justify-center text-sm text-[#8b949e]">
            {hasSession ? 'Session loaded. Type a message.' : 'No sessions yet. Type a message to start.'}
          </div>
        ) : messages.map((msg, i) => (
          <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm whitespace-pre-wrap break-words ${
              msg.role === 'user'
                ? 'bg-[#7c5bf0] text-white rounded-br-sm'
                : msg.role === 'system'
                  ? 'bg-red-900/30 text-red-300 rounded-bl-sm'
                  : 'bg-[#1c2128] text-[#e6edf3] rounded-bl-sm'
            }`}>
              {msg.content}
            </div>
          </div>
        ))}
        {loading && (
          <div className="flex justify-start">
            <div className="bg-[#1c2128] rounded-2xl rounded-bl-sm px-3 py-2 text-sm text-[#8b949e]">
              Thinking...
            </div>
          </div>
        )}
      </div>

      {/* Input */}
      <div className="shrink-0 flex items-center gap-2 px-3 py-2 bg-[#161b22] border-t border-[#30363d]">
        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !loading) sendMessage(); }}
          placeholder={selectedProject ? 'Type a message...' : 'Select a project first'}
          disabled={!selectedProject}
          className="flex-1 bg-[#0d1117] border border-[#30363d] rounded-lg px-3 py-2 text-sm text-[#e6edf3] focus:outline-none focus:border-[#7c5bf0] disabled:opacity-50 min-w-0"
          autoComplete="off"
          autoCorrect="off"
        />
        {loading ? (
          <button
            onClick={stopGeneration}
            className="px-4 py-2 bg-red-600 text-white rounded-lg text-sm font-medium shrink-0"
          >Stop</button>
        ) : (
          <button
            onClick={sendMessage}
            disabled={!selectedProject || !input.trim()}
            className="px-4 py-2 bg-[#7c5bf0] text-white rounded-lg text-sm font-medium disabled:opacity-50 shrink-0"
          >Send</button>
        )}
      </div>

      {/* Debug log */}
      <details
        className="shrink-0 bg-[#0d1117] border-t border-[#30363d]"
        onToggle={(e) => { const open = (e.target as HTMLDetailsElement).open; setShowDebug(open); showDebugRef.current = open; }}
      >
        <summary className="px-3 py-1 text-[9px] text-[#8b949e] cursor-pointer">Debug {debug.length > 0 ? `(${debug.length})` : ''}</summary>
        <div className="px-3 py-1 max-h-32 overflow-y-auto">
          {debug.map((d, i) => <div key={i} className="text-[9px] text-[#8b949e] font-mono">{d}</div>)}
        </div>
      </details>
    </div>
  );
}
