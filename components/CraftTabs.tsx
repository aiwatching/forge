'use client';

// Renders a single craft as a tab. Lazy-imports the craft's transpiled UI module.

import React, { useEffect, useState, useRef } from 'react';
import * as ReactJsxRuntime from 'react/jsx-runtime';
import { CraftSDKProvider, getSDK, setGlobalToast } from '@/lib/craft-sdk/client';

export interface CraftSummary {
  name: string;
  displayName: string;
  icon?: string;
  description?: string;
  scope: 'builtin' | 'project';
  hasUi: boolean;
  hasServer: boolean;
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

export function CraftTab({ craft, projectPath, projectName }: Props) {
  const [Comp, setComp] = useState<React.ComponentType | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    installRuntime();
    let cancelled = false;
    (async () => {
      try {
        const url = `/api/crafts/_ui?projectPath=${encodeURIComponent(projectPath)}&name=${encodeURIComponent(craft.name)}&t=${Date.now()}`;
        // eslint-disable-next-line @next/next/no-assign-module-variable
        const mod = await import(/* webpackIgnore: true */ url);
        if (cancelled) return;
        const C = mod.default || mod.Tab;
        if (!C) throw new Error(`Craft ${craft.name} did not export a default component`);
        setComp(() => C);
      } catch (e: any) {
        if (cancelled) return;
        setError(e?.message || String(e));
      }
    })();
    return () => { cancelled = true; mountedRef.current = false; };
  }, [craft.name, projectPath]);

  if (error) {
    return (
      <div className="p-4 text-xs text-red-300 font-mono whitespace-pre-wrap">
        Failed to load craft: {error}
      </div>
    );
  }
  if (!Comp) {
    return <div className="p-4 text-xs text-[var(--text-secondary)]">Loading craft…</div>;
  }
  return (
    <CraftSDKProvider projectPath={projectPath} projectName={projectName} craftName={craft.name}>
      <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
        <Comp />
      </div>
    </CraftSDKProvider>
  );
}
