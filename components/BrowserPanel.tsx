'use client';

import { useState, useEffect, useRef, useCallback } from 'react';

interface PreviewEntry {
  port: number;
  url: string | null;
  status: string;
  label?: string;
}

export default function BrowserPanel({ onClose }: { onClose?: () => void }) {
  const [browserUrl, setBrowserUrl] = useState(() => typeof window !== 'undefined' ? localStorage.getItem('forge-browser-url') || '' : '');
  const [browserKey, setBrowserKey] = useState(0);
  const [previews, setPreviews] = useState<PreviewEntry[]>([]);
  const [tunnelStarting, setTunnelStarting] = useState(false);
  const browserUrlRef = useRef<HTMLInputElement>(null);
  const isRemote = typeof window !== 'undefined' && !['localhost', '127.0.0.1'].includes(window.location.hostname);

  const fetchPreviews = useCallback(() => {
    fetch('/api/preview').then(r => r.json()).then(data => {
      if (Array.isArray(data)) setPreviews(data.filter((p: any) => p.status === 'running'));
    }).catch(() => {});
  }, []);

  useEffect(() => {
    fetchPreviews();
    const timer = setInterval(fetchPreviews, 10000);
    return () => clearInterval(timer);
  }, [fetchPreviews]);

  const normalizeUrl = (val: string): string => {
    if (/^\d+$/.test(val)) return `http://localhost:${val}`;
    if (!/^https?:\/\//i.test(val)) return `http://${val}`;
    return val;
  };

  const navigate = (url: string) => {
    const normalized = normalizeUrl(url);
    setBrowserUrl(normalized);
    localStorage.setItem('forge-browser-url', normalized);
    if (browserUrlRef.current) browserUrlRef.current.value = normalized;
    setBrowserKey(k => k + 1);
  };

  const handleTunnel = async () => {
    const input = prompt('Enter port(s) to create tunnel (e.g. 3100 or 3100,8080):');
    if (!input) return;
    const ports = input.split(',').map(s => parseInt(s.trim())).filter(p => p > 0 && p <= 65535);
    if (ports.length === 0) { alert('Invalid port(s)'); return; }
    setTunnelStarting(true);
    const results: string[] = [];
    for (const port of ports) {
      try {
        const res = await fetch('/api/preview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'start', port }),
        });
        const data = await res.json();
        if (data.url) {
          results.push(data.url);
          setPreviews(prev => {
            const exists = prev.find(p => p.port === port);
            if (exists) return prev.map(p => p.port === port ? { ...p, url: data.url, status: 'running' } : p);
            return [...prev, { port, url: data.url, status: 'running' }];
          });
        } else if (data.status === 'starting' || data.status === 'stopped') {
          // Tunnel started but URL not ready yet or exited
          results.push('');
        } else {
          alert(`Port ${port}: ${data.error || 'Failed'}`);
        }
      } catch { alert(`Port ${port}: Failed to start tunnel`); }
    }
    // Navigate to first successful URL
    const firstUrl = results.find(u => u);
    if (firstUrl) navigate(firstUrl);
    // Refresh list to pick up any that were still starting
    setTimeout(fetchPreviews, 3000);
    setTunnelStarting(false);
  };

  const stopTunnel = async (port: number) => {
    await fetch('/api/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'stop', port }),
    });
    setPreviews(prev => prev.filter(x => x.port !== port));
  };

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* URL bar */}
      <div className="flex items-center gap-1 px-2 py-1 border-b border-[var(--border)] bg-[var(--bg-tertiary)] shrink-0">
        <input
          ref={browserUrlRef}
          type="text"
          defaultValue={browserUrl}
          placeholder="Enter URL"
          onKeyDown={e => {
            if (e.key === 'Enter') {
              const val = (e.target as HTMLInputElement).value.trim();
              if (!val) return;
              navigate(val);
            }
          }}
          className="flex-1 bg-[var(--bg-secondary)] border border-[var(--border)] rounded px-2 py-0.5 text-[10px] text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)] min-w-0"
        />
        <button onClick={() => setBrowserKey(k => k + 1)} className="text-[10px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] px-1" title="Refresh">↻</button>
        <button onClick={() => window.open(browserUrl, '_blank')} className="text-[10px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] px-1" title="Open in new tab">↗</button>
        <button
          disabled={tunnelStarting}
          onClick={handleTunnel}
          className="text-[9px] px-1.5 py-0.5 rounded border border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:border-[var(--accent)] disabled:opacity-50"
          title="Create tunnel for a port (remote access)"
        >{tunnelStarting ? 'Starting...' : 'Tunnel'}</button>
        {onClose && (
          <button onClick={onClose} className="text-[10px] text-[var(--text-secondary)] hover:text-[var(--red)] px-1" title="Close">✕</button>
        )}
      </div>
      {/* Active tunnels bar */}
      {previews.length > 0 && (
        <div className="flex items-center gap-1 px-2 py-0.5 border-b border-[var(--border)]/50 bg-[var(--bg-secondary)] shrink-0 overflow-x-auto">
          {previews.map(p => (
            <div key={p.port} className="flex items-center gap-1 shrink-0">
              <button
                onClick={() => {
                  const url = isRemote && p.url ? p.url : `http://localhost:${p.port}`;
                  navigate(url);
                }}
                className="text-[9px] px-1.5 py-0.5 rounded bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
              >
                <span className="text-green-400 mr-0.5">●</span>
                :{p.port}
              </button>
              {p.url && (
                <button
                  onClick={() => navigator.clipboard.writeText(p.url!).then(() => alert('Tunnel URL copied'))}
                  className="text-[8px] text-green-400 hover:underline truncate max-w-[120px]"
                  title={p.url}
                >{p.url.replace('https://', '').slice(0, 20)}...</button>
              )}
              <button onClick={() => stopTunnel(p.port)} className="text-[8px] text-red-400 hover:text-red-300">✕</button>
            </div>
          ))}
        </div>
      )}
      {/* Content */}
      <div className="flex-1 relative">
        {tunnelStarting && (
          <div className="absolute inset-0 flex items-center justify-center text-[var(--text-secondary)] text-xs z-10 bg-[var(--bg-primary)]/80">
            Creating tunnel... this may take up to 30 seconds
          </div>
        )}
        {browserUrl ? (
          <iframe
            key={browserKey}
            src={browserUrl}
            className="absolute inset-0 w-full h-full border-0 bg-white"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-[var(--text-secondary)] text-xs">
            <div className="text-center space-y-1">
              <p>Enter a URL or port number and press Enter</p>
              <p className="text-[9px]">Click Tunnel to create a public URL for remote access</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
