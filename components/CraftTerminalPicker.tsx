'use client';

// First-launch picker for a craft's terminal: choose agent, then (if Claude) pick session.

import React, { useEffect, useState } from 'react';
import { fetchProjectSessions, type SessionInfo } from './TerminalLauncher';

export interface AgentSummary { id: string; name?: string; path?: string; cliType?: string; }

export interface CraftTerminalChoice {
  agentId: string;
  agentName?: string;
  // Session selection — only meaningful when agent supports sessions (e.g. claude)
  sessionMode: 'last' | 'new' | 'specific';
  sessionId?: string;          // required when sessionMode === 'specific'
}

function formatRelativeTime(iso: string): string {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return new Date(iso).toLocaleDateString();
}
function formatSize(b: number): string {
  if (!b) return '';
  if (b < 1024) return `${b}B`;
  if (b < 1_048_576) return `${(b / 1024).toFixed(0)}KB`;
  return `${(b / 1_048_576).toFixed(1)}MB`;
}

const SESSION_AWARE = new Set(['claude', 'claude-code']);  // matched by id or cliType

export default function CraftTerminalPicker({ projectName, defaultAgentId, onPick, onCancel }: {
  projectName: string;
  defaultAgentId?: string;
  onPick: (choice: CraftTerminalChoice) => void;
  onCancel: () => void;
}) {
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [agentId, setAgentId] = useState<string>(defaultAgentId || '');
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null);
  const [showAll, setShowAll] = useState(false);

  // Load agents
  useEffect(() => {
    fetch('/api/agents')
      .then(r => r.ok ? r.json() : { agents: [] })
      .then((res: any) => {
        const list = (res.agents || []).filter((a: any) => a.enabled !== false);
        setAgents(list);
        if (!agentId && list.length > 0) {
          setAgentId(res.defaultAgent && list.find((a: any) => a.id === res.defaultAgent) ? res.defaultAgent : list[0].id);
        }
      });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Load sessions when picked agent supports them
  const picked = agents.find(a => a.id === agentId);
  const sessionAware = !!picked && (SESSION_AWARE.has(picked.id) || (picked.cliType && SESSION_AWARE.has(picked.cliType)));

  useEffect(() => {
    if (!sessionAware) { setSessions(null); return; }
    setSessions(null);
    fetchProjectSessions(projectName)
      .then(list => {
        // Sort newest first
        const sorted = [...list].sort((a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime());
        setSessions(sorted);
      });
  }, [sessionAware, projectName]);

  const last = sessions?.[0];

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/60" onClick={e => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg shadow-2xl w-[420px] max-w-[95vw]">
        <div className="px-4 py-2 border-b border-[var(--border)] flex items-center gap-2">
          <span className="text-xs font-semibold text-[var(--text-primary)]">🖥 Open craft terminal</span>
          <div className="flex-1" />
          <button onClick={onCancel} className="text-[10px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]">✕</button>
        </div>

        <div className="p-4 space-y-3 text-xs">
          {/* Agent picker */}
          <div>
            <div className="text-[10px] text-[var(--text-secondary)] mb-1">Agent</div>
            <select value={agentId} onChange={e => setAgentId(e.target.value)}
              className="w-full text-xs bg-[var(--bg-tertiary)] border border-[var(--border)] rounded px-2 py-1">
              {agents.length === 0 && <option value="">no agents detected</option>}
              {agents.map(a => <option key={a.id} value={a.id}>{a.name || a.id}</option>)}
            </select>
          </div>

          {/* Session picker — only for session-aware agents */}
          {sessionAware && (
            <div>
              <div className="text-[10px] text-[var(--text-secondary)] mb-1">Session</div>

              {sessions === null && <div className="text-[10px] text-[var(--text-secondary)] py-1">Loading sessions…</div>}

              {sessions && (
                <div className="space-y-1.5">
                  {/* Resume last (default) */}
                  {last && (
                    <button onClick={() => onPick({ agentId, agentName: picked?.name, sessionMode: 'last', sessionId: last.id })}
                      className="w-full text-left px-2.5 py-1.5 rounded border border-emerald-500/40 hover:border-emerald-500 hover:bg-emerald-500/5 transition-colors">
                      <div className="text-[11px] font-semibold flex items-center gap-1.5 text-[var(--text-primary)]">
                        <span className="text-emerald-400">●</span> Resume last session
                      </div>
                      <div className="text-[9px] text-[var(--text-secondary)] font-mono mt-0.5 flex gap-2">
                        <span>{last.id.slice(0, 12)}…</span>
                        <span>{formatRelativeTime(last.modified)}</span>
                        <span>{formatSize(last.size)}</span>
                      </div>
                    </button>
                  )}

                  {/* Fresh */}
                  <button onClick={() => onPick({ agentId, agentName: picked?.name, sessionMode: 'new' })}
                    className="w-full text-left px-2.5 py-1.5 rounded border border-[var(--border)] hover:border-[var(--accent)] hover:bg-[var(--accent)]/5 transition-colors">
                    <div className="text-[11px] font-semibold text-[var(--text-primary)]">+ New session</div>
                    <div className="text-[9px] text-[var(--text-secondary)]">Start a fresh Claude session in this craft's directory</div>
                  </button>

                  {/* Other sessions */}
                  {sessions.length > 1 && (
                    <button onClick={() => setShowAll(v => !v)}
                      className="w-full text-[10px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] py-1 text-left">
                      {showAll ? '▼' : '▶'} Other sessions ({sessions.length - 1})
                    </button>
                  )}

                  {showAll && sessions.slice(1).map(s => (
                    <button key={s.id} onClick={() => onPick({ agentId, agentName: picked?.name, sessionMode: 'specific', sessionId: s.id })}
                      className="w-full text-left px-2.5 py-1 rounded hover:bg-[var(--bg-tertiary)] transition-colors flex items-center gap-2 text-[10px]">
                      <span className="font-mono text-[var(--text-secondary)]">{s.id.slice(0, 10)}</span>
                      <span className="text-[var(--text-secondary)]">{formatRelativeTime(s.modified)}</span>
                      <span className="text-[var(--text-secondary)] opacity-60 ml-auto">{formatSize(s.size)}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {!sessionAware && (
            <button onClick={() => onPick({ agentId, agentName: picked?.name, sessionMode: 'new' })}
              className="w-full px-3 py-2 rounded bg-[var(--accent)]/30 text-[var(--accent)] hover:bg-[var(--accent)]/40 text-xs">
              Open terminal with {picked?.name || agentId}
            </button>
          )}
        </div>

        <div className="px-4 py-2 border-t border-[var(--border)] flex justify-end">
          <button onClick={onCancel}
            className="text-[10px] px-3 py-1 rounded text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]">
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
