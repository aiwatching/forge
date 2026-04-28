'use client';

// Client-side SDK exposed to crafts. Lives behind a React context so each craft
// gets its project + craft scope automatically.

import React, { createContext, useContext, useCallback, useEffect, useState, useRef } from 'react';

interface CraftContextValue {
  projectPath: string;
  projectName: string;
  craftName: string;
}

const CraftContext = createContext<CraftContextValue | null>(null);

export function CraftSDKProvider({ projectPath, projectName, craftName, children }: {
  projectPath: string; projectName: string; craftName: string; children: React.ReactNode;
}) {
  return <CraftContext.Provider value={{ projectPath, projectName, craftName }}>{children}</CraftContext.Provider>;
}

function useCraftCtx(): CraftContextValue {
  const v = useContext(CraftContext);
  if (!v) throw new Error('Craft SDK hook used outside CraftSDKProvider');
  return v;
}

// ── 1. useProject ────────────────────────────────────────
export interface ProjectInfo {
  projectPath: string;
  projectName: string;
}

export function useProject(): ProjectInfo {
  const { projectPath, projectName } = useCraftCtx();
  return { projectPath, projectName };
}

// ── 2. useForgeFetch ─────────────────────────────────────
export interface FetchState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

export function useForgeFetch<T = any>(path: string, opts: { auto?: boolean; init?: RequestInit } = {}): FetchState<T> {
  const { projectPath } = useCraftCtx();
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const fullPath = path.includes('?') ? `${path}&projectPath=${encodeURIComponent(projectPath)}` : `${path}?projectPath=${encodeURIComponent(projectPath)}`;

  useEffect(() => {
    if (opts.auto === false) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(fullPath, opts.init)
      .then(async r => {
        if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
        return r.json();
      })
      .then(j => { if (!cancelled) { setData(j); setLoading(false); } })
      .catch(e => { if (!cancelled) { setError(e?.message || String(e)); setLoading(false); } });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fullPath, tick]);

  return { data, loading, error, refetch: () => setTick(t => t + 1) };
}

// ── 3. useInject ─────────────────────────────────────────
export function useInject(): (text: string, opts?: { sessionName?: string }) => Promise<{ ok: boolean; sessionName?: string }> {
  const { projectPath, projectName, craftName } = useCraftCtx();
  return useCallback(async (text: string, opts = {}) => {
    const r = await fetch('/api/migration/fix', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectPath, projectName,
        mode: opts.sessionName ? 'inject' : 'inject',
        sessionName: opts.sessionName,
        promptOverride: text,
      }),
    });
    const j = await r.json();
    return { ok: !!j.ok, sessionName: j.sessionName };
  }, [projectPath, projectName, craftName]);
}

// ── 4. useTask ───────────────────────────────────────────
export interface TaskHandle {
  id: string;
  watch: (onLog: (entry: any) => void, onDone?: (task: any) => void) => () => void;
  cancel: () => Promise<void>;
}

export function useTask(): (prompt: string, opts?: { agent?: string }) => Promise<TaskHandle> {
  const { projectPath, projectName } = useCraftCtx();
  return useCallback(async (prompt: string, opts = {}) => {
    const r = await fetch('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectName, projectPath, prompt, agent: opts.agent }),
    });
    const t = await r.json();
    if (!t?.id) throw new Error(t?.error || 'failed to create task');
    return {
      id: t.id,
      watch: (onLog, onDone) => {
        const es = new EventSource(`/api/tasks/${t.id}/stream`);
        es.onmessage = (ev) => {
          try {
            const data = JSON.parse(ev.data);
            if (data.type === 'log') onLog(data.entry);
            else if (data.type === 'complete' && onDone) { onDone(data.task); es.close(); }
          } catch {}
        };
        es.onerror = () => es.close();
        return () => es.close();
      },
      cancel: async () => { await fetch(`/api/tasks/${t.id}/cancel`, { method: 'POST' }); },
    };
  }, [projectName, projectPath]);
}

