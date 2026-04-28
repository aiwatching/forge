'use client';

// Renders a single craft as a tab. Lazy-imports the craft's transpiled UI module.

import React, { useEffect, useState, useRef, lazy, Suspense, useCallback } from 'react';
import * as ReactJsxRuntime from 'react/jsx-runtime';
import { CraftSDKProvider, getSDK, setGlobalToast } from '@/lib/craft-sdk/client';

const CraftTerminalLazy = lazy(() => import('./CraftTerminal'));
const CraftTerminalPickerLazy = lazy(() => import('./CraftTerminalPicker'));

interface CraftTermChoice {
  agentId: string;
  resumeSessionId?: string;
}
function termChoiceKey(projectPath: string, craftName: string): string {
  return `forge.craft.term.${projectPath}::${craftName}`;
}
function loadTermChoice(projectPath: string, craftName: string): CraftTermChoice | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(termChoiceKey(projectPath, craftName));
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
function saveTermChoice(projectPath: string, craftName: string, c: CraftTermChoice) {
  try { localStorage.setItem(termChoiceKey(projectPath, craftName), JSON.stringify(c)); } catch {}
}

export interface CraftSummary {
  name: string;
  displayName: string;
  icon?: string;
  description?: string;
  scope: 'builtin' | 'project';
  hasUi: boolean;
  hasServer: boolean;
  dir?: string;
  preferredSessionName?: string;
}

// Install the host's React + JSX runtime on window so craft modules can grab them.
let runtimeInstalled = false;
function installRuntime() {
  if (runtimeInstalled || typeof window === 'undefined') return;
  (window as any).__forge_react = React;
  (window as any).__forge_jsx = ReactJsxRuntime;
  (window as any).__forge_sdk = getSDK();
  // Minimal toast — DOM injected so crafts get something instead of console.log.
  setGlobalToast((msg, kind = 'info') => {
    const el = document.createElement('div');
    const colors = kind === 'error' ? 'background:#7f1d1d;color:#fecaca' : kind === 'success' ? 'background:#064e3b;color:#a7f3d0' : 'background:#1f2937;color:#e5e7eb';
    el.setAttribute('style', `position:fixed;top:1rem;left:50%;transform:translateX(-50%);${colors};padding:6px 14px;border-radius:6px;font-size:12px;z-index:9999;box-shadow:0 4px 12px rgba(0,0,0,.4);`);
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2500);
  });
  runtimeInstalled = true;
}

interface Props {
  craft: CraftSummary;
  projectPath: string;
  projectName: string;
}

// Persisted split ratio (UI height fraction; rest is terminal)
const SPLIT_KEY = 'forge.craft.split';
const DEFAULT_SPLIT = 0.6;

