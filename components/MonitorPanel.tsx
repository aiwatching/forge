'use client';

import { useState, useEffect, useCallback } from 'react';

interface MonitorData {
  processes: {
    nextjs: { running: boolean; pid: string; startedAt?: string };
    terminal: { running: boolean; pid: string; startedAt?: string };
    telegram: { running: boolean; pid: string; startedAt?: string };
    workspace: { running: boolean; pid: string; startedAt?: string };
    tunnel: { running: boolean; pid: string; url: string };
    mcp: { running: boolean; port: number; sessions: number };
  };
  sessions: { name: string; created: string; attached: boolean; windows: number }[];
  uptime: string;
}

export default function MonitorPanel({ onClose }: { onClose: () => void }) {
  const [data, setData] = useState<MonitorData | null>(null);

  const refresh = useCallback(() => {
    fetch('/api/monitor').then(r => r.json()).then(setData).catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, [refresh]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg w-[500px] max-h-[80vh] overflow-y-auto shadow-xl" onClick={e => e.stopPropagation()}>
        <div className="px-4 py-3 border-b border-[var(--border)] flex items-center justify-between">
          <h2 className="text-sm font-bold text-[var(--text-primary)]">Monitor</h2>
          <div className="flex items-center gap-2">
            <button onClick={refresh} className="text-[10px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]">↻</button>
            <button onClick={onClose} className="text-[10px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]">Close</button>
          </div>
        </div>

        {data ? (
          <div className="p-4 space-y-4">
            {/* Processes */}
            <div>
              <h3 className="text-[10px] font-semibold text-[var(--text-secondary)] uppercase mb-2">Processes</h3>
              <div className="space-y-1.5">
                {[
                  { label: 'Next.js', ...data.processes.nextjs },
                  { label: 'Terminal Server', ...data.processes.terminal },
                  { label: 'Telegram Bot', ...data.processes.telegram },
                  { label: 'Workspace Daemon', ...data.processes.workspace },
                  { label: 'Tunnel', ...data.processes.tunnel },
                ].map(p => (
                  <div key={p.label} className="flex items-center gap-2 text-xs">
                    <span className={p.running ? 'text-green-400' : 'text-gray-500'}>●</span>
                    <span className="text-[var(--text-primary)] w-28">{p.label}</span>
                    {p.running ? (
                      <>
                        <span className="text-[var(--text-secondary)] font-mono text-[10px]">pid: {p.pid}</span>
                        {(p as any).startedAt && <span className="text-gray-500 font-mono text-[9px]">{(p as any).startedAt}</span>}
                      </>
                    ) : (
                      <span className="text-gray-500 text-[10px]">stopped</span>
                    )}
                  </div>
                ))}
                {/* MCP Server — separate row (no pid, uses port + sessions) */}
                <div className="flex items-center gap-2 text-xs">
                  <span className={data.processes.mcp?.running ? 'text-green-400' : 'text-gray-500'}>●</span>
                  <span className="text-[var(--text-primary)] w-28">MCP Server</span>
                  {data.processes.mcp?.running ? (
                    <>
                      <span className="text-[var(--text-secondary)] font-mono text-[10px]">port: {data.processes.mcp.port}</span>
                      <span className="text-gray-500 font-mono text-[9px]">{data.processes.mcp.sessions} session(s)</span>
                    </>
                  ) : (
                    <span className="text-gray-500 text-[10px]">stopped</span>
                  )}
                </div>
                {data.processes.tunnel.running && data.processes.tunnel.url && (
                  <div className="pl-6 text-[10px] text-[var(--accent)] truncate">{data.processes.tunnel.url}</div>
                )}
                <div className="border-t border-[var(--border)] my-1" />
              </div>
            </div>

            {/* Uptime */}
            {data.uptime && (
              <div className="text-[10px] text-[var(--text-secondary)]">
                Uptime: {data.uptime}
              </div>
            )}

            {/* Sessions */}
            <div>
              <h3 className="text-[10px] font-semibold text-[var(--text-secondary)] uppercase mb-2">
                Terminal Sessions ({data.sessions.length})
              </h3>
              {data.sessions.length === 0 ? (
                <div className="text-[10px] text-[var(--text-secondary)]">No sessions</div>
              ) : (
                <div className="space-y-1">
                  {data.sessions.map(s => (
                    <div key={s.name} className="flex items-center gap-2 text-[11px]">
                      <span className={s.attached ? 'text-green-400' : 'text-yellow-500'}>●</span>
                      <span className="font-mono text-[var(--text-primary)] truncate flex-1">{s.name}</span>
                      <span className="text-[9px] text-[var(--text-secondary)]">{s.attached ? 'attached' : 'detached'}</span>
                      <span className="text-[9px] text-[var(--text-secondary)]">{new Date(s.created).toLocaleTimeString()}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="p-8 text-center text-xs text-[var(--text-secondary)]">Loading...</div>
        )}
      </div>
    </div>
  );
}
