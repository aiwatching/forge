'use client';

import { useState, useEffect } from 'react';

export default function PreviewPanel() {
  const [port, setPort] = useState(0);
  const [inputPort, setInputPort] = useState('');
  const [tunnelUrl, setTunnelUrl] = useState<string | null>(null);
  const [status, setStatus] = useState<string>('stopped');
  const [error, setError] = useState('');
  const [isRemote, setIsRemote] = useState(false);

  useEffect(() => {
    setIsRemote(!['localhost', '127.0.0.1'].includes(window.location.hostname));
    fetch('/api/preview')
      .then(r => r.json())
      .then(d => {
        if (d.port) {
          setPort(d.port);
          setInputPort(String(d.port));
          setTunnelUrl(d.url || null);
          setStatus(d.status || 'stopped');
        }
      })
      .catch(() => {});
  }, []);

  const handleStart = async () => {
    const p = parseInt(inputPort);
    if (!p || p < 1 || p > 65535) {
      setError('Invalid port');
      return;
    }
    setError('');
    setStatus('starting');
    try {
      const res = await fetch('/api/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ port: p }),
      });
      const data = await res.json();
      if (data.error) {
        setError(data.error);
        setStatus('error');
      } else {
        setPort(data.port);
        setTunnelUrl(data.url || null);
        setStatus(data.status || 'running');
      }
    } catch {
      setError('Failed to start tunnel');
      setStatus('error');
    }
  };

  const handleStop = async () => {
    await fetch('/api/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'stop' }),
    });
    setPort(0);
    setTunnelUrl(null);
    setStatus('stopped');
  };

  // What to show in iframe: tunnel URL for remote, localhost for local
  const previewSrc = isRemote
    ? tunnelUrl
    : port ? `http://localhost:${port}` : null;

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Control bar */}
      <div className="px-4 py-2 border-b border-[var(--border)] flex items-center gap-3 shrink-0 flex-wrap">
        <span className="text-[11px] font-semibold text-[var(--text-primary)]">Preview</span>

        <input
          type="number"
          value={inputPort}
          onChange={e => setInputPort(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleStart()}
          placeholder="Port"
          className="w-24 text-xs bg-[var(--bg-tertiary)] border border-[var(--border)] rounded px-2 py-1 text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)] font-mono"
        />

        {status === 'stopped' || status === 'error' ? (
          <button
            onClick={handleStart}
            disabled={!inputPort}
            className="text-[10px] px-3 py-1 bg-[var(--accent)] text-white rounded hover:opacity-90 disabled:opacity-50"
          >
            Start Tunnel
          </button>
        ) : status === 'starting' ? (
          <span className="text-[10px] text-yellow-400">Starting tunnel...</span>
        ) : (
          <>
            <span className="text-[10px] text-green-400">● localhost:{port}</span>
            {tunnelUrl && (
              <button
                onClick={() => { navigator.clipboard.writeText(tunnelUrl); }}
                className="text-[10px] text-green-400 hover:text-green-300 truncate max-w-[250px]"
                title={`Click to copy: ${tunnelUrl}`}
              >
                {tunnelUrl.replace('https://', '')}
              </button>
            )}
            <a
              href={previewSrc || '#'}
              target="_blank"
              rel="noopener"
              className="text-[10px] text-[var(--accent)] hover:underline"
            >
              Open ↗
            </a>
            <button
              onClick={handleStop}
              className="text-[10px] text-red-400 hover:text-red-300"
            >
              Stop
            </button>
          </>
        )}

        {error && <span className="text-[10px] text-red-400">{error}</span>}
      </div>

      {/* Preview iframe */}
      {previewSrc && status === 'running' ? (
        <iframe
          src={previewSrc}
          className="flex-1 w-full border-0 bg-white"
          title="Preview"
        />
      ) : (
        <div className="flex-1 flex items-center justify-center text-[var(--text-secondary)]">
          <div className="text-center space-y-3 max-w-md">
            <p className="text-sm">Preview a local dev server</p>
            <p className="text-xs">Enter the port of your running dev server and click Start Tunnel.</p>
            <p className="text-xs">A dedicated Cloudflare Tunnel will be created for that port, giving it its own public URL — no path prefix issues.</p>
            <div className="text-[10px] text-left bg-[var(--bg-tertiary)] rounded p-3 space-y-1">
              <p>1. Start your dev server: <code className="text-[var(--accent)]">npm run dev</code></p>
              <p>2. Enter its port (e.g. <code className="text-[var(--accent)]">4321</code>)</p>
              <p>3. Click <strong>Start Tunnel</strong></p>
              <p>4. Share the generated URL — it maps directly to your dev server</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