export function CraftTab({ craft, projectPath, projectName }: Props) {
  const [Comp, setComp] = useState<React.ComponentType | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const [split, setSplit] = useState<number>(() => {
    if (typeof window === 'undefined') return DEFAULT_SPLIT;
    const v = parseFloat(localStorage.getItem(SPLIT_KEY) || '');
    return isFinite(v) && v > 0.15 && v < 0.95 ? v : DEFAULT_SPLIT;
  });
  // Terminal hidden by default — user chooses agent + session before it mounts
  const [showTerm, setShowTerm] = useState<boolean>(false);
  const [termChoice, setTermChoice] = useState<CraftTermChoice | null>(() => loadTermChoice(projectPath, craft.name));
  const [pickerOpen, setPickerOpen] = useState<boolean>(false);
  const mountedRef = useRef(true);
  const containerRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    installRuntime();
    let cancelled = false;
    (async () => {
      try {
        const url = `/api/craft-system/ui?projectPath=${encodeURIComponent(projectPath)}&name=${encodeURIComponent(craft.name)}&t=${Date.now()}`;
        // eslint-disable-next-line @next/next/no-assign-module-variable
        const mod = await import(/* webpackIgnore: true */ url);
        if (cancelled) return;
        const C = mod.default || mod.Tab;
        if (!C) throw new Error(`Craft ${craft.name} did not export a default component`);
        setComp(() => C);
        setError(null);
      } catch (e: any) {
        if (cancelled) return;
        setError(e?.message || String(e));
      }
    })();
    return () => { cancelled = true; mountedRef.current = false; };
  }, [craft.name, projectPath, reloadTick]);

  const onDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    draggingRef.current = true;
    const onMove = (ev: MouseEvent) => {
      if (!draggingRef.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const ratio = (ev.clientY - rect.top) / rect.height;
      const clamped = Math.max(0.15, Math.min(0.9, ratio));
      setSplit(clamped);
    };
    const onUp = () => {
      draggingRef.current = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      try { localStorage.setItem(SPLIT_KEY, String(split)); } catch {}
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [split]);

  // Persist on change
  useEffect(() => { try { localStorage.setItem(SPLIT_KEY, String(split)); } catch {} }, [split]);

  const uiPanel = (
    error ? (
      <div className="p-4 text-xs text-red-300 font-mono whitespace-pre-wrap h-full overflow-auto">
        Failed to load craft: {error}
        <div className="mt-2"><button onClick={() => setReloadTick(t => t + 1)} className="text-[10px] px-2 py-0.5 rounded bg-[var(--accent)]/20 text-[var(--accent)]">↻ Retry</button></div>
      </div>
    ) : !Comp ? (
      <div className="p-4 text-xs text-[var(--text-secondary)]">Loading craft…</div>
    ) : (
      <CraftSDKProvider projectPath={projectPath} projectName={projectName} craftName={craft.name}>
        <div className="h-full flex flex-col min-h-0 overflow-hidden">
          <Comp />
        </div>
      </CraftSDKProvider>
    )
  );

  return (
    <div ref={containerRef} className="flex-1 flex flex-col min-h-0 overflow-hidden relative">
      {/* Header strip with hot-reload + show/hide terminal */}
      <div className="px-3 py-1 border-b border-[var(--border)] flex items-center gap-2 text-[10px] bg-[var(--bg-secondary)]/30 shrink-0">
        <span className="text-[var(--text-secondary)]">{craft.dir || `<project>/.forge/crafts/${craft.name}`}</span>
        <div className="flex-1" />
        <button onClick={() => setReloadTick(t => t + 1)}
          className="px-1.5 py-0.5 rounded text-[var(--text-secondary)] hover:text-[var(--accent)] hover:bg-[var(--bg-tertiary)]"
          title="Re-fetch ui.tsx (after agent edits)">↻ reload</button>
        <button onClick={() => {
            if (showTerm) { setShowTerm(false); return; }
            // Showing — if we already have a remembered choice, just open it
            if (termChoice) setShowTerm(true);
            else setPickerOpen(true);
          }}
          className="px-1.5 py-0.5 rounded text-[var(--text-secondary)] hover:text-[var(--accent)] hover:bg-[var(--bg-tertiary)]"
          title={showTerm ? 'Hide terminal' : (termChoice ? `Show terminal (${termChoice.agentId}${termChoice.resumeSessionId ? ' · resume ' + termChoice.resumeSessionId.slice(0, 8) : ''})` : 'Show terminal — pick agent + session')}>
          {showTerm ? '⊟ hide terminal' : '⊞ show terminal'}
        </button>
      </div>

      {/* Top: UI */}
      <div className="overflow-hidden" style={{ height: showTerm ? `${split * 100}%` : '100%' }}>
        {uiPanel}
      </div>

      {/* Drag handle + bottom: terminal */}
      {showTerm && termChoice && (
        <>
          <div onMouseDown={onDragStart}
            className="h-1 cursor-row-resize bg-[var(--border)] hover:bg-[var(--accent)] transition-colors shrink-0" />
          <div className="overflow-hidden" style={{ height: `${(1 - split) * 100}%` }}>
            <Suspense fallback={<div className="p-2 text-[10px] text-[var(--text-secondary)]">Loading terminal…</div>}>
              <CraftTerminalLazy
                projectPath={projectPath}
                craftName={craft.name}
                preferredSessionName={craft.preferredSessionName || `mw-craft-${craft.name}`}
                craftDir={craft.dir || `${projectPath}/.forge/crafts/${craft.name}`}
                initialAgentId={termChoice.agentId}
                initialResumeSessionId={termChoice.resumeSessionId}
                onPickAgain={() => setPickerOpen(true)}
              />
            </Suspense>
          </div>
        </>
      )}

      {/* Picker overlay */}
      {pickerOpen && (
        <Suspense fallback={null}>
          <CraftTerminalPickerLazy
            projectName={projectName}
            defaultAgentId={termChoice?.agentId}
            onPick={async (c) => {
              const next: CraftTermChoice = {
                agentId: c.agentId,
                resumeSessionId: c.sessionMode === 'new' ? undefined : c.sessionId,
              };
              const sessionName = craft.preferredSessionName || `mw-craft-${craft.name}`;
              const wasShowing = showTerm;
              const choiceChanged = !termChoice
                || termChoice.agentId !== next.agentId
                || termChoice.resumeSessionId !== next.resumeSessionId;

              // Tear down existing tmux session so CraftTerminal can recreate
              // it with the chosen agent + --resume flag. The cleanupOrphans
              // exemption keeps craft sessions alive otherwise.
              if (choiceChanged) {
                try {
                  await fetch('/api/craft-system/kill-session', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ sessionName }),
                  });
                } catch {}
              }

              saveTermChoice(projectPath, craft.name, next);
              setPickerOpen(false);
              if (choiceChanged && wasShowing) {
                // Force-remount CraftTerminal with the new choice
                setShowTerm(false);
                setTimeout(() => { setTermChoice(next); setShowTerm(true); }, 50);
              } else {
                setTermChoice(next);
                setShowTerm(true);
              }
            }}
            onCancel={() => setPickerOpen(false)}
          />
        </Suspense>
      )}
    </div>
  );
}
