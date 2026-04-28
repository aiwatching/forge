'use client';

import React, { useState, useEffect } from 'react';

const TEMPLATES = [
  { label: '📊 Dashboard', text: 'A dashboard view that shows ' },
  { label: '🔍 Explorer', text: 'An explorer for browsing ' },
  { label: '⚡ Runner', text: 'A panel that runs ' },
  { label: '📝 Editor', text: 'An editor for ' },
  { label: '🧪 Tester', text: 'A tester that validates ' },
];

interface AgentSummary {
  id: string;
  displayName?: string;
  name?: string;
  detected?: boolean;
  enabled?: boolean;
}

function slugify(text: string): string {
  // Pull first 4-6 meaningful words → kebab-case
  const cleaned = text.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').replace(/\s+/g, ' ').trim();
  const words = cleaned.split(' ').filter(w => w.length > 2 && !['the', 'and', 'for', 'with', 'that', 'this', 'show', 'shows', 'lets', 'list'].includes(w));
  return words.slice(0, 4).join('-').slice(0, 30) || `craft-${Date.now().toString(36).slice(-4)}`;
}

export function CraftBuilderModal({ projectPath, projectName, refineCraftName, onClose, onCreated }: {
  projectPath: string;
  projectName: string;
  refineCraftName?: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const refining = !!refineCraftName;
  const [name, setName] = useState(refining ? refineCraftName! : '');
  const [nameTouched, setNameTouched] = useState(false);
  const [displayName, setDisplayName] = useState('');
  const [text, setText] = useState('');
  const [mode, setMode] = useState<'terminal' | 'task'>('terminal');
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [agentId, setAgentId] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Auto-fill name from description when user hasn't manually edited it
  useEffect(() => {
    if (!nameTouched && !refining && text.trim()) {
      setName(slugify(text));
    }
  }, [text, nameTouched, refining]);

  // Load available agents
  useEffect(() => {
    fetch('/api/agents')
      .then(r => r.ok ? r.json() : [])
      .then((list: AgentSummary[]) => {
        const enabled = (list || []).filter((a: any) => a.enabled !== false && a.detected !== false);
        setAgents(enabled);
        if (enabled.length > 0 && !agentId) setAgentId(enabled[0].id);
      })
      .catch(() => {});
  }, []);

  const submit = async () => {
    setErr(null);
    if (!text.trim()) { setErr('Description is required'); return; }
    if (!refining && !name.trim()) { setErr('Name is required'); return; }
    setBusy(true);

    try {
      if (mode === 'terminal' && !refining) {
        const res = await fetch('/api/craft-system/scaffold', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            projectPath, projectName,
            name, displayName: displayName || undefined,
            description: text,
            agentId,
          }),
        });
        const j = await res.json();
        if (!j.ok) throw new Error(j.error || 'scaffold failed');
        onCreated();
        onClose();
        // Note: user opens the session via the Sessions tab or reattaches in any terminal.
        return;
      }

      // Task mode (or refine — refines always go through builder task)
      const res = await fetch('/api/craft-system/build', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectPath, projectName,
          request: text,
          craftName: refining ? refineCraftName : (name || undefined),
        }),
      });
      const j = await res.json();
      if (!j.ok) throw new Error(j.error || 'build failed');
      onCreated();
      onClose();
    } catch (e: any) {
      setErr(e?.message || String(e));
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg shadow-2xl w-[640px] max-w-[95vw] max-h-[90vh] flex flex-col"
        onClick={e => e.stopPropagation()}>
        <div className="px-4 py-2.5 border-b border-[var(--border)] flex items-center gap-2">
          <span className="text-sm font-semibold text-[var(--text-primary)]">
            {refining ? `⚙ Refine craft: ${refineCraftName}` : '+ New Craft'}
          </span>
          <div className="flex-1" />
          <button onClick={onClose} className="text-[10px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]">✕</button>
        </div>

        <div className="p-4 space-y-3 overflow-auto">
          {!refining && (
            <>
              {/* Name + display name */}
              <div className="grid grid-cols-2 gap-3">
                <Field label="Name (kebab-case · dir name)" hint="Auto-derived from description; click to override.">
                  <input value={name}
                    onChange={e => { setName(e.target.value); setNameTouched(true); }}
                    placeholder="e.g. api-dashboard"
                    className="w-full text-xs bg-[var(--bg-tertiary)] border border-[var(--border)] rounded px-2 py-1 font-mono" />
                </Field>
                <Field label="Display name (tab label)" hint="Optional — defaults to 🛠 + name.">
                  <input value={displayName} onChange={e => setDisplayName(e.target.value)}
                    placeholder="e.g. 📊 API Dashboard"
                    className="w-full text-xs bg-[var(--bg-tertiary)] border border-[var(--border)] rounded px-2 py-1" />
                </Field>
              </div>

              {/* Quick templates */}
              <div className="flex flex-wrap gap-1">
                <span className="text-[10px] text-[var(--text-secondary)] mr-1">Quick start:</span>
                {TEMPLATES.map(t => (
                  <button key={t.label} onClick={() => setText(t.text)}
                    className="text-[10px] px-2 py-0.5 rounded bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:bg-[var(--accent)]/20 hover:text-[var(--accent)]">
                    {t.label}
                  </button>
                ))}
              </div>
            </>
          )}

          {/* Description */}
          <Field label={refining ? 'What should change?' : 'What should this craft do?'}>
            <textarea
              value={text}
              onChange={e => setText(e.target.value)}
              autoFocus
              disabled={busy}
              placeholder={refining
                ? 'e.g. add a column for last-modified date'
                : 'e.g. dashboard of all our REST endpoints with migration status, allow batch run + AI fix on failures'}
              className="w-full text-xs bg-[var(--bg-tertiary)] border border-[var(--border)] rounded px-3 py-2 font-mono min-h-[100px] resize-vertical"
            />
          </Field>

          {/* Mode + agent picker (only for new crafts) */}
          {!refining && (
            <div className="grid grid-cols-2 gap-3">
              <Field label="Run mode">
                <div className="flex gap-1 text-[10px]">
                  <button onClick={() => setMode('terminal')}
                    className={`flex-1 px-2 py-1.5 rounded border ${mode === 'terminal' ? 'bg-[var(--accent)]/20 text-[var(--accent)] border-[var(--accent)]/40' : 'border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]'}`}>
                    🖥 Terminal session<br /><span className="opacity-70 text-[9px]">interactive — debug as it builds</span>
                  </button>
                  <button onClick={() => setMode('task')}
                    className={`flex-1 px-2 py-1.5 rounded border ${mode === 'task' ? 'bg-[var(--accent)]/20 text-[var(--accent)] border-[var(--accent)]/40' : 'border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]'}`}>
                    📋 Background task<br /><span className="opacity-70 text-[9px]">fire-and-forget — open in Tasks tab</span>
                  </button>
                </div>
              </Field>
              <Field label="Agent" hint="The CLI that builds the craft.">
                <select value={agentId} onChange={e => setAgentId(e.target.value)}
                  className="w-full text-xs bg-[var(--bg-tertiary)] border border-[var(--border)] rounded px-2 py-1">
                  {agents.length === 0 && <option value="">no agents detected</option>}
                  {agents.map(a => (
                    <option key={a.id} value={a.id}>{a.displayName || a.name || a.id}</option>
                  ))}
                </select>
              </Field>
            </div>
          )}

          {err && (
            <div className="text-[11px] text-red-300 bg-red-500/10 border border-red-500/30 rounded px-2 py-1.5">
              {err}
            </div>
          )}

          <div className="text-[10px] text-[var(--text-secondary)] opacity-70 leading-relaxed">
            {refining ? (
              <>The agent will read this craft's existing files and the refine prompt as a background task. Watch progress in the Tasks tab.</>
            ) : mode === 'terminal' ? (
              <>Forge will create <code className="text-[var(--accent)]">.forge/crafts/{name || '<name>'}/</code>, scaffold the manifest + a placeholder UI, then start <b>{agents.find(a => a.id === agentId)?.displayName || agentId || 'the agent'}</b> in a tmux session at that directory and inject the builder prompt. The new tab appears immediately; it hot-reloads as the agent writes files.</>
            ) : (
              <>Forge spawns a background task in this project. Modal closes immediately — open the Tasks tab to follow progress.</>
            )}
          </div>
        </div>

        <div className="px-4 py-2 border-t border-[var(--border)] flex justify-end gap-2">
          <button onClick={onClose}
            className="text-xs px-3 py-1 rounded text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]">
            Cancel
          </button>
          <button onClick={submit} disabled={busy || !text.trim() || (!refining && !name.trim())}
            className="text-xs px-3 py-1 rounded bg-[var(--accent)]/30 text-[var(--accent)] hover:bg-[var(--accent)]/40 disabled:opacity-40">
            {busy ? '⏳ …' : (refining ? 'Apply changes' : (mode === 'terminal' ? '🖥 Start session' : '📋 Spawn task'))}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] text-[var(--text-secondary)] flex items-center gap-2">
        {label}
        {hint && <span className="opacity-60 font-normal">{hint}</span>}
      </span>
      {children}
    </label>
  );
}
