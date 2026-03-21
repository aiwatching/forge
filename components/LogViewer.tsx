'use client';

import { useState, useEffect, useRef, useCallback } from 'react';

export default function LogViewer() {
  const [lines, setLines] = useState<string[]>([]);
  const [total, setTotal] = useState(0);
  const [fileSize, setFileSize] = useState(0);
  const [filePath, setFilePath] = useState('');
  const [search, setSearch] = useState('');
  const [maxLines, setMaxLines] = useState(200);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [processes, setProcesses] = useState<{ pid: string; cpu: string; mem: string; cmd: string }[]>([]);
  const [showProcesses, setShowProcesses] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  const fetchLogs = useCallback(async () => {
    try {
      const res = await fetch(`/api/logs?lines=${maxLines}${search ? `&search=${encodeURIComponent(search)}` : ''}`);
      const data = await res.json();
      setLines(data.lines || []);
      setTotal(data.total || 0);
      setFileSize(data.size || 0);
      if (data.file) setFilePath(data.file);
    } catch {}
  }, [maxLines, search]);

  const fetchProcesses = async () => {
    try {
      const res = await fetch('/api/logs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'processes' }),
      });
      const data = await res.json();
      setProcesses(data.processes || []);
    } catch {}
  };

  const clearLogs = async () => {
    if (!confirm('Clear all logs?')) return;
    await fetch('/api/logs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'clear' }),
    });
    fetchLogs();
  };

  // Initial + auto refresh
  useEffect(() => { fetchLogs(); }, [fetchLogs]);
  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(fetchLogs, 3000);
    return () => clearInterval(id);
  }, [autoRefresh, fetchLogs]);

  // Auto scroll
  useEffect(() => {
    if (autoScroll) bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [lines, autoScroll]);

  // Detect manual scroll
  const onScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
    setAutoScroll(atBottom);
  };

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const getLineColor = (line: string) => {
    if (line.includes('[error]') || line.includes('Error') || line.includes('FATAL')) return 'text-red-400';
    if (line.includes('[warn]') || line.includes('Warning') || line.includes('WARN')) return 'text-yellow-400';
    if (line.includes('[forge]') || line.includes('[init]')) return 'text-cyan-400';
    if (line.includes('[task]') || line.includes('[pipeline]')) return 'text-green-400';
    if (line.includes('[telegram]') || line.includes('[terminal]')) return 'text-purple-400';
    if (line.includes('[issue-scanner]') || line.includes('[watcher]')) return 'text-orange-300';
    return 'text-[var(--text-primary)]';
  };

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-[var(--border)] shrink-0 flex-wrap">
        <span className="text-xs font-semibold text-[var(--text-primary)]">Logs</span>
        <span className="text-[8px] text-[var(--text-secondary)]">{total} lines · {formatSize(fileSize)}</span>

        {/* Search */}
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Filter..."
          className="px-2 py-0.5 bg-[var(--bg-tertiary)] border border-[var(--border)] rounded text-[10px] text-[var(--text-primary)] w-32 focus:outline-none focus:border-[var(--accent)]"
        />

        {/* Max lines */}
        <select
          value={maxLines}
          onChange={e => setMaxLines(Number(e.target.value))}
          className="px-1 py-0.5 bg-[var(--bg-tertiary)] border border-[var(--border)] rounded text-[10px] text-[var(--text-primary)]"
        >
          <option value={100}>100 lines</option>
          <option value={200}>200 lines</option>
          <option value={500}>500 lines</option>
          <option value={1000}>1000 lines</option>
        </select>

        <div className="ml-auto flex items-center gap-2">
          {/* Auto refresh toggle */}
          <label className="flex items-center gap-1 text-[9px] text-[var(--text-secondary)] cursor-pointer">
            <input type="checkbox" checked={autoRefresh} onChange={e => setAutoRefresh(e.target.checked)} className="accent-[var(--accent)]" />
            Auto (3s)
          </label>

          {/* Processes */}
          <button
            onClick={() => { setShowProcesses(v => !v); fetchProcesses(); }}
            className={`text-[9px] px-2 py-0.5 rounded ${showProcesses ? 'bg-[var(--accent)]/20 text-[var(--accent)]' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'}`}
          >Processes</button>

          {/* Refresh */}
          <button onClick={fetchLogs} className="text-[9px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]">↻</button>

          {/* Clear */}
          <button onClick={clearLogs} className="text-[9px] text-[var(--red)] hover:underline">Clear</button>
        </div>
      </div>

      {/* Processes panel */}
      {showProcesses && processes.length > 0 && (
        <div className="border-b border-[var(--border)] bg-[var(--bg-tertiary)] max-h-32 overflow-y-auto shrink-0">
          <div className="px-4 py-1 text-[8px] text-[var(--text-secondary)] uppercase">Running Processes</div>
          {processes.map(p => (
            <div key={p.pid} className="px-4 py-0.5 text-[10px] font-mono flex gap-3">
              <span className="text-[var(--accent)] w-12 shrink-0">{p.pid}</span>
              <span className="text-green-400 w-10 shrink-0">{p.cpu}%</span>
              <span className="text-yellow-400 w-10 shrink-0">{p.mem}%</span>
              <span className="text-[var(--text-secondary)] truncate">{p.cmd}</span>
            </div>
          ))}
        </div>
      )}

      {/* Log content */}
      <div
        ref={containerRef}
        onScroll={onScroll}
        className="flex-1 overflow-auto bg-[var(--bg-primary)] font-mono text-[11px] leading-[1.6]"
      >
        {lines.length === 0 ? (
          <div className="flex items-center justify-center h-full text-[var(--text-secondary)] text-xs">
            {filePath ? 'No log entries' : 'Log file not found — server running in foreground?'}
          </div>
        ) : (
          <div className="p-3">
            {lines.map((line, i) => (
              <div key={i} className={`${getLineColor(line)} hover:bg-[var(--bg-tertiary)] px-1`}>
                {search ? (
                  // Highlight search matches
                  line.split(new RegExp(`(${search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi')).map((part, j) =>
                    part.toLowerCase() === search.toLowerCase()
                      ? <span key={j} className="bg-[var(--yellow)]/30 text-[var(--yellow)]">{part}</span>
                      : part
                  )
                ) : line}
              </div>
            ))}
            <div ref={bottomRef} />
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="px-4 py-1 border-t border-[var(--border)] shrink-0 flex items-center gap-2 text-[8px] text-[var(--text-secondary)]">
        <span>{filePath}</span>
        {!autoScroll && (
          <button
            onClick={() => { setAutoScroll(true); bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }}
            className="ml-auto text-[var(--accent)] hover:underline"
          >↓ Scroll to bottom</button>
        )}
      </div>
    </div>
  );
}
