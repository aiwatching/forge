'use client';

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import type { Endpoint, RunResult, MigrationConfig, FailureCluster } from '@/lib/migration/types';

// ─── Helpers ─────────────────────────────────────────────

const STATUS_COLORS: Record<string, string> = {
  migrated: 'text-emerald-400',
  tested: 'text-emerald-300',
  'in-progress': 'text-yellow-400',
  pending: 'text-gray-400',
  skip: 'text-gray-500',
  defer: 'text-orange-400',
};

const MATCH_COLORS: Record<string, string> = {
  pass: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40',
  fail: 'bg-red-500/20 text-red-300 border-red-500/40',
  'stub-ok': 'bg-blue-500/20 text-blue-300 border-blue-500/40',
  error: 'bg-orange-500/20 text-orange-300 border-orange-500/40',
};

interface Props {
  projectPath: string;
  projectName: string;
}

export default function MigrationCockpit({ projectPath, projectName }: Props) {
  const [config, setConfig] = useState<MigrationConfig | null>(null);
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [discoverInfo, setDiscoverInfo] = useState<{ warnings: string[]; sources: { file: string; count: number }[] } | null>(null);
  const [results, setResults] = useState<Record<string, RunResult>>({});
  const [batchProgress, setBatchProgress] = useState<{ done: number; total: number; running: boolean } | null>(null);
  const [failures, setFailures] = useState<FailureCluster[]>([]);
  const [filter, setFilter] = useState<'all' | 'fail' | 'pass' | 'untested' | 'stubbed'>('all');
  const [search, setSearch] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showConfig, setShowConfig] = useState(false);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const sseRef = useRef<EventSource | null>(null);

  const flash = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2500);
  }, []);

  // ─── Data loading ──────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [cRes, dRes, fRes] = await Promise.all([
        fetch(`/api/migration/config?projectPath=${encodeURIComponent(projectPath)}`),
        fetch(`/api/migration/discover?projectPath=${encodeURIComponent(projectPath)}`),
        fetch(`/api/migration/failures?projectPath=${encodeURIComponent(projectPath)}`),
      ]);
      const c = await cRes.json();
      const d = await dRes.json();
      const f = await fRes.json();
      if (cancelled) return;
      setConfig(c);
      setEndpoints(d.endpoints || []);
      setFailures(f.clusters || []);
    })();
    return () => { cancelled = true; };
  }, [projectPath]);

  const saveConfig = useCallback(async (cfg: MigrationConfig) => {
    setConfig(cfg);
    await fetch('/api/migration/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectPath, config: cfg }),
    });
    flash('Config saved');
  }, [projectPath, flash]);

  const discover = useCallback(async () => {
    setBusy(true);
    try {
      const res = await fetch('/api/migration/discover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectPath }),
      });
      const d = await res.json();
      setEndpoints(d.endpoints || []);
      setDiscoverInfo({ warnings: d.warnings || [], sources: d.sources || [] });
      flash(`Discovered ${d.total || 0} endpoints`);
    } finally {
      setBusy(false);
    }
  }, [projectPath, flash]);

  const refreshFailures = useCallback(async () => {
    const res = await fetch(`/api/migration/failures?projectPath=${encodeURIComponent(projectPath)}`);
    const f = await res.json();
    setFailures(f.clusters || []);
  }, [projectPath]);

  // ─── Filtering ─────────────────────────────────────────
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return endpoints.filter(e => {
      if (q && !`${e.method} ${e.path} ${e.controller}`.toLowerCase().includes(q)) return false;
      const r = results[e.id];
      switch (filter) {
        case 'all': return true;
        case 'untested': return !r;
        case 'stubbed': return e.isStubbed;
        case 'pass': return r?.match === 'pass' || r?.match === 'stub-ok';
        case 'fail': return r?.match === 'fail' || r?.match === 'error';
      }
    });
  }, [endpoints, results, filter, search]);

  // ─── Run ───────────────────────────────────────────────
  const runOne = useCallback(async (ep: Endpoint) => {
    const res = await fetch('/api/migration/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectPath, endpointId: ep.id }),
    });
    const r = await res.json();
    setResults(prev => ({ ...prev, [ep.id]: r }));
    setExpandedId(ep.id);
  }, [projectPath]);

  const runBatch = useCallback(async (endpointIds?: string[]) => {
    if (sseRef.current) sseRef.current.close();
    setBatchProgress({ done: 0, total: endpointIds?.length ?? endpoints.length, running: true });

    // POST + read stream via fetch (EventSource doesn't support POST)
    try {
      const res = await fetch('/api/migration/run-batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectPath, endpointIds }),
      });
      if (!res.body) throw new Error('No SSE body');
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split('\n\n');
        buffer = events.pop() || '';
        for (const block of events) {
          const eMatch = block.match(/^event: (\w+)/m);
          const dMatch = block.match(/^data: (.+)$/m);
          if (!eMatch || !dMatch) continue;
          const event = eMatch[1];
          const data = JSON.parse(dMatch[1]);
          if (event === 'start') setBatchProgress({ done: 0, total: data.total, running: true });
          else if (event === 'progress') {
            setBatchProgress(p => p ? { ...p, done: data.done, total: data.total } : null);
            setResults(prev => ({ ...prev, [data.result.endpointId]: data.result }));
          }
          else if (event === 'done') {
            setBatchProgress(p => p ? { ...p, running: false } : null);
            flash(`Batch done: ${data.pass} pass, ${data.fail} fail, ${data.stubOk} stub-ok, ${data.error} error`);
            await refreshFailures();
          }
          else if (event === 'error') {
            flash('Batch error: ' + data.message);
            setBatchProgress(null);
          }
        }
      }
    } catch (e: any) {
      flash('Stream error: ' + (e?.message || String(e)));
      setBatchProgress(null);
    }
  }, [projectPath, endpoints.length, flash, refreshFailures]);

  // ─── AI Fix ────────────────────────────────────────────
  const requestFix = useCallback(async (ids: string[], mode: 'inject' | 'task') => {
    let sessionName: string | undefined;
    if (mode === 'inject') {
      sessionName = window.prompt('tmux session name to inject into (e.g. mw-projectname):') || undefined;
      if (!sessionName) return;
    }
    const res = await fetch('/api/migration/fix', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectPath, projectName, mode, endpointIds: ids, sessionName }),
    });
    const r = await res.json();
    if (r.ok) flash(mode === 'task' ? `Task created: ${r.taskId}` : `Sent to ${r.sessionName}`);
    else flash('Fix failed: ' + (r.error || 'unknown'));
  }, [projectPath, projectName, flash]);

  // ─── Selection ─────────────────────────────────────────
  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const selectAll = () => setSelectedIds(new Set(filtered.map(e => e.id)));
  const clearSel = () => setSelectedIds(new Set());

  // ─── Stats ─────────────────────────────────────────────
  const stats = useMemo(() => {
    const total = endpoints.length;
    let pass = 0, fail = 0, stub = 0, untested = 0, stubbed = 0;
    for (const e of endpoints) {
      if (e.isStubbed) stubbed++;
      const r = results[e.id];
      if (!r) { untested++; continue; }
      if (r.match === 'pass') pass++;
      else if (r.match === 'stub-ok') stub++;
      else if (r.match === 'fail' || r.match === 'error') fail++;
    }
    return { total, pass, fail, stub, untested, stubbed };
  }, [endpoints, results]);

  if (!config) return <div className="p-4 text-xs text-[var(--text-secondary)]">Loading…</div>;

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
      {/* Toolbar */}
      <div className="border-b border-[var(--border)] px-4 py-2 flex items-center gap-2 bg-[var(--bg-secondary)]">
        <button onClick={discover} disabled={busy}
          className="text-xs px-2.5 py-1 rounded bg-[var(--accent)]/20 text-[var(--accent)] hover:bg-[var(--accent)]/30 disabled:opacity-50">
          {busy ? 'Discovering…' : 'Discover from docs'}
        </button>
        <button onClick={() => runBatch()} disabled={!!batchProgress?.running || endpoints.length === 0}
          className="text-xs px-2.5 py-1 rounded bg-emerald-500/20 text-emerald-300 hover:bg-emerald-500/30 disabled:opacity-50">
          Run all ({endpoints.length})
        </button>
        {selectedIds.size > 0 && (
          <>
            <button onClick={() => runBatch([...selectedIds])} disabled={!!batchProgress?.running}
              className="text-xs px-2.5 py-1 rounded bg-emerald-500/20 text-emerald-300 hover:bg-emerald-500/30">
              Run selected ({selectedIds.size})
            </button>
            <button onClick={() => requestFix([...selectedIds], 'task')}
              className="text-xs px-2.5 py-1 rounded bg-purple-500/20 text-purple-300 hover:bg-purple-500/30">
              AI fix → task
            </button>
            <button onClick={() => requestFix([...selectedIds], 'inject')}
              className="text-xs px-2.5 py-1 rounded bg-purple-500/20 text-purple-300 hover:bg-purple-500/30">
              AI fix → inject
            </button>
          </>
        )}
        <div className="flex-1" />
        <input
          value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Search controller / path…"
          className="text-xs bg-[var(--bg-tertiary)] border border-[var(--border)] rounded px-2 py-1 w-48"
        />
        <select value={filter} onChange={e => setFilter(e.target.value as any)}
          className="text-xs bg-[var(--bg-tertiary)] border border-[var(--border)] rounded px-2 py-1">
          <option value="all">All</option>
          <option value="untested">Untested</option>
          <option value="pass">Pass</option>
          <option value="fail">Fail</option>
          <option value="stubbed">Stubbed</option>
        </select>
        <button onClick={() => setShowConfig(v => !v)}
          className="text-xs px-2 py-1 rounded text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]">
          {showConfig ? 'Hide config' : 'Config'}
        </button>
      </div>

      {/* Stats bar */}
      <div className="px-4 py-1.5 flex items-center gap-4 text-[11px] border-b border-[var(--border)] bg-[var(--bg-tertiary)]/40">
        <span><b className="text-[var(--text-primary)]">{stats.total}</b> total</span>
        <span className="text-emerald-400">{stats.pass} pass</span>
        <span className="text-blue-400">{stats.stub} stub-ok</span>
        <span className="text-red-400">{stats.fail} fail</span>
        <span className="text-gray-400">{stats.untested} untested</span>
        <span className="text-gray-500">({stats.stubbed} stubbed)</span>
        {batchProgress && (
          <span className={batchProgress.running ? 'text-yellow-400' : 'text-emerald-400'}>
            {batchProgress.running ? '⏳' : '✓'} {batchProgress.done}/{batchProgress.total}
          </span>
        )}
        <div className="flex-1" />
        {discoverInfo?.warnings && discoverInfo.warnings.length > 0 && (
          <span className="text-yellow-400" title={discoverInfo.warnings.join('\n')}>
            {discoverInfo.warnings.length} warning{discoverInfo.warnings.length > 1 ? 's' : ''}
          </span>
        )}
      </div>

      {/* Config panel */}
      {showConfig && (
        <ConfigPanel config={config} onSave={saveConfig} onClose={() => setShowConfig(false)} />
      )}

      <div className="flex-1 flex min-h-0 overflow-hidden">
        {/* Endpoint list */}
        <div className="flex-1 overflow-y-auto">
          {filtered.length === 0 ? (
            <div className="p-6 text-center text-xs text-[var(--text-secondary)]">
              {endpoints.length === 0 ? (
                <>
                  No endpoints. Click <b>Discover from docs</b> to scan{' '}
                  <code className="text-[var(--accent)]">{config.endpointSource.primary}</code>
                  {config.endpointSource.fallback && <> + <code className="text-[var(--accent)]">{config.endpointSource.fallback}</code></>}.
                </>
              ) : 'No endpoints match the filter.'}
            </div>
          ) : (
            <div className="text-[11px]">
              <div className="sticky top-0 z-10 bg-[var(--bg-secondary)] border-b border-[var(--border)] px-3 py-1.5 flex items-center gap-2">
                <input type="checkbox"
                  checked={selectedIds.size === filtered.length && filtered.length > 0}
                  onChange={() => selectedIds.size === filtered.length ? clearSel() : selectAll()}
                />
                <span className="text-[var(--text-secondary)]">Select all visible ({filtered.length})</span>
              </div>
              {filtered.map(ep => {
                const r = results[ep.id];
                const exp = expandedId === ep.id;
                return (
                  <div key={ep.id} className="border-b border-[var(--border)]/50">
                    <div className="px-3 py-1.5 flex items-center gap-2 hover:bg-[var(--bg-secondary)]/50">
                      <input type="checkbox" checked={selectedIds.has(ep.id)} onChange={() => toggleSelect(ep.id)} />
                      <span className={`font-mono font-bold w-12 text-right ${methodColor(ep.method)}`}>{ep.method}</span>
                      <span className="font-mono flex-1 truncate">{ep.path}</span>
                      <span className="text-[10px] text-[var(--text-secondary)] w-32 truncate">{ep.controller}</span>
                      {ep.isStubbed && <span className="text-[9px] px-1 rounded bg-blue-500/20 text-blue-300">501</span>}
                      <span className={`text-[9px] ${STATUS_COLORS[ep.status] || ''}`}>{ep.status}</span>
                      {r && (
                        <span className={`text-[9px] px-1.5 py-0.5 rounded border ${MATCH_COLORS[r.match]}`}>
                          {r.match}
                        </span>
                      )}
                      <button onClick={() => runOne(ep)}
                        className="text-[10px] px-2 py-0.5 rounded bg-[var(--accent)]/20 text-[var(--accent)] hover:bg-[var(--accent)]/30">
                        Run
                      </button>
                      <button onClick={() => setExpandedId(exp ? null : ep.id)}
                        className="text-[10px] px-1.5 text-[var(--text-secondary)] hover:text-[var(--text-primary)]">
                        {exp ? '▼' : '▶'}
                      </button>
                    </div>
                    {exp && r && <RunResultDetail r={r} />}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Failures sidebar */}
        {failures.length > 0 && (
          <div className="w-72 border-l border-[var(--border)] overflow-y-auto bg-[var(--bg-secondary)]/30">
            <div className="px-3 py-2 border-b border-[var(--border)] text-[11px] font-medium text-[var(--text-primary)] flex items-center justify-between">
              <span>Failure clusters</span>
              <button onClick={refreshFailures} className="text-[9px] text-[var(--accent)]">refresh</button>
            </div>
            {failures.map(c => (
              <div key={c.errorType} className="border-b border-[var(--border)]/50 px-3 py-2">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[11px] font-mono text-red-400">{c.errorType}</span>
                  <span className="text-[10px] text-[var(--text-secondary)]">{c.count}</span>
                </div>
                {c.controllers.slice(0, 5).map(cc => (
                  <div key={cc.controller} className="flex items-center justify-between text-[10px] py-0.5">
                    <span className="truncate text-[var(--text-secondary)]">{cc.controller}</span>
                    <span className="text-[9px] text-[var(--text-secondary)]">{cc.failures.length}</span>
                  </div>
                ))}
                <button
                  onClick={() => requestFix(c.controllers.flatMap(cc => cc.failures.map(f => f.endpointId)), 'task')}
                  className="mt-1 text-[10px] w-full py-1 rounded bg-purple-500/20 text-purple-300 hover:bg-purple-500/30">
                  Fix cluster → task
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {toast && (
        <div className="absolute bottom-3 left-1/2 -translate-x-1/2 px-3 py-1.5 text-xs rounded bg-[var(--bg-tertiary)] border border-[var(--border)] shadow-lg">
          {toast}
        </div>
      )}
    </div>
  );
}

// ─── Config panel ────────────────────────────────────────

function ConfigPanel({ config, onSave, onClose }: { config: MigrationConfig; onSave: (c: MigrationConfig) => void; onClose: () => void }) {
  const [draft, setDraft] = useState(config);
  return (
    <div className="border-b border-[var(--border)] bg-[var(--bg-secondary)]/40 px-4 py-3 grid grid-cols-2 gap-3 text-[11px]">
      <Field label="Legacy base URL">
        <input className="cfg-input" value={draft.legacy.baseUrl}
          onChange={e => setDraft({ ...draft, legacy: { baseUrl: e.target.value } })} />
      </Field>
      <Field label="New base URL">
        <input className="cfg-input" value={draft.next.baseUrl}
          onChange={e => setDraft({ ...draft, next: { ...draft.next, baseUrl: e.target.value } })} />
      </Field>
      <Field label="Auth mode">
        <select className="cfg-input" value={draft.auth.mode}
          onChange={e => setDraft({ ...draft, auth: { ...draft.auth, mode: e.target.value as any } })}>
          <option value="skip">skip</option>
          <option value="bearer">bearer (token from env)</option>
          <option value="basic">basic</option>
        </select>
      </Field>
      <Field label="Token env var">
        <input className="cfg-input" value={draft.auth.tokenEnv || ''}
          onChange={e => setDraft({ ...draft, auth: { ...draft.auth, tokenEnv: e.target.value } })}
          placeholder="FORTINAC_TOKEN" />
      </Field>
      <Field label="Per-controller docs dir">
        <input className="cfg-input" value={draft.endpointSource.primary}
          onChange={e => setDraft({ ...draft, endpointSource: { ...draft.endpointSource, primary: e.target.value } })} />
      </Field>
      <Field label="History fallback">
        <input className="cfg-input" value={draft.endpointSource.fallback || ''}
          onChange={e => setDraft({ ...draft, endpointSource: { ...draft.endpointSource, fallback: e.target.value } })} />
      </Field>
      <Field label="Ignore JSON paths (one per line)">
        <textarea className="cfg-input min-h-[60px]" value={draft.ignorePaths.join('\n')}
          onChange={e => setDraft({ ...draft, ignorePaths: e.target.value.split('\n').filter(Boolean) })} />
      </Field>
      <Field label="Path placeholder substitutions">
        <textarea className="cfg-input min-h-[60px]"
          value={Object.entries(draft.pathSubstitutions || {}).map(([k, v]) => `${k}=${v}`).join('\n')}
          onChange={e => {
            const subs: Record<string, string> = {};
            for (const line of e.target.value.split('\n')) {
              const [k, ...rest] = line.split('=');
              if (k && rest.length) subs[k.trim()] = rest.join('=').trim();
            }
            setDraft({ ...draft, pathSubstitutions: subs });
          }} />
      </Field>
      <div className="col-span-2 flex justify-end gap-2 mt-1">
        <button onClick={onClose} className="text-xs px-3 py-1 rounded text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]">Cancel</button>
        <button onClick={() => { onSave(draft); onClose(); }}
          className="text-xs px-3 py-1 rounded bg-[var(--accent)]/30 text-[var(--accent)] hover:bg-[var(--accent)]/40">Save</button>
      </div>
      <style jsx>{`
        .cfg-input { background: var(--bg-tertiary); border: 1px solid var(--border); border-radius: 4px; padding: 4px 8px; width: 100%; font-size: 11px; font-family: ui-monospace, monospace; }
      `}</style>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-wide text-[var(--text-secondary)]">{label}</span>
      {children}
    </label>
  );
}

// ─── Run result detail ───────────────────────────────────

function RunResultDetail({ r }: { r: RunResult }) {
  return (
    <div className="px-6 py-2 bg-[var(--bg-tertiary)]/40 text-[10px] font-mono space-y-1">
      <div className="grid grid-cols-2 gap-3">
        <SidePane label="Legacy" side={r.legacy} />
        <SidePane label="New" side={r.next} />
      </div>
      {r.diff && r.diff.length > 0 && (
        <div className="mt-2 border-t border-[var(--border)] pt-2">
          <div className="text-[10px] text-yellow-400 mb-1">Diffs ({r.diff.length}):</div>
          <div className="max-h-40 overflow-y-auto">
            {r.diff.map((d, i) => (
              <div key={i} className="flex gap-2 py-0.5">
                <span className="text-cyan-300 w-32 truncate" title={d.jsonPath}>{d.jsonPath}</span>
                <span className="text-red-300 truncate flex-1" title={JSON.stringify(d.legacy)}>L: {JSON.stringify(d.legacy)}</span>
                <span className="text-emerald-300 truncate flex-1" title={JSON.stringify(d.next)}>N: {JSON.stringify(d.next)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {r.errorMessage && <div className="text-red-400">⚠ {r.errorType}: {r.errorMessage}</div>}
    </div>
  );
}

function SidePane({ label, side }: { label: string; side: any }) {
  return (
    <div className="space-y-0.5">
      <div className="text-[10px] text-[var(--text-secondary)] flex items-center gap-2">
        <span>{label}</span>
        <span className={side.ok ? 'text-emerald-400' : 'text-red-400'}>{side.status || side.error}</span>
        <span className="text-[9px] opacity-60">{side.durationMs}ms</span>
      </div>
      <div className="text-[9px] text-[var(--text-secondary)] truncate" title={side.url}>{side.url}</div>
      {side.bodyExcerpt && (
        <pre className="text-[9px] max-h-24 overflow-auto whitespace-pre-wrap break-words bg-[var(--bg-primary)] border border-[var(--border)] rounded p-1">
          {side.bodyExcerpt.slice(0, 800)}
        </pre>
      )}
    </div>
  );
}

function methodColor(m: string): string {
  switch (m) {
    case 'GET': return 'text-emerald-400';
    case 'POST': return 'text-yellow-400';
    case 'PUT': return 'text-blue-400';
    case 'DELETE': return 'text-red-400';
    case 'PATCH': return 'text-purple-400';
    default: return 'text-gray-400';
  }
}
