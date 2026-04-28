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
  const [filter, setFilter] = useState<'all' | 'fail' | 'pass' | 'untested' | 'stubbed' | 'pending' | 'migrated'>('all');
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
        case 'pending': return e.status === 'pending';
        case 'migrated': return e.status === 'migrated' && !e.isStubbed;
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


  // ─── Diagnose: open detail drawer with full context ────
  const [diagnoseFor, setDiagnoseFor] = useState<{ markdown: string; endpointId: string; original: string } | null>(null);
  const [sessionInfo, setSessionInfo] = useState<{ name: string; cwd: string; attached: boolean }[]>([]);
  const [pickedSession, setPickedSession] = useState<string | null>(null);

  // Discover terminal sessions tied to this project once on mount
  useEffect(() => {
    fetch(`/api/migration/sessions?projectPath=${encodeURIComponent(projectPath)}`)
      .then(r => r.ok ? r.json() : { matches: [] })
      .then(d => {
        setSessionInfo(d.matches || []);
        // Auto-pick the first attached session, otherwise the first match
        const auto = (d.matches || []).find((s: any) => s.attached) || (d.matches || [])[0];
        if (auto) setPickedSession(auto.name);
      })
      .catch(() => {});
  }, [projectPath]);

  const refreshSessions = useCallback(async () => {
    const res = await fetch(`/api/migration/sessions?projectPath=${encodeURIComponent(projectPath)}`);
    if (!res.ok) return;
    const d = await res.json();
    setSessionInfo(d.matches || []);
    if (!pickedSession || !(d.matches || []).find((s: any) => s.name === pickedSession)) {
      const auto = (d.matches || []).find((s: any) => s.attached) || (d.matches || [])[0];
      if (auto) setPickedSession(auto.name);
    }
  }, [projectPath, pickedSession]);

  const openDiagnose = useCallback(async (endpointId: string) => {
    const res = await fetch(`/api/migration/diagnose?projectPath=${encodeURIComponent(projectPath)}&endpointId=${endpointId}`);
    if (!res.ok) { flash('Diagnose failed'); return; }
    const j = await res.json();
    setDiagnoseFor({ markdown: j.markdown, original: j.markdown, endpointId });
  }, [projectPath, flash]);

  // Send an arbitrary prompt (typically the edited drawer content) via inject or task.
  const sendCustomPrompt = useCallback(async (prompt: string, opts: { forceTask?: boolean; sessionName?: string; endpointIds?: string[] } = {}) => {
    const target = opts.sessionName ?? pickedSession;
    const mode = !opts.forceTask && target ? 'inject' : 'task';
    const body: any = { projectPath, projectName, mode, promptOverride: prompt, endpointIds: opts.endpointIds || [] };
    if (mode === 'inject') body.sessionName = target;
    const res = await fetch('/api/migration/fix', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const r = await res.json();
    if (r.ok) {
      flash(mode === 'inject' ? `Sent to terminal ${target}` : `Task created: ${r.taskId}`);
    } else {
      flash('Send failed: ' + (r.error || 'unknown'));
    }
  }, [projectPath, projectName, pickedSession, flash]);

  // Send the diagnosis: prefer inject to bound terminal, fall back to task if none.
  const sendDiagnose = useCallback(async (endpointIds: string[], opts: { forceTask?: boolean; sessionName?: string } = {}) => {
    const target = opts.sessionName ?? pickedSession;
    if (!opts.forceTask && target) {
      const res = await fetch('/api/migration/fix', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectPath, projectName, mode: 'inject', endpointIds, sessionName: target }),
      });
      const r = await res.json();
      if (r.ok) { flash(`Sent to terminal ${target} (${r.count} endpoints)`); return; }
      flash(`Inject failed: ${r.error || 'unknown'} — falling back to task`);
    }
    // Fall back to task
    const res = await fetch('/api/migration/diagnose', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectPath, projectName, endpointIds, mode: 'task' }),
    });
    const r = await res.json();
    if (r.ok) flash(`Task created: ${r.taskId} (${r.count} endpoints)`);
    else flash('Diagnose failed: ' + (r.error || 'unknown'));
  }, [projectPath, projectName, pickedSession, flash]);

  const copyCurl = useCallback(async (endpointId: string) => {
    const res = await fetch(`/api/migration/diagnose?projectPath=${encodeURIComponent(projectPath)}&endpointId=${endpointId}`);
    if (!res.ok) { flash('Failed to fetch curl'); return; }
    const j = await res.json();
    const curl = j.context?.curlCommand;
    if (!curl) { flash('No curl available'); return; }
    try { await navigator.clipboard.writeText(curl); flash('Copied curl to clipboard'); }
    catch { flash('Could not access clipboard'); }
  }, [projectPath, flash]);

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
    let pass = 0, fail = 0, stub = 0, untested = 0, stubbed = 0, pending = 0, withSchema = 0;
    for (const e of endpoints) {
      if (e.isStubbed) stubbed++;
      if (e.status === 'pending') pending++;
      if (e.hasResponseSchema) withSchema++;
      const r = results[e.id];
      if (!r) { untested++; continue; }
      if (r.match === 'pass') pass++;
      else if (r.match === 'stub-ok') stub++;
      else if (r.match === 'fail' || r.match === 'error') fail++;
    }
    return { total, pass, fail, stub, untested, stubbed, pending, withSchema };
  }, [endpoints, results]);

  // ─── Health: detect connectivity-class failures dominating the results ──
  const health = useMemo(() => {
    const all = Object.values(results);
    if (all.length === 0) return null;
    const errs = all.filter(r => r.match === 'error');
    if (errs.length === 0) return null;
    const ratio = errs.length / all.length;
    if (ratio < 0.5) return null;

    // Bucket errors by type and pull a sample message
    const byType = new Map<string, { count: number; sample?: string; sampleUrl?: string }>();
    for (const r of errs) {
      const t = r.errorType || 'error';
      const slot = byType.get(t) || { count: 0 };
      slot.count++;
      if (!slot.sample) {
        slot.sample = r.errorMessage || r.next.error || r.legacy.error || '';
        slot.sampleUrl = r.next.url || r.legacy.url;
      }
      byType.set(t, slot);
    }
    const top = [...byType.entries()].sort((a, b) => b[1].count - a[1].count)[0];
    return {
      ratio,
      errorCount: errs.length,
      total: all.length,
      topType: top[0],
      topCount: top[1].count,
      sampleMessage: top[1].sample,
      sampleUrl: top[1].sampleUrl,
    };
  }, [results]);

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
            <button onClick={() => sendDiagnose([...selectedIds])}
              className="text-xs px-2.5 py-1 rounded bg-purple-500/20 text-purple-300 hover:bg-purple-500/30"
              title={pickedSession ? `Inject into ${pickedSession}` : 'No bound terminal — will fall back to task'}>
              🤖 Fix selected{pickedSession ? ` → ${pickedSession.replace(/^mw[a-z0-9]*-/, '')}` : ' → task'}
            </button>
            <button onClick={() => sendDiagnose([...selectedIds], { forceTask: true })}
              className="text-xs px-2.5 py-1 rounded text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
              title="Spawn background task instead of injecting">
              → task
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
          <option value="migrated">Migrated</option>
          <option value="pending">Pending (no doc)</option>
        </select>
        {/* Bound terminal picker */}
        <div className="flex items-center gap-1 text-[10px]">
          <span className="text-[var(--text-secondary)]">→</span>
          {sessionInfo.length > 0 ? (
            <select value={pickedSession || ''} onChange={e => setPickedSession(e.target.value || null)}
              className="text-[10px] bg-[var(--bg-tertiary)] border border-[var(--border)] rounded px-1.5 py-0.5 max-w-[200px]"
              title="Bound terminal — fixes inject here">
              {sessionInfo.map(s => (
                <option key={s.name} value={s.name}>
                  {s.name.replace(/^mw[a-z0-9]*-/, '')}{s.attached ? ' ●' : ''}
                </option>
              ))}
            </select>
          ) : (
            <span className="text-orange-300/70" title="Open a terminal in this project to enable inject">no bound terminal</span>
          )}
          <button onClick={refreshSessions} className="text-[9px] text-[var(--text-secondary)] hover:text-[var(--accent)]" title="Refresh terminal list">↻</button>
        </div>
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
        <span className="text-gray-500">({stats.stubbed} stub · {stats.pending} pending · {stats.withSchema} w/ schema)</span>
        <span className="text-purple-400">mode: {config.diffMode || 'shape'}</span>
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

      {/* Connectivity banner */}
      {health && (
        <div className="mx-4 mt-2 p-3 rounded border border-orange-500/40 bg-orange-500/10 text-[11px]">
          <div className="font-semibold text-orange-300 mb-1">
            ⚠ {health.errorCount}/{health.total} runs failed with `{health.topType}` ({Math.round(health.ratio * 100)}%)
          </div>
          <div className="text-[var(--text-secondary)] mb-1">
            {health.topType === 'new-unreachable' && (
              <>新 web-server 不可达。请检查：<b>baseUrl</b> 是否正确（当前 <code className="text-orange-300">{config.next.baseUrl}</code>）、服务是否启动、端口是否监听。</>
            )}
            {health.topType === 'legacy-unreachable' && (
              <>Legacy 不可达。如果你不想跑 legacy，把 Diff mode 改为 <b>shape</b>（不需要 legacy）。当前 baseUrl: <code>{config.legacy.baseUrl}</code>。</>
            )}
            {health.topType !== 'new-unreachable' && health.topType !== 'legacy-unreachable' && (
              <>大量 endpoint 报同一类错。Sample: <code>{health.sampleUrl}</code></>
            )}
          </div>
          {health.sampleMessage && (
            <div className="text-[10px] font-mono text-orange-200/80 break-all">
              错误信息: {health.sampleMessage}
            </div>
          )}
          <div className="mt-1.5 flex gap-2">
            <button onClick={() => setShowConfig(true)} className="text-[10px] px-2 py-0.5 rounded bg-orange-500/20 text-orange-200 hover:bg-orange-500/30">
              打开 Config
            </button>
            <button onClick={() => setResults({})} className="text-[10px] px-2 py-0.5 rounded text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]">
              清空结果重新跑
            </button>
          </div>
        </div>
      )}

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
                        <span className={`text-[9px] px-1.5 py-0.5 rounded border ${MATCH_COLORS[r.match]}`}
                          title={r.errorMessage || r.errorType || r.match}>
                          {r.match}{r.errorType ? ` · ${r.errorType}` : ''}
                        </span>
                      )}
                      <button onClick={() => runOne(ep)}
                        className="text-[10px] px-2 py-0.5 rounded bg-[var(--accent)]/20 text-[var(--accent)] hover:bg-[var(--accent)]/30">
                        Run
                      </button>
                      {r && (r.match === 'fail' || r.match === 'error') && (
                        <>
                          <button onClick={() => openDiagnose(ep.id)}
                            className="text-[10px] px-2 py-0.5 rounded bg-yellow-500/20 text-yellow-300 hover:bg-yellow-500/30"
                            title="Show full diagnosis context">
                            🔍
                          </button>
                          <button onClick={() => sendDiagnose([ep.id])}
                            className="text-[10px] px-2 py-0.5 rounded bg-purple-500/20 text-purple-300 hover:bg-purple-500/30"
                            title={pickedSession ? `Inject diagnosis into ${pickedSession}` : 'No bound terminal — will fall back to background task'}>
                            🤖 Fix
                          </button>
                        </>
                      )}
                      <button onClick={() => copyCurl(ep.id)}
                        className="text-[10px] px-1.5 text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                        title="Copy reproduction curl">
                        📋
                      </button>
                      <button onClick={() => setExpandedId(exp ? null : ep.id)}
                        className="text-[10px] px-1.5 text-[var(--text-secondary)] hover:text-[var(--text-primary)]">
                        {exp ? '▼' : '▶'}
                      </button>
                    </div>
                    {/* Inline error preview when collapsed */}
                    {!exp && r && (r.match === 'fail' || r.match === 'error') && r.errorMessage && (
                      <div className="px-12 pb-1 text-[10px] text-red-300/80 font-mono truncate" title={r.errorMessage}>
                        {r.errorMessage}
                      </div>
                    )}
                    {exp && r && <RunResultDetail r={r} projectPath={projectPath} endpointId={ep.id} flash={flash}
                      onIgnorePath={async (p) => {
                        if (!config) return;
                        const generalized = p.replace(/\[\d+\]/g, '[*]');
                        if (config.ignorePaths.includes(generalized)) { flash('Already ignored'); return; }
                        const next = { ...config, ignorePaths: [...config.ignorePaths, generalized] };
                        await saveConfig(next);
                        flash(`Added ${generalized} — re-running`);
                        runOne(ep);
                      }} />}
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
                  onClick={() => sendDiagnose(c.controllers.flatMap(cc => cc.failures.map(f => f.endpointId)))}
                  className="mt-1 text-[10px] w-full py-1 rounded bg-purple-500/20 text-purple-300 hover:bg-purple-500/30"
                  title={pickedSession ? `Inject into ${pickedSession}` : 'No bound terminal — will fall back to task'}>
                  🤖 Fix cluster {pickedSession ? '→ terminal' : '→ task'}
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

      {/* Diagnose drawer */}
      {diagnoseFor && (
        <div className="fixed inset-0 z-50 flex" onClick={() => setDiagnoseFor(null)}>
          <div className="flex-1 bg-black/40" />
          <div className="w-[720px] max-w-[95vw] bg-[var(--bg-primary)] border-l border-[var(--border)] flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="px-4 py-2 border-b border-[var(--border)] flex items-center gap-2 flex-wrap">
              <span className="text-xs font-semibold text-[var(--text-primary)]">🔍 Diagnosis (editable)</span>
              {diagnoseFor.markdown !== diagnoseFor.original && (
                <span className="text-[9px] px-1.5 py-0.5 rounded bg-yellow-500/20 text-yellow-300">edited</span>
              )}
              <div className="flex-1" />
              <button onClick={() => setDiagnoseFor({ ...diagnoseFor, markdown: diagnoseFor.original })}
                disabled={diagnoseFor.markdown === diagnoseFor.original}
                className="text-[10px] px-2 py-1 rounded text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] disabled:opacity-30">
                Reset
              </button>
              <button onClick={() => sendCustomPrompt(diagnoseFor.markdown, { endpointIds: [diagnoseFor.endpointId] })}
                className="text-[10px] px-2 py-1 rounded bg-purple-500/20 text-purple-300 hover:bg-purple-500/30"
                title={pickedSession ? `Inject edited prompt into ${pickedSession}` : 'No bound terminal — will fall back to task'}>
                🤖 {pickedSession ? `Send to ${pickedSession.replace(/^mw[a-z0-9]*-/, '')}` : 'Send as task'}
              </button>
              <button onClick={() => sendCustomPrompt(diagnoseFor.markdown, { forceTask: true, endpointIds: [diagnoseFor.endpointId] })}
                className="text-[10px] px-2 py-1 rounded text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
                title="Force background task">
                → task
              </button>
              <button onClick={async () => { try { await navigator.clipboard.writeText(diagnoseFor.markdown); flash('Copied'); } catch {} }}
                className="text-[10px] px-2 py-1 rounded text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]">
                Copy
              </button>
              <button onClick={() => setDiagnoseFor(null)}
                className="text-[10px] px-2 py-1 rounded text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]">
                Close
              </button>
            </div>
            <textarea
              value={diagnoseFor.markdown}
              onChange={e => setDiagnoseFor({ ...diagnoseFor, markdown: e.target.value })}
              spellCheck={false}
              className="flex-1 resize-none bg-[var(--bg-primary)] text-[11px] font-mono leading-relaxed text-[var(--text-primary)] p-4 outline-none border-0 focus:ring-0"
            />
            <div className="px-4 py-1.5 border-t border-[var(--border)] text-[9px] text-[var(--text-secondary)] flex items-center gap-3">
              <span>{diagnoseFor.markdown.length.toLocaleString()} chars</span>
              <span>{diagnoseFor.markdown.split('\n').length} lines</span>
              <span className="ml-auto opacity-60">edits stay local until you click Send</span>
            </div>
          </div>
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
      <Field label="OpenAPI spec (primary source)">
        <input className="cfg-input" value={draft.endpointSource.openApiSpec || ''}
          onChange={e => setDraft({ ...draft, endpointSource: { ...draft.endpointSource, openApiSpec: e.target.value } })}
          placeholder="docs/fnac-rest-schema-7.6.json" />
      </Field>
      <Field label="Diff mode">
        <select className="cfg-input" value={draft.diffMode || 'shape'}
          onChange={e => setDraft({ ...draft, diffMode: e.target.value as any })}>
          <option value="shape">shape — validate new vs OpenAPI schema (legacy not needed)</option>
          <option value="exact">exact — deep-equal both sides (legacy required)</option>
          <option value="both">both — deep-equal + schema validation</option>
        </select>
      </Field>
      <Field label="Per-controller docs dir (annotation)">
        <input className="cfg-input" value={draft.endpointSource.primary}
          onChange={e => setDraft({ ...draft, endpointSource: { ...draft.endpointSource, primary: e.target.value } })} />
      </Field>
      <Field label="History fallback (annotation)">
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

// ─── Run result detail (inspector) ───────────────────────

function prettyJson(v: any, max = 12000): string {
  try {
    const s = JSON.stringify(v, null, 2);
    return s.length > max ? s.slice(0, max) + '\n…(truncated)' : s;
  } catch { return String(v); }
}

function copyText(s: string, flash?: (m: string) => void) {
  navigator.clipboard.writeText(s).then(
    () => flash?.('Copied'),
    () => flash?.('Could not access clipboard')
  );
}

function RunResultDetail({ r, projectPath, endpointId, flash, onIgnorePath }: {
  r: RunResult; projectPath: string; endpointId: string; flash: (m: string) => void; onIgnorePath: (p: string) => void;
}) {
  const [schema, setSchema] = React.useState<any | null>(null);
  const [schemaOpen, setSchemaOpen] = React.useState(false);
  const [headersOpen, setHeadersOpen] = React.useState(false);
  const hasLegacy = r.legacy.url && !r.legacy.url.startsWith('(skipped');

  React.useEffect(() => {
    if (!schemaOpen || schema !== null) return;
    fetch(`/api/migration/diagnose?projectPath=${encodeURIComponent(projectPath)}&endpointId=${endpointId}`)
      .then(r => r.ok ? r.json() : null)
      .then(j => setSchema(j?.context?.schema ?? false))
      .catch(() => setSchema(false));
  }, [schemaOpen, schema, projectPath, endpointId]);

  return (
    <div className="px-4 py-2 bg-[var(--bg-tertiary)]/40 text-[10px] space-y-2 border-t border-[var(--border)]/50">
      {/* Top summary */}
      <div className="flex items-center gap-3 text-[11px]">
        <span className={`px-1.5 py-0.5 rounded font-semibold ${r.match === 'pass' || r.match === 'stub-ok' ? 'bg-emerald-500/20 text-emerald-300' : 'bg-red-500/20 text-red-300'}`}>
          {r.match}
        </span>
        {r.errorType && <span className="text-yellow-400">{r.errorType}</span>}
        {r.errorMessage && <span className="text-[var(--text-secondary)] truncate">{r.errorMessage}</span>}
        <span className="ml-auto text-[9px] text-[var(--text-secondary)]">{r.durationMs}ms · {r.startedAt}</span>
      </div>

      {/* Side-by-side request/response */}
      <div className={`grid gap-3 ${hasLegacy ? 'grid-cols-2' : 'grid-cols-1'}`}>
        {hasLegacy && <SidePane label="Legacy" side={r.legacy} method={r.legacy.method} flash={flash} />}
        <SidePane label="New (web-server)" side={r.next} method={r.next.method} flash={flash} />
      </div>

      {/* Toggle headers */}
      <div className="flex items-center gap-3">
        <button onClick={() => setHeadersOpen(v => !v)}
          className="text-[10px] text-[var(--text-secondary)] hover:text-[var(--accent)]">
          {headersOpen ? '▼' : '▶'} Headers
        </button>
        <button onClick={() => setSchemaOpen(v => !v)}
          className="text-[10px] text-[var(--text-secondary)] hover:text-[var(--accent)]">
          {schemaOpen ? '▼' : '▶'} Expected schema (OpenAPI)
        </button>
      </div>

      {headersOpen && (
        <div className={`grid gap-3 ${hasLegacy ? 'grid-cols-2' : 'grid-cols-1'}`}>
          {hasLegacy && <HeadersPane side={r.legacy} />}
          <HeadersPane side={r.next} />
        </div>
      )}

      {schemaOpen && (
        <div>
          {schema === null && <div className="text-[10px] text-[var(--text-secondary)]">Loading…</div>}
          {schema === false && <div className="text-[10px] text-[var(--text-secondary)]">No schema available for this endpoint.</div>}
          {schema && schema !== false && (
            <pre className="text-[9px] max-h-64 overflow-auto whitespace-pre-wrap break-words bg-[var(--bg-primary)] border border-[var(--border)] rounded p-2 font-mono text-[var(--text-primary)]">
              {prettyJson(schema)}
            </pre>
          )}
        </div>
      )}

      {/* Diffs / violations */}
      {r.diff && r.diff.length > 0 && (
        <div className="border-t border-[var(--border)] pt-2">
          <div className="text-[10px] text-yellow-400 mb-1 font-semibold">
            {r.errorType === 'schema-violation' ? 'Schema violations' : 'Diffs'} ({r.diff.length})
          </div>
          <div className="max-h-48 overflow-y-auto bg-[var(--bg-primary)] border border-[var(--border)] rounded">
            <table className="w-full text-[10px] font-mono">
              <thead className="sticky top-0 bg-[var(--bg-tertiary)]">
                <tr className="text-[var(--text-secondary)]">
                  <th className="text-left px-2 py-1 font-normal">JSON path</th>
                  <th className="text-left px-2 py-1 font-normal">Reason</th>
                  <th className="text-left px-2 py-1 font-normal">{r.errorType === 'schema-violation' ? 'Expected' : 'Legacy'}</th>
                  <th className="text-left px-2 py-1 font-normal">{r.errorType === 'schema-violation' ? 'Actual' : 'New'}</th>
                  <th className="text-right px-2 py-1 font-normal w-12"></th>
                </tr>
              </thead>
              <tbody>
                {r.diff.map((d, i) => (
                  <tr key={i} className="border-t border-[var(--border)]/40 group">
                    <td className="px-2 py-0.5 text-cyan-300 align-top break-all">{d.jsonPath}</td>
                    <td className="px-2 py-0.5 text-yellow-300/80 align-top">{d.reason}</td>
                    <td className="px-2 py-0.5 text-emerald-300/80 align-top break-all">{JSON.stringify(d.legacy)}</td>
                    <td className="px-2 py-0.5 text-red-300/80 align-top break-all">{JSON.stringify(d.next)}</td>
                    <td className="px-1 py-0.5 align-top text-right">
                      <button onClick={() => onIgnorePath(d.jsonPath)}
                        className="text-[9px] px-1.5 py-0 rounded bg-orange-500/10 text-orange-300/80 hover:bg-orange-500/20 opacity-0 group-hover:opacity-100"
                        title={`Add ${d.jsonPath} to ignorePaths and re-run`}>
                        🚫 ignore
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function SidePane({ label, side, method, flash }: { label: string; side: any; method?: string; flash: (m: string) => void }) {
  const statusColor = side.error ? 'text-red-400'
    : side.status >= 200 && side.status < 300 ? 'text-emerald-400'
    : side.status === 501 ? 'text-blue-400'
    : 'text-orange-400';
  return (
    <div className="space-y-1 bg-[var(--bg-primary)] border border-[var(--border)] rounded p-2">
      <div className="flex items-center gap-2 text-[10px]">
        <span className="font-semibold text-[var(--text-primary)]">{label}</span>
        <span className={`font-mono font-bold ${statusColor}`}>
          {side.status || side.error || '—'}
          {side.statusText && side.status ? ` ${side.statusText}` : ''}
        </span>
        <span className="text-[9px] text-[var(--text-secondary)]">{side.durationMs}ms</span>
        <button onClick={() => copyText(side.bodyExcerpt || '', flash)}
          className="ml-auto text-[9px] text-[var(--text-secondary)] hover:text-[var(--accent)]" title="Copy response body">📋</button>
      </div>
      <div className="text-[9px] font-mono text-[var(--text-secondary)] break-all">
        <span className="text-yellow-300">{method || ''}</span> {side.url}
      </div>
      {side.error && (
        <div className="text-[10px] text-red-300 font-mono bg-red-500/10 rounded p-1">
          {side.error}
        </div>
      )}
      {side.bodyExcerpt && (
        <pre className="text-[10px] max-h-48 overflow-auto whitespace-pre-wrap break-words bg-[var(--bg-tertiary)]/40 rounded p-1.5 font-mono text-[var(--text-primary)]">
          {tryFormatJson(side.bodyExcerpt)}
        </pre>
      )}
    </div>
  );
}

function tryFormatJson(s: string): string {
  try {
    const parsed = JSON.parse(s);
    const pretty = JSON.stringify(parsed, null, 2);
    return pretty.length > 6000 ? pretty.slice(0, 6000) + '\n…(truncated)' : pretty;
  } catch {
    return s.length > 6000 ? s.slice(0, 6000) + '\n…(truncated)' : s;
  }
}

function HeadersPane({ side }: { side: any }) {
  return (
    <div className="space-y-1 bg-[var(--bg-primary)] border border-[var(--border)] rounded p-2 text-[9px] font-mono">
      <div className="text-[10px] text-[var(--text-secondary)] mb-1">Request headers</div>
      <div className="space-y-0.5">
        {Object.entries(side.requestHeaders || {}).map(([k, v]) => (
          <div key={k} className="flex gap-2"><span className="text-cyan-300">{k}:</span><span className="text-[var(--text-primary)] break-all">{String(v)}</span></div>
        ))}
        {Object.keys(side.requestHeaders || {}).length === 0 && <div className="text-[var(--text-secondary)]">(none)</div>}
      </div>
      <div className="text-[10px] text-[var(--text-secondary)] mt-2 mb-1">Response headers</div>
      <div className="space-y-0.5 max-h-32 overflow-auto">
        {Object.entries(side.responseHeaders || {}).map(([k, v]) => (
          <div key={k} className="flex gap-2"><span className="text-purple-300">{k}:</span><span className="text-[var(--text-primary)] break-all">{String(v)}</span></div>
        ))}
        {Object.keys(side.responseHeaders || {}).length === 0 && <div className="text-[var(--text-secondary)]">(none)</div>}
      </div>
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