// ── 5. useStore ──────────────────────────────────────────
// Stores at <project>/.forge/crafts/<name>/data/<file>.json via /api/crafts/<name>/_store
export function useStore<T = any>(file: string, defaultValue?: T): [T | null, (next: T) => Promise<void>, { loading: boolean; error: string | null; reload: () => void }] {
  const { projectPath, craftName } = useCraftCtx();
  const [value, setValue] = useState<T | null>(defaultValue ?? null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`/api/crafts/_storage?projectPath=${encodeURIComponent(projectPath)}&craft=${craftName}&file=${encodeURIComponent(file)}`)
      .then(async r => r.ok ? r.json() : { value: null })
      .then(j => { if (!cancelled) { setValue(j.value ?? defaultValue ?? null); setLoading(false); } })
      .catch(e => { if (!cancelled) { setError(e?.message); setLoading(false); } });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectPath, craftName, file, tick]);

  const save = useCallback(async (next: T) => {
    setValue(next);
    await fetch(`/api/crafts/_storage?projectPath=${encodeURIComponent(projectPath)}&craft=${craftName}&file=${encodeURIComponent(file)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: next }),
    });
  }, [projectPath, craftName, file]);

  return [value, save, { loading, error, reload: () => setTick(t => t + 1) }];
}

// ── 6. useOpenAPI — load + parse an OpenAPI spec from the project ──
export interface OpenAPIData {
  spec: any | null;
  paths: string[];
  schemas: Record<string, any>;
  loading: boolean;
  error: string | null;
}

export function useOpenAPI(specPath: string): OpenAPIData {
  const { projectPath } = useCraftCtx();
  const [state, setState] = useState<OpenAPIData>({ spec: null, paths: [], schemas: {}, loading: true, error: null });
  useEffect(() => {
    let cancelled = false;
    setState(s => ({ ...s, loading: true }));
    fetch(`/api/crafts/_helpers/openapi?projectPath=${encodeURIComponent(projectPath)}&path=${encodeURIComponent(specPath)}`)
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`${r.status}`)))
      .then(j => { if (!cancelled) setState({ spec: j.spec, paths: j.paths || [], schemas: j.schemas || {}, loading: false, error: null }); })
      .catch(e => { if (!cancelled) setState(s => ({ ...s, loading: false, error: e.message })); });
    return () => { cancelled = true; };
  }, [projectPath, specPath]);
  return state;
}

// ── 7. useFile — read a file from the project (optional polling) ──
export function useFile(path: string, opts: { watch?: number } = {}): { content: string | null; loading: boolean; error: string | null; reload: () => void } {
  const { projectPath } = useCraftCtx();
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`/api/crafts/_helpers/file?projectPath=${encodeURIComponent(projectPath)}&path=${encodeURIComponent(path)}`)
      .then(r => r.ok ? r.text() : Promise.reject(new Error(`${r.status}`)))
      .then(t => { if (!cancelled) { setContent(t); setLoading(false); } })
      .catch(e => { if (!cancelled) { setError(e.message); setLoading(false); } });
    return () => { cancelled = true; };
  }, [projectPath, path, tick]);
  useEffect(() => {
    if (!opts.watch) return;
    const id = setInterval(() => setTick(t => t + 1), opts.watch);
    return () => clearInterval(id);
  }, [opts.watch]);
  return { content, loading, error, reload: () => setTick(t => t + 1) };
}

// ── 8. useShell — run a shell command in the project cwd ──
export function useShell(): (cmd: string, opts?: { timeout?: number }) => Promise<{ stdout: string; stderr: string; code: number }> {
  const { projectPath } = useCraftCtx();
  return useCallback(async (cmd, opts = {}) => {
    const r = await fetch(`/api/crafts/_helpers/shell?projectPath=${encodeURIComponent(projectPath)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cmd, timeout: opts.timeout }),
    });
    return r.json();
  }, [projectPath]);
}

// ── 9. useGit — quick git status / log helpers ──
export interface GitInfo {
  branch?: string;
  changes: { status: string; path: string }[];
  ahead: number;
  behind: number;
  log: { hash: string; message: string; author: string; date: string }[];
}
export function useGit(): { info: GitInfo | null; loading: boolean; reload: () => void } {
  const { projectPath } = useCraftCtx();
  const [info, setInfo] = useState<GitInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`/api/git?dir=${encodeURIComponent(projectPath)}`)
      .then(r => r.ok ? r.json() : null)
      .then(j => { if (!cancelled) { setInfo(j); setLoading(false); } })
      .catch(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [projectPath, tick]);
  return { info, loading, reload: () => setTick(t => t + 1) };
}

// ── 10. useToast — quick notification ──
type ToastFn = (msg: string, kind?: 'info' | 'success' | 'error') => void;
let globalToast: ToastFn | null = null;
export function setGlobalToast(fn: ToastFn) { globalToast = fn; }
export function useToast(): ToastFn {
  return useCallback((msg, kind = 'info') => {
    if (globalToast) globalToast(msg, kind);
    else console.log(`[toast:${kind}]`, msg);
  }, []);
}

// Bundle exports for the runtime shim
export function getSDK() {
  return {
    useProject, useForgeFetch, useInject, useTask, useStore,
    useOpenAPI, useFile, useShell, useGit, useToast,
  };
}
