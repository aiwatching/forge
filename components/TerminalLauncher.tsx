'use client';

/**
 * TerminalLauncher — unified terminal session picker and open utilities.
 *
 * Two main exports:
 * 1. TerminalSessionPicker — dialog component for choosing how to open a terminal.
 *    Shows: "Current Session" (highlighted), "New Session", expandable list of other sessions.
 *
 * 2. openWorkspaceTerminal / buildProjectTerminalConfig — helpers to open a terminal
 *    correctly depending on context (workspace smith vs project/VibeCoding).
 *
 * Workspace smiths:
 *   - Need FORGE env vars injected via the forge launch script.
 *   - Must go through open_terminal API → daemon creates tmux → FloatingTerminal attaches.
 *
 * Project / VibeCoding:
 *   - Build profileEnv client-side from agent profile.
 *   - FloatingTerminal creates a new tmux session and runs the CLI.
 */

import { useState, useEffect } from 'react';

// ─── Types ────────────────────────────────────────────────

export interface SessionInfo {
  id: string;
  modified: string; // ISO string
  size: number;     // bytes
}

/**
 * Selection result from TerminalSessionPicker.
 * mode='current'  → open with currentSessionId (resume)
 * mode='new'      → open a fresh session (no --resume)
 * mode='session'  → open with a specific sessionId (resume)
 */
export type PickerSelection =
  | { mode: 'current'; sessionId: string }
  | { mode: 'new' }
  | { mode: 'session'; sessionId: string };

// ─── Session Fetchers ─────────────────────────────────────

/**
 * Fetch sessions for a workspace agent (workDir-scoped, via workspace API).
 * Used by workspace smith Open Terminal.
 */
export async function fetchAgentSessions(workspaceId: string, agentId: string): Promise<SessionInfo[]> {
  try {
    const res = await fetch(`/api/workspace/${workspaceId}/smith`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'sessions', agentId }),
    });
    const data = await res.json();
    return data.sessions || [];
  } catch {
    return [];
  }
}

/**
 * Fetch sessions for a project (project-level, via claude-sessions API).
 * Used by ProjectDetail terminal button and VibeCoding / SessionView.
 */
export async function fetchProjectSessions(projectName: string): Promise<SessionInfo[]> {
  try {
    const res = await fetch(`/api/claude-sessions/${encodeURIComponent(projectName)}`);
    const data = await res.json();
    if (!Array.isArray(data)) return [];
    return data.map((s: any) => ({
      id: s.sessionId || s.id || '',
      modified: s.modified || '',
      size: s.fileSize || s.size || 0,
    }));
  } catch {
    return [];
  }
}

// ─── Formatting helpers ───────────────────────────────────

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return new Date(iso).toLocaleDateString();
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / 1_048_576).toFixed(1)}MB`;
}

// ─── SessionItem ──────────────────────────────────────────

function SessionItem({ session, onSelect }: {
  session: SessionInfo;
  onSelect: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  const copyId = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(session.id).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className="rounded border border-[#21262d] hover:border-[#30363d] hover:bg-[#161b22] transition-colors">
      <div className="flex items-center gap-2 px-3 py-1.5 cursor-pointer" onClick={() => setExpanded(!expanded)}>
        <span className="text-[8px] text-gray-600">{expanded ? '▼' : '▶'}</span>
        <span className="text-[9px] text-gray-400 font-mono">{session.id.slice(0, 8)}</span>
        <span className="text-[8px] text-gray-600">{formatRelativeTime(session.modified)}</span>
        <span className="text-[8px] text-gray-600">{formatSize(session.size)}</span>
        <button
          onClick={e => { e.stopPropagation(); onSelect(); }}
          className="ml-auto text-[8px] px-1.5 py-0.5 rounded bg-[#238636]/20 text-[#3fb950] hover:bg-[#238636]/40"
        >
          Resume
        </button>
      </div>
      {expanded && (
        <div className="px-3 pb-2 flex items-center gap-1.5">
          <code className="text-[8px] text-gray-500 font-mono bg-[#161b22] px-1.5 py-0.5 rounded border border-[#21262d] select-all flex-1 overflow-hidden text-ellipsis">
            {session.id}
          </code>
          <button
            onClick={copyId}
            className="text-[8px] px-1.5 py-0.5 rounded bg-[#30363d] text-gray-400 hover:text-white hover:bg-[#484f58] shrink-0"
          >
            {copied ? '✓' : 'Copy'}
          </button>
        </div>
      )}
    </div>
  );
}

// ─── TerminalSessionPicker ────────────────────────────────

/**
 * Unified dialog for choosing how to open a terminal session.
 *
 * Props:
 *   agentLabel        — Display name for the agent / project (shown in title).
 *   currentSessionId  — Bound/fixed session to show as "Current Session". null → no current.
 *   sessions          — List of all available sessions (pre-fetched or lazy). If null, loading spinner shown.
 *   supportsSession   — Whether the agent supports claude --resume. Default true.
 *   onSelect          — Called with the picker result when user chooses an option.
 *   onCancel          — Called when user dismisses without selecting.
 */
export function TerminalSessionPicker({
  agentLabel,
  currentSessionId,
  sessions,
  supportsSession = true,
  onSelect,
  onCancel,
}: {
  agentLabel: string;
  currentSessionId: string | null;
  sessions: SessionInfo[] | null; // null = loading
  supportsSession?: boolean;
  onSelect: (selection: PickerSelection) => void;
  onCancel: () => void;
}) {
  const [showAll, setShowAll] = useState(false);

  const isClaude = supportsSession !== false;

  // Other sessions = all sessions except the current one
  const otherSessions = sessions?.filter(s => s.id !== currentSessionId) ?? [];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.75)' }}
      onClick={e => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div
        className="w-80 rounded-lg border border-[#30363d] p-4 shadow-xl"
        style={{ background: '#0d1117' }}
      >
        <div className="text-sm font-bold text-white mb-3">⌨️ {agentLabel}</div>

        <div className="space-y-2">
          {/* Current Session — shown first, highlighted if exists */}
          {isClaude && currentSessionId && (
            <button
              onClick={() => onSelect({ mode: 'current', sessionId: currentSessionId })}
              className="w-full text-left px-3 py-2 rounded border border-[#3fb950]/60 hover:border-[#3fb950] hover:bg-[#161b22] transition-colors"
            >
              <div className="text-xs text-white font-semibold flex items-center gap-1.5">
                <span className="text-[#3fb950]">●</span> Current Session
              </div>
              <div className="text-[9px] text-gray-500 font-mono mt-0.5">
                {currentSessionId.slice(0, 16)}…
              </div>
            </button>
          )}

          {/* New Session */}
          <button
            onClick={() => onSelect({ mode: 'new' })}
            className="w-full text-left px-3 py-2 rounded border border-[#30363d] hover:border-[#58a6ff] hover:bg-[#161b22] transition-colors"
          >
            <div className="text-xs text-white font-semibold">
              {isClaude ? 'New Session' : 'Open Terminal'}
            </div>
            <div className="text-[9px] text-gray-500">
              {isClaude ? 'Start fresh claude session' : 'Launch terminal'}
            </div>
          </button>

          {/* Loading indicator */}
          {isClaude && sessions === null && (
            <div className="text-[9px] text-gray-600 text-center py-1">Loading sessions…</div>
          )}

          {/* Toggle for other sessions */}
          {isClaude && otherSessions.length > 0 && (
            <button
              onClick={() => setShowAll(!showAll)}
              className="w-full text-[9px] text-gray-500 hover:text-white py-1"
            >
              {showAll ? '▼' : '▶'} Other sessions ({otherSessions.length})
            </button>
          )}

          {/* Other sessions list */}
          {showAll && otherSessions.map(s => (
            <SessionItem
              key={s.id}
              session={s}
              onSelect={() => onSelect({ mode: 'session', sessionId: s.id })}
            />
          ))}
        </div>

        <button
          onClick={onCancel}
          className="w-full mt-3 text-[9px] text-gray-500 hover:text-white"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// ─── TerminalSessionPicker with lazy fetch ─────────────────

/**
 * Higher-level picker that fetches sessions automatically.
 * Accepts a `fetchSessions` async function — result populates the session list.
 */
export function TerminalSessionPickerLazy({
  agentLabel,
  currentSessionId,
  fetchSessions,
  supportsSession = true,
  onSelect,
  onCancel,
}: {
  agentLabel: string;
  currentSessionId: string | null;
  fetchSessions: () => Promise<SessionInfo[]>;
  supportsSession?: boolean;
  onSelect: (selection: PickerSelection) => void;
  onCancel: () => void;
}) {
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null);

  useEffect(() => {
    if (!supportsSession) {
      setSessions([]);
      return;
    }
    fetchSessions().then(setSessions).catch(() => setSessions([]));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <TerminalSessionPicker
      agentLabel={agentLabel}
      currentSessionId={currentSessionId}
      sessions={sessions}
      supportsSession={supportsSession}
      onSelect={onSelect}
      onCancel={onCancel}
    />
  );
}

// ─── Workspace Terminal Open ──────────────────────────────

/**
 * Result from resolving how to open a workspace terminal.
 * When tmuxSession is set → FloatingTerminal should attach (existingSession=tmuxSession).
 * When tmuxSession is null → daemon couldn't create session; fall back to dialog or skip.
 */
export interface WorkspaceTerminalInfo {
  tmuxSession: string | null;
  cliCmd?: string;
  cliType?: string;
  supportsSession?: boolean;
}

/**
 * Ask the orchestrator to create/find the tmux session for a workspace agent.
 * Returns tmuxSession name that FloatingTerminal can attach to.
 * This is the ONLY correct way to open a workspace terminal — ensures FORGE env vars
 * are injected via the forge launch script (not client-side profileEnv).
 */
export async function resolveWorkspaceTerminal(
  workspaceId: string,
  agentId: string,
): Promise<WorkspaceTerminalInfo> {
  try {
    const res = await fetch(`/api/workspace/${workspaceId}/smith`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'open_terminal', agentId }),
    });
    const data = await res.json();
    return {
      tmuxSession: data.tmuxSession || null,
      cliCmd: data.cliCmd,
      cliType: data.cliType,
      supportsSession: data.supportsSession ?? true,
    };
  } catch {
    return { tmuxSession: null };
  }
}

/**
 * Resolve agent info for a workspace agent (resolveOnly — no session created).
 * Used to get cliCmd, cliType, env, model, supportsSession without side effects.
 */
export async function resolveWorkspaceAgentInfo(
  workspaceId: string,
  agentId: string,
): Promise<{ cliCmd?: string; cliType?: string; env?: Record<string, string>; model?: string; supportsSession?: boolean }> {
  try {
    const res = await fetch(`/api/workspace/${workspaceId}/smith`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'open_terminal', agentId, resolveOnly: true }),
    });
    return await res.json();
  } catch {
    return {};
  }
}

// ─── Project Terminal Config ──────────────────────────────

/**
 * Result for opening a project terminal.
 * FloatingTerminal uses profileEnv + resumeSessionId when creating a new tmux session.
 */
export interface ProjectTerminalConfig {
  profileEnv: Record<string, string>;
  resumeSessionId?: string;
  cliCmd?: string;
  cliType?: string;
}

/**
 * Build config for opening a project terminal (VibeCoding / ProjectDetail).
 * Agent env and model are resolved server-side via /api/agents?resolve=<agentId>.
 * FORGE vars are NOT included here — project terminals don't use workspace context.
 */
export async function buildProjectTerminalConfig(
  agentId: string,
  resumeSessionId?: string,
): Promise<ProjectTerminalConfig> {
  try {
    const res = await fetch(`/api/agents?resolve=${encodeURIComponent(agentId)}`);
    const info = await res.json();
    const profileEnv: Record<string, string> = { ...(info.env || {}) };
    if (info.model) profileEnv.CLAUDE_MODEL = info.model;
    return {
      profileEnv,
      resumeSessionId,
      cliCmd: info.cliCmd,
      cliType: info.cliType,
    };
  } catch {
    return { profileEnv: {}, resumeSessionId };
  }
}
