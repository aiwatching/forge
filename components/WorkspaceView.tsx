'use client';

import { useState, useEffect, useCallback, useMemo, useRef, forwardRef, useImperativeHandle, lazy, Suspense } from 'react';
import { TerminalSessionPickerLazy, fetchAgentSessions, type PickerSelection } from './TerminalLauncher';
import {
  ReactFlow, Background, Controls, Handle, Position, useReactFlow, ReactFlowProvider,
  type Node, type NodeProps, MarkerType, type NodeChange,
  applyNodeChanges,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

// ─── Types (mirrors lib/workspace/types) ─────────────────

interface AgentConfig {
  id: string; label: string; icon: string; role: string;
  type?: 'agent' | 'input';
  primary?: boolean;
  content?: string;
  entries?: { content: string; timestamp: number }[];
  backend: 'api' | 'cli';
  agentId?: string; provider?: string; model?: string;
  dependsOn: string[];
  workDir?: string;
  outputs: string[];
  steps: { id: string; label: string; prompt: string }[];
  requiresApproval?: boolean;
  persistentSession?: boolean;
  skipPermissions?: boolean;
  boundSessionId?: string;
  watch?: { enabled: boolean; interval: number; targets: any[]; action?: 'log' | 'analyze' | 'approve' | 'send_message'; prompt?: string; sendTo?: string };
  plugins?: string[];  // plugin IDs to auto-install when agent is created
}

interface AgentState {
  smithStatus: 'down' | 'starting' | 'active';
  taskStatus: 'idle' | 'running' | 'done' | 'failed';
  paused?: boolean;
  currentStep?: number;
  tmuxSession?: string;
  artifacts: { type: string; path?: string; summary?: string }[];
  error?: string; lastCheckpoint?: number;
  daemonIteration?: number;
}

// ─── Constants ───────────────────────────────────────────

const COLORS = [
  { border: '#22c55e', bg: '#0a1a0a', accent: '#4ade80' },
  { border: '#3b82f6', bg: '#0a0f1a', accent: '#60a5fa' },
  { border: '#a855f7', bg: '#100a1a', accent: '#c084fc' },
  { border: '#f97316', bg: '#1a100a', accent: '#fb923c' },
  { border: '#ec4899', bg: '#1a0a10', accent: '#f472b6' },
  { border: '#06b6d4', bg: '#0a1a1a', accent: '#22d3ee' },
];

// Smith status colors
const SMITH_STATUS: Record<string, { label: string; color: string; glow?: boolean }> = {
  down: { label: 'down', color: '#30363d' },
  starting: { label: 'starting', color: '#f0883e' },   // orange: ensurePersistentSession in progress
  active: { label: 'active', color: '#3fb950', glow: true },
};

// Task status colors
const TASK_STATUS: Record<string, { label: string; color: string; glow?: boolean }> = {
  idle: { label: 'idle', color: '#30363d' },
  running: { label: 'running', color: '#3fb950', glow: true },
  done: { label: 'done', color: '#58a6ff' },
  failed: { label: 'failed', color: '#f85149' },
};

const PRESET_AGENTS: Omit<AgentConfig, 'id'>[] = [
  {
    label: 'Lead', icon: '👑', backend: 'cli', agentId: 'claude', dependsOn: [], outputs: ['docs/lead/'],
    primary: true, persistentSession: true, plugins: ['playwright', 'shell-command'],
    role: `Lead — primary coordinator (recommended for Primary smith). Context auto-includes Workspace Team (all agents, roles, status, missing roles).

SOP: Intake → HAS Architect? delegate via create_request : break down yourself → HAS Engineer? create_request(open) : implement in src/ → HAS QA? auto-notified : test yourself → HAS Reviewer? auto-notified : review yourself.

SOP: Monitor → get_status + list_requests → stuck/failed agents: send_message or take over → unclaimed requests: nudge Engineers.

SOP: Quality Gate → ALL requests done + review=approved + qa=passed → write docs/lead/delivery-summary.md.

Gap coverage: missing PM → you break requirements; missing Engineer → you code; missing QA → you test; missing Reviewer → you review. Every delegation uses create_request with acceptance_criteria.`,
    steps: [
      { id: 'intake', label: 'Intake & Analyze', prompt: 'Read Workspace Team in context. Identify present/missing roles and incoming requirements. Classify scope and plan delegation vs self-handling.' },
      { id: 'delegate', label: 'Create Requests & Route', prompt: 'create_request for each task with acceptance_criteria. Route to Architect/Engineer or note for self-implementation. Verify with list_requests.' },
      { id: 'cover-gaps', label: 'Cover Missing Roles', prompt: 'Implement/test/review for any missing role. update_response for each section you cover.' },
      { id: 'monitor', label: 'Monitor & Unblock', prompt: 'get_status + list_requests. Unblock stuck agents via send_message or take over their work.' },
      { id: 'gate', label: 'Quality Gate & Summary', prompt: 'Verify all requests done/approved/passed. Write docs/lead/delivery-summary.md.' },
    ],
  },
  {
    label: 'PM', icon: '📋', backend: 'cli', agentId: 'claude', dependsOn: [], outputs: ['docs/prd/'],
    role: `Product Manager. Context auto-includes Workspace Team.

SOP: Read upstream input → list docs/prd/ for version history → identify NEW vs covered → create NEW versioned PRD (never overwrite).

PRD structure: version + date, summary, goals, user stories with testable acceptance_criteria, constraints, out of scope, open questions.

Version: patch (v1.0.1) = clarification, minor (v1.1) = new feature, major (v2.0) = scope overhaul.

Handoff: Do NOT create request docs or write code. Architect/Lead reads docs/prd/ downstream.`,
    steps: [
      { id: 'analyze', label: 'Analyze Requirements', prompt: 'Read Workspace Team. Read upstream input. List docs/prd/ for version history. Identify NEW vs already covered requirements. Decide version number.' },
      { id: 'write-prd', label: 'Write PRD', prompt: 'Create NEW versioned file in docs/prd/. Include testable acceptance criteria for every user story. Never overwrite existing PRD files.' },
      { id: 'self-review', label: 'Self-Review', prompt: 'Checklist: criteria testable by QA? Edge cases? Scope clear for Engineer? No duplication? Fix issues.' },
    ],
  },
  {
    label: 'Engineer', icon: '🔨', backend: 'cli', agentId: 'claude', dependsOn: [], outputs: ['src/', 'docs/architecture/'],
    role: `Senior Software Engineer. Context auto-includes Workspace Team.

SOP: Find Work → list_requests(status: "open") → claim_request → get_request for details.
SOP: Implement → read acceptance_criteria → design (docs/architecture/) → code (src/) → self-test.
SOP: Report → update_response(section: "engineer", data: {files_changed, notes}) → auto-notifies QA/Reviewer.

IF claim fails (already taken) → pick next open request.
IF blocked by unclear requirement → send_message to upstream (Architect/PM/Lead) with specific question.
IF no open requests → check inbox for direct assignments.

Rules: always claim before starting, always update_response when done, follow existing conventions, architecture docs versioned (never overwrite).`,
    steps: [
      { id: 'claim', label: 'Find & Claim', prompt: 'Read Workspace Team. Check inbox. list_requests(status: "open"). claim_request on highest priority. If none, check inbox.' },
      { id: 'design', label: 'Design', prompt: 'get_request for details. Read acceptance_criteria. Read existing code + docs/architecture/. Create new architecture doc if significant change.' },
      { id: 'implement', label: 'Implement', prompt: 'Implement per design. Follow conventions. Track files changed. Run existing tests. Verify against each acceptance_criterion.' },
      { id: 'report', label: 'Report Done', prompt: 'update_response(section: "engineer") with files_changed and notes. If blocked, send_message upstream.' },
    ],
  },
  {
    label: 'QA', icon: '🧪', backend: 'cli', agentId: 'claude', dependsOn: [], outputs: ['tests/', 'docs/qa/'],
    plugins: ['playwright', 'shell-command'],
    role: `QA Engineer. Context auto-includes Workspace Team.

SOP: Find Work → list_requests(status: "qa") → get_request → read acceptance_criteria + engineer's files_changed.
SOP: Test → map each criterion to test cases → write Playwright tests in tests/e2e/ → run via run_plugin or npx playwright.
SOP: Report → update_response(section: "qa", data: {result, test_files, findings}).

IF result=passed → auto-advances, no message needed.
IF result=failed → classify: CRITICAL/MAJOR → ONE send_message to Engineer. MINOR → report only, no message.

Rules: never fix bugs (report only), each test traces to acceptance_criterion, max 1 consolidated message, no messages during planning/writing steps.`,
    steps: [
      { id: 'find-work', label: 'Find Work', prompt: 'Read Workspace Team. Check inbox. list_requests(status: "qa"). get_request for acceptance_criteria and engineer notes.' },
      { id: 'plan', label: 'Test Plan', prompt: 'Map each criterion to test cases (happy path + edge + error). Write docs/qa/test-plan. Skip already-tested unchanged features.' },
      { id: 'write-tests', label: 'Write Tests', prompt: 'Write Playwright tests in tests/e2e/. Create config if missing. No messages in this step.' },
      { id: 'execute', label: 'Execute & Report', prompt: 'Run tests. Record pass/fail per criterion. update_response(section: qa). If critical/major failures: ONE send_message to Engineer.' },
    ],
  },
  {
    label: 'Reviewer', icon: '🔍', backend: 'cli', agentId: 'claude', dependsOn: [], outputs: ['docs/review/'],
    role: `Code Reviewer. Context auto-includes Workspace Team.

SOP: Find Work → list_requests(status: "review") → get_request → read request + engineer response + QA results.
SOP: Review each file in files_changed → check: criteria met? code quality? security (OWASP)? performance? → classify CRITICAL/MAJOR/MINOR.
SOP: Verdict → approved (all good) / changes_requested (issues) / rejected (security/data).
SOP: Report → update_response(section: "review", data: {result, findings}) → write docs/review/.

IF approved → auto-advances to done, no message.
IF changes_requested → ONE send_message to Engineer with top issues.
IF rejected → send_message to Engineer AND Lead.

Rules: never modify code, review only files_changed (not entire codebase), actionable feedback ("change X to Y because Z"), MINOR findings in report only.`,
    steps: [
      { id: 'find-work', label: 'Find Work', prompt: 'Read Workspace Team. Check inbox. list_requests(status: "review"). get_request for full context.' },
      { id: 'review', label: 'Code Review', prompt: 'Review each file in files_changed: criteria met? quality? security? performance? Classify CRITICAL/MAJOR/MINOR.' },
      { id: 'report', label: 'Verdict & Report', prompt: 'Decide verdict. update_response(section: review). Write docs/review/. If changes_requested/rejected: ONE message to Engineer (+ Lead if rejected).' },
    ],
  },
  {
    label: 'UI Designer', icon: '🎨', backend: 'cli', agentId: 'claude', dependsOn: [], outputs: ['docs/ui-spec.md', 'src/'],
    plugins: ['playwright', 'shell-command'],
    role: `UI/UX Designer — You design and implement user interfaces. You write real UI code, preview it visually, and iterate until the quality meets your standards.

Rules:
- You WRITE CODE, not just specs. Implement the UI yourself.
- After writing UI code, always preview your work: take a screenshot and review it visually.
- Iterate: if the screenshot doesn't look right, fix the code and screenshot again. Aim for 3-5 review cycles.
- Focus on user experience first, aesthetics second
- Design for the existing tech stack (check project's UI framework)
- Be specific: colors (hex), spacing (px/rem), typography, component hierarchy
- Consider responsive design, accessibility (WCAG), dark/light mode
- Include interaction states: hover, active, disabled, loading, error, empty
- Reference existing UI patterns in the codebase for consistency

Visual review workflow:
1. Write/modify UI code
2. Start dev server if not running (e.g., npm run dev)
3. Take screenshot: run_plugin({ plugin: "<playwright-instance>", action: "screenshot", params: { url: "http://localhost:3000/page" } })
4. Read the screenshot file to visually evaluate your work
5. Grade yourself: layout correctness, visual polish, consistency with existing UI, responsiveness
6. If not satisfied, fix and repeat from step 2
7. When satisfied, document the final design in docs/ui-spec.md

If reference designs or mockups exist in the project (e.g., docs/designs/), study them before implementing.`,
    steps: [
      { id: 'audit', label: 'UI Audit', prompt: 'Analyze the existing UI: framework used (React/Vue/etc), component library, design tokens (colors, spacing, fonts), layout patterns. Take screenshots of existing pages to understand the current look and feel. Document the current design system.' },
      { id: 'implement', label: 'Implement UI', prompt: 'Based on the PRD, implement the UI. Write real component code. Start the dev server, take screenshots of your work, and iterate until the visual quality is high. Aim for at least 3 review cycles — screenshot, evaluate, improve.' },
      { id: 'polish', label: 'Polish & Document', prompt: 'Final polish pass: check all states (loading, empty, error, hover, disabled), responsive breakpoints, dark/light mode. Take final screenshots. Write docs/ui-spec.md documenting: component hierarchy, design decisions, interaction patterns, and accessibility notes.' },
    ],
  },
  {
    label: 'Design Evaluator', icon: '🔍', backend: 'cli', agentId: 'claude', dependsOn: [], outputs: ['docs/design-review.md'],
    plugins: ['playwright', 'llm-vision'],
    role: `Design Evaluator — You are a senior design critic. You evaluate UI implementations visually, not by reading code. You are deliberately skeptical and hold work to a high standard.

You evaluate on 4 dimensions (each scored 1-10):
1. **Design Quality** — Visual coherence, distinct identity, not generic/template-like
2. **Originality** — Evidence of intentional design decisions vs default AI patterns
3. **Craft** — Typography, spacing, color harmony, alignment, pixel-level polish
4. **Functionality** — Usability, interaction clarity, error states, responsiveness

Rules:
- NEVER modify code — only evaluate and report
- Always take screenshots and visually inspect before scoring
- Use run_plugin with Playwright to screenshot every relevant page/state
- If llm-vision instances are available, use them for cross-model evaluation
- Be specific: "the spacing between header and content is 8px, should be 16px for breathing room"
- A score of 7+ means "good enough to ship". Below 7 means "needs revision"
- Send feedback to UI Designer via send_message with specific, actionable items
- If overall score < 7, request changes. If >= 7, approve with minor suggestions.

Workflow:
1. Receive notification that UI Designer has completed work
2. Take screenshots of all relevant pages and states (normal, loading, error, empty, mobile)
3. Evaluate each screenshot against the 4 dimensions
4. Optionally send screenshots to llm-vision instances for additional opinions
5. Write docs/design-review.md with scores, specific feedback, and verdict
6. send_message to UI Designer: APPROVE or REQUEST_CHANGES with actionable feedback`,
    steps: [
      { id: 'screenshot', label: 'Visual Capture', prompt: 'Take screenshots of all pages and states the UI Designer worked on. Include: default view, loading state, error state, empty state, mobile viewport (375px), tablet viewport (768px). Save all screenshots to /tmp/ and list them.' },
      { id: 'evaluate', label: 'Evaluate', prompt: 'Review each screenshot. Score each page on the 4 dimensions (Design Quality, Originality, Craft, Functionality). Be critical and specific. If llm-vision plugin instances are available, send key screenshots for additional evaluation and compare opinions.' },
      { id: 'report', label: 'Report & Feedback', prompt: 'Write docs/design-review.md with: overall scores, per-page breakdown, specific issues with suggested fixes. Send verdict to UI Designer via send_message: APPROVE (score >= 7) or REQUEST_CHANGES (score < 7) with the top 3-5 actionable items.' },
    ],
  },
];

// ─── API helpers ─────────────────────────────────────────

async function wsApi(workspaceId: string, action: string, body?: Record<string, any>) {
  const res = await fetch(`/api/workspace/${workspaceId}/agents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...body }),
  });
  const data = await res.json();
  if (data.warning) {
    alert(`Warning: ${data.warning}`);
  }
  if (!res.ok && data.error) {
    alert(`Error: ${data.error}`);
  }
  return data;
}

async function ensureWorkspace(projectPath: string, projectName: string): Promise<string> {
  // Find or create workspace
  const res = await fetch(`/api/workspace?projectPath=${encodeURIComponent(projectPath)}`);
  const existing = await res.json();
  if (existing?.id) return existing.id;

  const createRes = await fetch('/api/workspace', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectPath, projectName }),
  });
  const created = await createRes.json();
  return created.id;
}

// ─── SSE Hook ────────────────────────────────────────────

function useWorkspaceStream(workspaceId: string | null, onEvent?: (event: any) => void) {
  const [agents, setAgents] = useState<AgentConfig[]>([]);
  const [states, setStates] = useState<Record<string, AgentState>>({});
  const [logPreview, setLogPreview] = useState<Record<string, string[]>>({});
  const [busLog, setBusLog] = useState<any[]>([]);
  const [daemonActive, setDaemonActive] = useState(false);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    if (!workspaceId) return;

    // Reconnection state — survives sleep/wake and network drops
    let es: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let staleCheckTimer: ReturnType<typeof setInterval> | null = null;
    let reconnectAttempts = 0;
    let lastEventTime = Date.now();
    let disposed = false;

    const scheduleReconnect = () => {
      if (disposed) return;
      if (reconnectTimer) return;
      // Exponential backoff: 2s, 4s, 8s, max 30s
      const delay = Math.min(30000, 2000 * Math.pow(2, reconnectAttempts));
      reconnectAttempts++;
      console.log(`[sse] reconnecting in ${delay / 1000}s (attempt ${reconnectAttempts})`);
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, delay);
    };

    const connect = () => {
      if (disposed) return;
      try { es?.close(); } catch {}
      lastEventTime = Date.now();
      es = new EventSource(`/api/workspace/${workspaceId}/stream`);

      es.onopen = () => {
        reconnectAttempts = 0;
        lastEventTime = Date.now();
      };

      es.onerror = () => {
        // Browser fires onerror when the connection drops
        console.warn('[sse] EventSource error — will reconnect');
        try { es?.close(); } catch {}
        scheduleReconnect();
      };

      es.onmessage = (e) => {
        lastEventTime = Date.now();
        handleEvent(e);
      };
    };

    // Stall detection: if we haven't received any event (including heartbeat ping from server)
    // for 45s, the connection is stuck (common after Mac sleep). Force reconnect.
    staleCheckTimer = setInterval(() => {
      if (disposed) return;
      if (Date.now() - lastEventTime > 45000) {
        console.warn('[sse] stream stalled (no events for 45s), forcing reconnect');
        try { es?.close(); } catch {}
        lastEventTime = Date.now(); // prevent immediate re-trigger
        connect();
      }
    }, 15000);

    // Detect tab wake from sleep / network recovery — conservative to avoid churn
    const onVisibilityChange = () => {
      if (disposed) return;
      if (document.visibilityState === 'visible' && Date.now() - lastEventTime > 60000) {
        console.log('[sse] page visible after long idle, reconnecting');
        try { es?.close(); } catch {}
        connect();
      }
    };
    const onOnline = () => {
      if (disposed) return;
      console.log('[sse] network online, reconnecting');
      try { es?.close(); } catch {}
      lastEventTime = Date.now();
      connect();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('online', onOnline);

    const handleEvent = (e: MessageEvent) => {
      try {
        const event = JSON.parse(e.data);

        if (event.type === 'init') {
          setAgents(event.agents || []);
          setStates(event.agentStates || {});
          setBusLog(event.busLog || []);
          // Seed logPreview from each agent's history (last 3 entries)
          const initPreview: Record<string, string[]> = {};
          for (const [agentId, st] of Object.entries(event.agentStates || {}) as [string, any][]) {
            const hist: any[] = st?.history || [];
            if (hist.length > 0) {
              // Prefer the most recent step_summary or final_summary if present
              const summary = [...hist].reverse().find(h => h?.subtype === 'step_summary' || h?.subtype === 'final_summary');
              if (summary?.content) {
                initPreview[agentId] = String(summary.content).split('\n').filter(l => l.trim()).slice(0, 4);
              } else {
                initPreview[agentId] = hist.slice(-3).map(h => h?.content).filter(Boolean).map(String);
              }
            }
          }
          setLogPreview(initPreview);
          if (event.daemonActive !== undefined) setDaemonActive(event.daemonActive);
          return;
        }

        if (event.type === 'task_status') {
          setStates(prev => ({
            ...prev,
            [event.agentId]: {
              ...prev[event.agentId],
              taskStatus: event.taskStatus,
              error: event.error,
            },
          }));
        }

        if (event.type === 'smith_status') {
          setStates(prev => ({
            ...prev,
            [event.agentId]: {
              ...prev[event.agentId],
              smithStatus: event.smithStatus,
            },
          }));
        }

        if (event.type === 'log') {
          const entry = event.entry;
          if (entry?.content) {
            setLogPreview(prev => {
              // Summary entries replace the preview entirely (cleaner display)
              if (entry.subtype === 'step_summary' || entry.subtype === 'final_summary') {
                const summaryLines = entry.content.split('\n').filter((l: string) => l.trim()).slice(0, 4);
                return { ...prev, [event.agentId]: summaryLines };
              }
              // Regular logs: append, keep last 3
              const lines = [...(prev[event.agentId] || []), entry.content].slice(-3);
              return { ...prev, [event.agentId]: lines };
            });
          }
        }

        if (event.type === 'step') {
          setStates(prev => ({
            ...prev,
            [event.agentId]: { ...prev[event.agentId], currentStep: event.stepIndex },
          }));
        }

        if (event.type === 'error') {
          setStates(prev => ({
            ...prev,
            [event.agentId]: { ...prev[event.agentId], taskStatus: 'failed', error: event.error },
          }));
        }

        if (event.type === 'bus_message') {
          setBusLog(prev => prev.some(m => m.id === event.message.id) ? prev : [...prev, event.message]);
        }

        if (event.type === 'bus_message_status') {
          setBusLog(prev => prev.map(m =>
            m.id === event.messageId ? { ...m, status: event.status } : m
          ));
        }

        if (event.type === 'bus_log_updated') {
          setBusLog(event.log || []);
        }

        // Server pushed updated agents list + states (after add/remove/update/reset)
        if (event.type === 'agents_changed') {
          const newAgents = event.agents || [];
          setAgents(prev => {
            // Guard: don't accept a smaller agents list unless it was an explicit removal
            // (removal shrinks by exactly 1, not more)
            if (newAgents.length > 0 && newAgents.length < prev.length - 1) {
              console.warn(`[sse] agents_changed: ignoring shrink from ${prev.length} to ${newAgents.length}`);
              return prev;
            }
            return newAgents;
          });
          if (event.agentStates) setStates(event.agentStates);
        }

        // Watch alerts — update agent state with last alert
        if (event.type === 'watch_alert') {
          setStates(prev => ({
            ...prev,
            [event.agentId]: {
              ...prev[event.agentId],
              lastWatchAlert: event.summary,
              lastWatchTime: event.timestamp,
            },
          }));
        }

        // Forward special events to the component
        if (event.type === 'user_input_request' || event.type === 'workspace_complete') {
          onEventRef.current?.(event);
        }
      } catch {}
    };

    // Start the initial connection
    connect();

    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (staleCheckTimer) clearInterval(staleCheckTimer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('online', onOnline);
      try { es?.close(); } catch {}
    };
  }, [workspaceId]);

  return { agents, states, logPreview, busLog, setAgents, daemonActive, setDaemonActive };
}

// ─── Session Target Selector (for Watch) ─────────────────

function SessionTargetSelector({ target, agents, projectPath, onChange }: {
  target: { type: string; path?: string; pattern?: string; cmd?: string };
  agents: AgentConfig[];
  projectPath?: string;
  onChange: (updated: typeof target) => void;
}) {
  const [sessions, setSessions] = useState<{ id: string; modified: string; label: string }[]>([]);

  // Load sessions and mark fixed session
  useEffect(() => {
    if (!projectPath) return;
    const pName = (projectPath || '').replace(/\/+$/, '').split('/').pop() || '';
    Promise.all([
      fetch(`/api/claude-sessions/${encodeURIComponent(pName)}`).then(r => r.json()).catch(() => []),
      fetch(`/api/project-sessions?projectPath=${encodeURIComponent(projectPath)}`).then(r => r.json()).catch(() => ({})),
    ]).then(([data, psData]) => {
      const fixedId = psData?.fixedSessionId || '';
      if (Array.isArray(data)) {
        setSessions(data.map((s: any, i: number) => {
          const sid = s.sessionId || s.id || '';
          const isBound = sid === fixedId;
          const label = isBound ? `${sid.slice(0, 8)} (fixed)` : i === 0 ? `${sid.slice(0, 8)} (latest)` : sid.slice(0, 8);
          return { id: sid, modified: s.modified || '', label };
        }));
      }
    });
  }, [projectPath]);

  return (
    <>
      <select value={target.path || ''} onChange={e => onChange({ ...target, path: e.target.value, cmd: '' })}
        className="text-[10px] bg-[#161b22] border border-[#30363d] rounded px-1 py-0.5 text-white w-24">
        <option value="">Any agent</option>
        {agents.map(a => <option key={a.id} value={a.id}>{a.icon} {a.label}</option>)}
      </select>
      <select value={target.cmd || ''} onChange={e => onChange({ ...target, cmd: e.target.value })}
        className="text-[10px] bg-[#161b22] border border-[#30363d] rounded px-1 py-0.5 text-white w-28">
        <option value="">Latest session</option>
        {sessions.map(s => (
          <option key={s.id} value={s.id}>{s.label}{s.modified ? ` · ${new Date(s.modified).toLocaleDateString()}` : ''}</option>
        ))}
      </select>
      <input value={target.pattern || ''} onChange={e => onChange({ ...target, pattern: e.target.value })}
        placeholder="regex (optional)"
        className="text-[10px] bg-[#161b22] border border-[#30363d] rounded px-1 py-0.5 text-white w-24" />
    </>
  );
}

// ─── Watch Path Picker (file/directory browser) ─────────

function WatchPathPicker({ value, projectPath, onChange }: { value: string; projectPath: string; onChange: (v: string) => void }) {
  const [showBrowser, setShowBrowser] = useState(false);
  const [tree, setTree] = useState<any[]>([]);
  const [search, setSearch] = useState('');
  const [flatFiles, setFlatFiles] = useState<string[]>([]);

  const loadTree = useCallback(() => {
    if (!projectPath) return;
    fetch(`/api/code?dir=${encodeURIComponent(projectPath)}`)
      .then(r => r.json())
      .then(data => {
        setTree(data.tree || []);
        // Build flat list for search
        const files: string[] = [];
        const walk = (nodes: any[], prefix = '') => {
          for (const n of nodes || []) {
            const path = prefix ? `${prefix}/${n.name}` : n.name;
            files.push(n.type === 'dir' ? path + '/' : path);
            if (n.children) walk(n.children, path);
          }
        };
        walk(data.tree || []);
        setFlatFiles(files);
      })
      .catch(() => {});
  }, [projectPath]);

  const filtered = search ? flatFiles.filter(f => f.toLowerCase().includes(search.toLowerCase())).slice(0, 30) : [];

  return (
    <div className="flex-1 flex items-center gap-1 relative">
      <input
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder="./ (project root)"
        className="text-[10px] bg-[#161b22] border border-[#30363d] rounded px-1 py-0.5 text-white flex-1"
      />
      <button onClick={() => { setShowBrowser(!showBrowser); if (!showBrowser) loadTree(); }}
        className="text-[9px] px-1 py-0.5 rounded bg-[#30363d] text-gray-400 hover:text-white shrink-0">📂</button>

      {showBrowser && (
        <div className="absolute left-0 right-0 top-full mt-1 z-50 bg-[#0d1117] border border-[#30363d] rounded-lg shadow-xl max-h-60 overflow-hidden flex flex-col" style={{ minWidth: 250 }}>
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search files & dirs..."
            autoFocus
            className="text-[10px] bg-[#161b22] border-b border-[#30363d] px-2 py-1 text-white focus:outline-none"
          />
          <div className="overflow-y-auto flex-1">
            {search ? (
              // Search results
              filtered.length > 0 ? filtered.map(f => (
                <div key={f} onClick={() => { onChange(f); setShowBrowser(false); setSearch(''); }}
                  className="px-2 py-0.5 text-[9px] text-gray-300 hover:bg-[#161b22] cursor-pointer truncate font-mono">
                  {f.endsWith('/') ? `📁 ${f}` : `📄 ${f}`}
                </div>
              )) : <div className="px-2 py-1 text-[9px] text-gray-500">No matches</div>
            ) : (
              // Tree view (first 2 levels)
              tree.map(n => <PathTreeNode key={n.name} node={n} prefix="" onSelect={p => { onChange(p); setShowBrowser(false); }} />)
            )}
          </div>
          <div className="flex items-center justify-between px-2 py-0.5 border-t border-[#30363d] bg-[#161b22]">
            <span className="text-[8px] text-gray-600">{flatFiles.length} items</span>
            <button onClick={() => setShowBrowser(false)} className="text-[8px] text-gray-500 hover:text-white">Close</button>
          </div>
        </div>
      )}
    </div>
  );
}

function PathTreeNode({ node, prefix, onSelect, depth = 0 }: { node: any; prefix: string; onSelect: (path: string) => void; depth?: number }) {
  const [expanded, setExpanded] = useState(depth < 1);
  const path = prefix ? `${prefix}/${node.name}` : node.name;
  const isDir = node.type === 'dir';

  if (!isDir && depth > 1) return null; // only show files at top 2 levels

  return (
    <div>
      <div
        onClick={() => isDir ? setExpanded(!expanded) : onSelect(path)}
        className="flex items-center px-2 py-0.5 text-[9px] hover:bg-[#161b22] cursor-pointer"
        style={{ paddingLeft: 8 + depth * 12 }}
      >
        <span className="text-gray-500 mr-1 w-3">{isDir ? (expanded ? '▼' : '▶') : ''}</span>
        <span className={isDir ? 'text-[var(--accent)]' : 'text-gray-400'}>{isDir ? '📁' : '📄'} {node.name}</span>
        {isDir && (
          <button onClick={e => { e.stopPropagation(); onSelect(path + '/'); }}
            className="ml-auto text-[8px] text-gray-600 hover:text-[var(--accent)]">select</button>
        )}
      </div>
      {isDir && expanded && node.children && depth < 2 && (
        node.children.map((c: any) => <PathTreeNode key={c.name} node={c} prefix={path} onSelect={onSelect} depth={depth + 1} />)
      )}
    </div>
  );
}

// ─── Fixed Session Picker ────────────────────────────────

function FixedSessionPicker({ projectPath, value, onChange }: { projectPath?: string; value: string; onChange: (v: string) => void }) {
  const [sessions, setSessions] = useState<{ id: string; modified: string; size: number }[]>([]);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!projectPath) return;
    const pName = projectPath.replace(/\/+$/, '').split('/').pop() || '';
    fetch(`/api/claude-sessions/${encodeURIComponent(pName)}`)
      .then(r => r.json())
      .then(data => { if (Array.isArray(data)) setSessions(data.map((s: any) => ({ id: s.sessionId || s.id || '', modified: s.modified || '', size: s.size || 0 }))); })
      .catch(() => {});
  }, [projectPath]);

  const formatTime = (iso: string) => {
    if (!iso) return '';
    const diff = Date.now() - new Date(iso).getTime();
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    return new Date(iso).toLocaleDateString();
  };
  const formatSize = (b: number) => b < 1024 ? `${b}B` : b < 1048576 ? `${(b / 1024).toFixed(0)}KB` : `${(b / 1048576).toFixed(1)}MB`;

  const copyId = () => {
    if (!value) return;
    navigator.clipboard.writeText(value).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });
  };

  return (
    <div className="flex flex-col gap-0.5">
      <label className="text-[9px] text-gray-500">Bound Session {value ? '' : '(auto-detect on first start)'}</label>
      <select value={value} onChange={e => onChange(e.target.value)}
        className="text-[10px] bg-[#161b22] border border-[#30363d] rounded px-2 py-1 text-gray-400 font-mono focus:outline-none focus:border-[#58a6ff]">
        <option value="">Auto-detect (latest session)</option>
        {sessions.map(s => (
          <option key={s.id} value={s.id}>
            {s.id.slice(0, 8)} · {formatTime(s.modified)} · {formatSize(s.size)}
          </option>
        ))}
      </select>
      {value && (
        <div className="flex items-center gap-1 mt-0.5">
          <code className="text-[8px] text-gray-500 font-mono bg-[#0d1117] px-1.5 py-0.5 rounded border border-[#21262d] flex-1 overflow-hidden text-ellipsis select-all">{value}</code>
          <button onClick={copyId} className="text-[8px] px-1.5 py-0.5 rounded bg-[#30363d] text-gray-400 hover:text-white shrink-0">{copied ? '✓' : 'Copy'}</button>
          <button onClick={() => onChange('')} className="text-[8px] px-1.5 py-0.5 rounded text-gray-600 hover:text-red-400 shrink-0">Clear</button>
        </div>
      )}
    </div>
  );
}

// ─── Agent Config Modal ──────────────────────────────────

function AgentConfigModal({ initial, mode, existingAgents, projectPath, onConfirm, onCancel }: {
  initial: Partial<AgentConfig>;
  mode: 'add' | 'edit';
  existingAgents: AgentConfig[];
  projectPath?: string;
  onConfirm: (cfg: Omit<AgentConfig, 'id'>) => void;
  onCancel: () => void;
}) {
  const [label, setLabel] = useState(initial.label || '');
  const [icon, setIcon] = useState(initial.icon || '🤖');
  const [role, setRole] = useState(initial.role || '');
  const [backend, setBackend] = useState<'api' | 'cli'>(initial.backend === 'api' ? 'api' : 'cli');
  const [agentId, setAgentId] = useState(initial.agentId || 'claude');
  const [availableAgents, setAvailableAgents] = useState<{ id: string; name: string; isProfile?: boolean; backendType?: string; base?: string; cliType?: string }[]>([]);

  const [pluginInstances, setPluginInstances] = useState<{ id: string; name: string; icon: string; source?: string }[]>([]);
  const [pluginDefs, setPluginDefs] = useState<{ id: string; name: string; icon: string }[]>([]);

  useEffect(() => {
    fetch('/api/agents').then(r => r.json()).then(data => {
      const list = (data.agents || data || []).map((a: any) => ({
        id: a.id, name: a.name || a.id,
        isProfile: a.isProfile || a.base,
        base: a.base,
        cliType: a.cliType,
        backendType: a.backendType || 'cli',
      }));
      setAvailableAgents(list);
    }).catch(() => {});
    // Fetch saved smith templates
    fetch('/api/smith-templates').then(r => r.json()).then(data => {
      setSavedTemplates(data.templates || []);
    }).catch(() => {});
    // Fetch both: plugin definitions + installed instances
    Promise.all([
      fetch('/api/plugins').then(r => r.json()),
      fetch('/api/plugins?installed=true').then(r => r.json()),
    ]).then(([defData, instData]) => {
      setPluginDefs((defData.plugins || []).map((p: any) => ({ id: p.id, name: p.name, icon: p.icon })));
      setPluginInstances((instData.plugins || []).map((p: any) => ({
        id: p.id,
        name: p.instanceName || p.definition?.name || p.id,
        icon: p.definition?.icon || '🔌',
        source: p.source,
      })));
    }).catch(() => {});
  }, []);
  const [workDirVal, setWorkDirVal] = useState(initial.workDir || '');
  const [outputs, setOutputs] = useState((initial.outputs || []).join(', '));
  const [selectedDeps, setSelectedDeps] = useState<Set<string>>(new Set(initial.dependsOn || []));
  const [stepsText, setStepsText] = useState(
    (initial.steps || []).map(s => `${s.label}: ${s.prompt}`).join('\n') || ''
  );
  const [requiresApproval, setRequiresApproval] = useState(initial.requiresApproval || false);
  const [isPrimary, setIsPrimary] = useState(initial.primary || false);
  const hasPrimaryAlready = existingAgents.some(a => a.primary && a.id !== initial.id);
  const [persistentSession, setPersistentSession] = useState(initial.persistentSession || initial.primary || false);
  const [skipPermissions, setSkipPermissions] = useState(initial.skipPermissions !== false);
  const [agentModel, setAgentModel] = useState(initial.model || '');
  const [watchEnabled, setWatchEnabled] = useState(initial.watch?.enabled || false);
  const [watchInterval, setWatchInterval] = useState(String(initial.watch?.interval || 60));
  const [watchAction, setWatchAction] = useState<'log' | 'analyze' | 'approve' | 'send_message'>(initial.watch?.action || 'log');
  const [watchPrompt, setWatchPrompt] = useState(initial.watch?.prompt || '');
  const [watchSendTo, setWatchSendTo] = useState(initial.watch?.sendTo || '');
  const [selectedPlugins, setSelectedPlugins] = useState<string[]>(initial.plugins || []);
  const [recommendedTypes, setRecommendedTypes] = useState<string[]>([]);
  const [savedTemplates, setSavedTemplates] = useState<{ id: string; name: string; icon: string; description?: string; config: any }[]>([]);
  const [watchDebounce, setWatchDebounce] = useState(String(initial.watch?.targets?.[0]?.debounce ?? 10));
  const [watchTargets, setWatchTargets] = useState<{ type: string; path?: string; cmd?: string; pattern?: string }[]>(
    initial.watch?.targets || []
  );
  const [projectDirs, setProjectDirs] = useState<string[]>([]);

  useEffect(() => {
    if (!watchEnabled || !projectPath) return;
    fetch(`/api/code?dir=${encodeURIComponent(projectPath)}`)
      .then(r => r.json())
      .then(data => {
        // Collect directories with depth limit (max 2 levels for readability)
        const dirs: string[] = [];
        const walk = (nodes: any[], prefix = '', depth = 0) => {
          for (const n of nodes || []) {
            if (n.type === 'dir') {
              const path = prefix ? `${prefix}/${n.name}` : n.name;
              dirs.push(path);
              if (n.children && depth < 2) walk(n.children, path, depth + 1);
            }
          }
        };
        walk(data.tree || []);
        setProjectDirs(dirs);
      })
      .catch(() => {});
  }, [watchEnabled, projectPath]);

  const applyPreset = (p: Omit<AgentConfig, 'id'>) => {
    setLabel(p.label); setIcon(p.icon); setRole(p.role);
    setBackend(p.backend); setAgentId(p.agentId || 'claude');
    setWorkDirVal(p.workDir || './');
    setOutputs(p.outputs.join(', '));
    setStepsText(p.steps.map(s => `${s.label}: ${s.prompt}`).join('\n'));
    setRecommendedTypes(p.plugins || []);
    setSelectedPlugins(p.plugins || []);
    if (p.persistentSession !== undefined) setPersistentSession(!!p.persistentSession);
    if (p.skipPermissions !== undefined) setSkipPermissions(p.skipPermissions !== false);
    if (p.requiresApproval !== undefined) setRequiresApproval(!!p.requiresApproval);
    if (p.model) setAgentModel(p.model);
    if (p.watch) {
      setWatchEnabled(!!p.watch.enabled);
      setWatchInterval(String(p.watch.interval || 60));
      setWatchAction(p.watch.action || 'log');
      setWatchPrompt(p.watch.prompt || '');
      setWatchSendTo(p.watch.sendTo || '');
      setWatchTargets(p.watch.targets || []);
      setWatchDebounce(String(p.watch.targets?.[0]?.debounce ?? 10));
    }
  };

  const applySavedTemplate = (t: { config: any }) => {
    const c = t.config;
    applyPreset({
      label: c.label || '', icon: c.icon || '🤖', role: c.role || '',
      backend: c.backend || 'cli', agentId: c.agentId, dependsOn: [],
      workDir: c.workDir || './', outputs: c.outputs || [],
      steps: c.steps || [], plugins: c.plugins,
      persistentSession: c.persistentSession, skipPermissions: c.skipPermissions,
      requiresApproval: c.requiresApproval, model: c.model,
      watch: c.watch,
    } as any);
  };

  const handleImportFile = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const data = JSON.parse(text);
        // Support both raw config and template wrapper
        const config = data.config || data;
        applySavedTemplate({ config });
      } catch {
        alert('Invalid template file');
      }
    };
    input.click();
  };

  const toggleDep = (id: string) => {
    setSelectedDeps(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const parseSteps = () => stepsText.split('\n').filter(Boolean).map((line, i) => {
    const [lbl, ...rest] = line.split(':');
    return { id: `step-${i}`, label: lbl.trim(), prompt: rest.join(':').trim() || lbl.trim() };
  });

  // Filter out self when editing
  const otherAgents = existingAgents.filter(a => a.id !== initial.id);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.75)' }}
      onClick={e => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="w-[440px] max-h-[80vh] overflow-auto rounded-lg border border-[#30363d] p-4 shadow-xl" style={{ background: '#0d1117' }}>
        <div className="flex items-center justify-between mb-3">
          <span className="text-sm font-bold text-white">{mode === 'add' ? 'Add Agent' : 'Edit Agent'}</span>
          <button onClick={onCancel} className="text-gray-500 hover:text-white text-xs">✕</button>
        </div>

        <div className="flex flex-col gap-2.5">
          {/* Preset + saved templates (add mode only) */}
          {mode === 'add' && (
            <div className="flex flex-col gap-1">
              <label className="text-[9px] text-gray-500 uppercase">Presets</label>
              <div className="flex gap-1 flex-wrap">
                {PRESET_AGENTS.map((p, i) => (
                  <button key={i} onClick={() => applyPreset(p)}
                    title={p.primary ? 'Recommended for Primary smith (runs at project root, coordinates others)' : p.label}
                    className={`text-[9px] px-2 py-1 rounded border transition-colors ${label === p.label ? 'border-[#58a6ff] text-[#58a6ff] bg-[#58a6ff]/10' : p.primary ? 'border-[#f0883e]/40 text-[#f0883e] hover:border-[#f0883e]' : 'border-[#30363d] text-gray-400 hover:text-white'}`}>
                    {p.icon} {p.label}{p.primary ? ' ★' : ''}
                  </button>
                ))}
                <button onClick={() => { setLabel(''); setIcon('🤖'); setRole(''); setStepsText(''); setOutputs(''); }}
                  className={`text-[9px] px-2 py-1 rounded border border-dashed ${!label ? 'border-[#58a6ff] text-[#58a6ff]' : 'border-[#30363d] text-gray-500 hover:text-white'}`}>
                  Custom
                </button>
              </div>
              {savedTemplates.length > 0 && (<>
                <label className="text-[9px] text-gray-500 uppercase mt-1">Saved Templates</label>
                <div className="flex gap-1 flex-wrap">
                  {savedTemplates.map(t => (
                    <button key={t.id} onClick={() => applySavedTemplate(t)}
                      className={`text-[9px] px-2 py-1 rounded border transition-colors ${label === t.config?.label ? 'border-[#f0883e] text-[#f0883e] bg-[#f0883e]/10' : 'border-[#30363d] text-gray-400 hover:text-white'}`}
                      title={t.description || t.name}>
                      {t.icon} {t.name}
                    </button>
                  ))}
                </div>
              </>)}
              <button onClick={handleImportFile}
                className="text-[9px] px-2 py-1 rounded border border-dashed border-[#30363d] text-gray-500 hover:text-white hover:border-gray-400 self-start mt-0.5">
                📂 Import from file
              </button>
            </div>
          )}

          {/* Icon + Label */}
          <div className="flex gap-2">
            <div className="flex flex-col gap-1">
              <label className="text-[9px] text-gray-500 uppercase">Icon</label>
              <input value={icon} onChange={e => setIcon(e.target.value)} className="w-12 text-center text-sm bg-[#161b22] border border-[#30363d] rounded px-1 py-1 text-white focus:outline-none focus:border-[#58a6ff]" />
            </div>
            <div className="flex flex-col gap-1 flex-1">
              <label className="text-[9px] text-gray-500 uppercase">Label</label>
              <input value={label} onChange={e => setLabel(e.target.value)} placeholder="e.g. Engineer" className="text-xs bg-[#161b22] border border-[#30363d] rounded px-2 py-1 text-white focus:outline-none focus:border-[#58a6ff]" />
            </div>
          </div>

          {/* Backend */}
          <div className="flex flex-col gap-1">
            <label className="text-[9px] text-gray-500 uppercase">Backend</label>
            <div className="flex gap-1">
              {(['cli', 'api'] as const).map(b => (
                <button key={b} onClick={() => setBackend(b)}
                  className={`text-[9px] px-2 py-1 rounded border ${backend === b ? 'border-[#58a6ff] text-[#58a6ff] bg-[#58a6ff]/10' : 'border-[#30363d] text-gray-400 hover:text-white'}`}>
                  {b === 'cli' ? 'CLI (subscription)' : 'API (api key)'}
                </button>
              ))}
            </div>
          </div>

          {/* Agent selection — dynamic from /api/agents */}
          {backend === 'cli' && (
            <div className="flex flex-col gap-1">
              <label className="text-[9px] text-gray-500 uppercase">Agent / Profile</label>
              <div className="flex gap-1 flex-wrap">
                {(availableAgents.length > 0
                  ? availableAgents.filter(a => a.backendType !== 'api')
                  : [{ id: 'claude', name: 'claude' }, { id: 'codex', name: 'codex' }, { id: 'aider', name: 'aider' }]
                ).map(a => (
                  <button key={a.id} onClick={() => setAgentId(a.id)}
                    className={`text-[9px] px-2 py-1 rounded border ${agentId === a.id ? 'border-[#58a6ff] text-[#58a6ff] bg-[#58a6ff]/10' : 'border-[#30363d] text-gray-400 hover:text-white'}`}>
                    {a.name}{a.isProfile ? ' ●' : ''}
                  </button>
                ))}
              </div>
            </div>
          )}
          {backend === 'api' && (
            <div className="flex flex-col gap-1">
              <label className="text-[9px] text-gray-500 uppercase">API Profile</label>
              <div className="flex gap-1 flex-wrap">
                {availableAgents.filter(a => a.backendType === 'api').map(a => (
                  <button key={a.id} onClick={() => setAgentId(a.id)}
                    className={`text-[9px] px-2 py-1 rounded border ${agentId === a.id ? 'border-[#58a6ff] text-[#58a6ff] bg-[#58a6ff]/10' : 'border-[#30363d] text-gray-400 hover:text-white'}`}>
                    {a.name}
                  </button>
                ))}
                {availableAgents.filter(a => a.backendType === 'api').length === 0 && (
                  <span className="text-[9px] text-gray-600">No API profiles configured. Add in Settings.</span>
                )}
              </div>
            </div>
          )}

          {/* Role */}
          <div className="flex flex-col gap-1">
            <label className="text-[9px] text-gray-500 uppercase">Role / System Prompt</label>
            <textarea value={role} onChange={e => setRole(e.target.value)} rows={5}
              placeholder="Describe this agent's role, responsibilities, available tools, and decision criteria. This will be synced to CLAUDE.md in the agent's working directory."
              className="text-xs bg-[#161b22] border border-[#30363d] rounded px-2 py-1 text-white focus:outline-none focus:border-[#58a6ff] resize-y" />
          </div>

          {/* Plugin Instances grouped by plugin */}
          <div className="flex flex-col gap-1">
            <label className="text-[9px] text-gray-500 uppercase">Plugin Instances</label>
            {(() => {
              const withSource = pluginInstances.filter(i => i.source);
              if (withSource.length === 0) return <span className="text-[8px] text-gray-600">No instances — create in Marketplace → Plugins</span>;
              // Group by source plugin
              const groups: Record<string, typeof withSource> = {};
              for (const inst of withSource) {
                const key = inst.source!;
                if (!groups[key]) groups[key] = [];
                groups[key].push(inst);
              }
              // Show recommended types that have no instances yet
              const missingRecommended = recommendedTypes.filter(rt =>
                !withSource.some(i => i.source === rt)
              );

              return <>
                {Object.entries(groups).map(([sourceId, insts]) => {
                  const def = pluginDefs.find(d => d.id === sourceId);
                  const isRecommended = recommendedTypes.includes(sourceId);
                  return (
                    <div key={sourceId} className="flex items-start gap-2">
                      <span className={`text-[9px] shrink-0 w-20 pt-1 truncate ${isRecommended ? 'text-[#58a6ff]' : 'text-gray-500'}`} title={def?.name || sourceId}>
                        {def?.icon || '🔌'} {def?.name || sourceId}
                        {isRecommended && <span className="text-[7px] ml-0.5">★</span>}
                      </span>
                      <div className="flex flex-wrap gap-1 flex-1">
                        {insts.map(inst => {
                          const selected = selectedPlugins.includes(inst.id);
                          return (
                            <button key={inst.id}
                              onClick={() => setSelectedPlugins(prev => selected ? prev.filter(x => x !== inst.id) : [...prev, inst.id])}
                              className={`text-[9px] px-2 py-0.5 rounded border transition-colors ${
                                selected
                                  ? 'border-green-500/40 text-green-400 bg-green-500/10'
                                  : isRecommended
                                    ? 'border-[#58a6ff]/30 text-[#58a6ff]/70 hover:text-[#58a6ff]'
                                    : 'border-[#30363d] text-gray-500 hover:text-gray-300'
                              }`}>
                              {inst.name}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
                {missingRecommended.length > 0 && missingRecommended.map(rt => {
                  const def = pluginDefs.find(d => d.id === rt);
                  return (
                    <div key={rt} className="flex items-start gap-2">
                      <span className="text-[9px] text-[#58a6ff] shrink-0 w-20 pt-1 truncate">
                        {def?.icon || '🔌'} {def?.name || rt}<span className="text-[7px] ml-0.5">★</span>
                      </span>
                      <span className="text-[8px] text-[#58a6ff]/50 italic pt-1">No instances — create in Marketplace → Plugins</span>
                    </div>
                  );
                })}
              </>;

            })()}
          </div>

          {/* Depends On — checkbox list of existing agents */}
          {otherAgents.length > 0 && (
            <div className="flex flex-col gap-1">
              <label className="text-[9px] text-gray-500 uppercase">Depends On (upstream agents)</label>
              <div className="flex flex-wrap gap-1.5">
                {otherAgents.map(a => (
                  <button key={a.id} onClick={() => toggleDep(a.id)}
                    className={`text-[9px] px-2 py-1 rounded border flex items-center gap-1 ${
                      selectedDeps.has(a.id)
                        ? 'border-[#58a6ff] text-[#58a6ff] bg-[#58a6ff]/10'
                        : 'border-[#30363d] text-gray-400 hover:text-white'}`}>
                    <span>{selectedDeps.has(a.id) ? '☑' : '☐'}</span>
                    <span>{a.icon} {a.label}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Work Dir + Outputs */}
          <div className="flex gap-2">
            <div className="flex flex-col gap-1 w-28">
              <label className="text-[9px] text-gray-500 uppercase">Work Dir</label>
              <input value={isPrimary ? './' : workDirVal} onChange={e => !isPrimary && setWorkDirVal(e.target.value)} placeholder={label ? `${label.toLowerCase().replace(/\s+/g, '-')}/` : 'engineer/'}
                disabled={isPrimary}
                className={`text-xs bg-[#161b22] border border-[#30363d] rounded px-2 py-1 text-white focus:outline-none focus:border-[#58a6ff] ${isPrimary ? 'opacity-50 cursor-not-allowed' : ''}`} />
              <div className="text-[8px] text-gray-600 mt-0.5">
                → {'{project}/'}{(workDirVal || (label ? `${label.toLowerCase().replace(/\s+/g, '-')}/` : '')).replace(/^\.?\//, '')}
              </div>
            </div>
            <div className="flex flex-col gap-1 flex-1">
              <label className="text-[9px] text-gray-500 uppercase">Outputs</label>
              <input value={outputs} onChange={e => setOutputs(e.target.value)} placeholder="docs/prd.md, src/"
                className="text-xs bg-[#161b22] border border-[#30363d] rounded px-2 py-1 text-white focus:outline-none focus:border-[#58a6ff]" />
            </div>
          </div>

          {/* Primary Agent */}
          <div className="flex items-center gap-2">
            <input type="checkbox" id="primaryAgent" checked={isPrimary}
              onChange={e => {
                const v = e.target.checked;
                setIsPrimary(v);
                if (v) { setPersistentSession(true); setWorkDirVal('./'); }
              }}
              disabled={hasPrimaryAlready && !isPrimary}
              className={`accent-[#f0883e] ${hasPrimaryAlready && !isPrimary ? 'opacity-50 cursor-not-allowed' : ''}`} />
            <label htmlFor="primaryAgent" className={`text-[9px] ${isPrimary ? 'text-[#f0883e] font-medium' : 'text-gray-400'}`}>
              Primary agent (terminal-only, root directory, fixed session)
              {hasPrimaryAlready && !isPrimary && <span className="text-gray-600 ml-1">— already set on another agent</span>}
            </label>
          </div>

          {/* Requires Approval */}
          <div className="flex items-center gap-2">
            <input type="checkbox" id="requiresApproval" checked={requiresApproval} onChange={e => setRequiresApproval(e.target.checked)}
              className="accent-[#58a6ff]" />
            <label htmlFor="requiresApproval" className="text-[9px] text-gray-400">Require approval before processing inbox messages</label>
          </div>

          {/* Persistent Session — only for claude-code based agents */}
          {(() => {
            // Check if selected agent supports terminal mode (claude-code or its profiles)
            const selectedAgent = availableAgents.find(a => a.id === agentId);
            const isClaude = selectedAgent?.cliType === 'claude-code' || selectedAgent?.base === 'claude' || !selectedAgent;
            const canTerminal = isClaude || isPrimary;
            return canTerminal ? (
              <>
                <div className="flex items-center gap-2">
                  <input type="checkbox" id="persistentSession" checked={persistentSession} onChange={e => !isPrimary && setPersistentSession(e.target.checked)}
                    disabled={isPrimary}
                    className={`accent-[#3fb950] ${isPrimary ? 'opacity-50 cursor-not-allowed' : ''}`} />
                  <label htmlFor="persistentSession" className={`text-[9px] text-gray-400 ${isPrimary ? 'opacity-50' : ''}`}>
                    Terminal mode {isPrimary ? '(required for primary)' : '— run in terminal instead of headless'}
                  </label>
                </div>
                {persistentSession && (
                  <div className="flex flex-col gap-1.5 ml-4">
                    <div className="flex items-center gap-2">
                      <input type="checkbox" id="skipPermissions" checked={skipPermissions} onChange={e => setSkipPermissions(e.target.checked)}
                        className="accent-[#f0883e]" />
                      <label htmlFor="skipPermissions" className="text-[9px] text-gray-400">Skip permissions (auto-approve all tool calls)</label>
                    </div>
                  </div>
                )}
              </>
            ) : (
              <div className="text-[8px] text-gray-500 bg-gray-500/10 px-2 py-1 rounded">
                Headless mode only — {agentId} does not support terminal mode
              </div>
            );
          })()}

          {/* Model override — only for claude-code agents */}
          {(() => {
            const sa = availableAgents.find(a => a.id === agentId);
            const ct = sa?.cliType || (agentId === 'claude' ? 'claude-code' : '');
            if (ct !== 'claude-code') return null;
            return (
              <div className="flex flex-col gap-0.5">
                <label className="text-[9px] text-gray-500 uppercase">Model</label>
                <input value={agentModel} onChange={e => setAgentModel(e.target.value)}
                  placeholder="default (uses profile or system default)"
                  list="workspace-model-list"
                  className="text-xs bg-[#161b22] border border-[#30363d] rounded px-2 py-1 text-white focus:outline-none focus:border-[#58a6ff] font-mono" />
                <datalist id="workspace-model-list">
                  <option value="claude-sonnet-4-6" />
                  <option value="claude-opus-4-6" />
                  <option value="claude-haiku-4-5-20251001" />
                </datalist>
              </div>
            );
          })()}

          {/* Steps */}
          <div className="flex flex-col gap-1">
            <label className="text-[9px] text-gray-500 uppercase">Steps (one per line — Label: Prompt)</label>
            <textarea value={stepsText} onChange={e => setStepsText(e.target.value)} rows={4}
              placeholder="Analyze: Read docs and identify requirements&#10;Write: Write PRD to docs/prd.md&#10;Review: Review and improve"
              className="text-xs bg-[#161b22] border border-[#30363d] rounded px-2 py-1 text-white focus:outline-none focus:border-[#58a6ff] resize-none font-mono" />
          </div>

          {/* Watch */}
          <div className="flex flex-col gap-1.5 border-t border-[#21262d] pt-2 mt-1">
            <div className="flex items-center gap-2">
              <label className="text-[9px] text-gray-500 uppercase">Watch</label>
              <input type="checkbox" checked={watchEnabled} onChange={e => setWatchEnabled(e.target.checked)}
                className="accent-[#58a6ff]" />
              <span className="text-[8px] text-gray-600">Autonomous periodic monitoring</span>
            </div>
            {watchEnabled && (<>
              <div className="flex gap-2">
                <div className="flex flex-col gap-0.5">
                  <label className="text-[8px] text-gray-600">Interval (s)</label>
                  <input value={watchInterval} onChange={e => setWatchInterval(e.target.value)} type="number" min="10"
                    className="text-xs bg-[#161b22] border border-[#30363d] rounded px-2 py-1 text-white focus:outline-none focus:border-[#58a6ff] w-16" />
                </div>
                <div className="flex flex-col gap-0.5">
                  <label className="text-[8px] text-gray-600">Debounce (s)</label>
                  <input value={watchDebounce} onChange={e => setWatchDebounce(e.target.value)} type="number" min="0"
                    className="text-xs bg-[#161b22] border border-[#30363d] rounded px-2 py-1 text-white focus:outline-none focus:border-[#58a6ff] w-16" />
                </div>
                <div className="flex flex-col gap-0.5 flex-1">
                  <label className="text-[8px] text-gray-600">On Change</label>
                  <select value={watchAction} onChange={e => setWatchAction(e.target.value as any)}
                    className="text-xs bg-[#161b22] border border-[#30363d] rounded px-2 py-1 text-white focus:outline-none focus:border-[#58a6ff]">
                    <option value="log">Log only</option>
                    <option value="analyze">Auto analyze</option>
                    <option value="approve">Require approval</option>
                    <option value="send_message">Send to agent</option>
                  </select>
                </div>
                {watchAction === 'send_message' && (
                  <div className="flex flex-col gap-0.5 flex-1">
                    <label className="text-[8px] text-gray-600">Send to</label>
                    <select value={watchSendTo} onChange={e => setWatchSendTo(e.target.value)}
                      className="text-xs bg-[#161b22] border border-[#30363d] rounded px-2 py-1 text-white focus:outline-none focus:border-[#58a6ff]">
                      <option value="">Select agent...</option>
                      {existingAgents.filter(a => a.id !== initial.id).map(a =>
                        <option key={a.id} value={a.id}>{a.icon} {a.label}</option>
                      )}
                    </select>
                  </div>
                )}
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-[8px] text-gray-600">Targets</label>
                {watchTargets.map((t, i) => (
                  <div key={i} className="flex items-center gap-1">
                    <select value={t.type} onChange={e => {
                      const next = [...watchTargets];
                      next[i] = { type: e.target.value };
                      setWatchTargets(next);
                    }} className="text-[10px] bg-[#161b22] border border-[#30363d] rounded px-1 py-0.5 text-white w-24">
                      <option value="directory">Directory</option>
                      <option value="git">Git</option>
                      <option value="agent_output">Agent Output</option>
                      <option value="agent_log">Agent Log</option>
                      <option value="session">Session Output</option>
                      <option value="command">Command</option>
                      <option value="agent_status">Agent Status</option>
                    </select>
                    {t.type === 'directory' && (
                      <WatchPathPicker
                        value={t.path || ''}
                        projectPath={projectPath || ''}
                        onChange={v => {
                          const next = [...watchTargets];
                          next[i] = { ...t, path: v };
                          setWatchTargets(next);
                        }}
                      />
                    )}
                    {t.type === 'agent_status' && (<>
                      <select value={t.path || ''} onChange={e => {
                        const next = [...watchTargets];
                        next[i] = { ...t, path: e.target.value };
                        setWatchTargets(next);
                      }} className="text-[10px] bg-[#161b22] border border-[#30363d] rounded px-1 py-0.5 text-white flex-1">
                        <option value="">Select agent...</option>
                        {existingAgents.filter(a => a.id !== initial.id).map(a =>
                          <option key={a.id} value={a.id}>{a.icon} {a.label}</option>
                        )}
                      </select>
                      <select value={t.pattern || ''} onChange={e => {
                        const next = [...watchTargets];
                        next[i] = { ...t, pattern: e.target.value };
                        setWatchTargets(next);
                      }} className="text-[10px] bg-[#161b22] border border-[#30363d] rounded px-1 py-0.5 text-white w-20">
                        <option value="">Any change</option>
                        <option value="done">done</option>
                        <option value="failed">failed</option>
                        <option value="running">running</option>
                        <option value="idle">idle</option>
                      </select>
                    </>)}
                    {t.type === 'agent_output' && (
                      <select value={t.path || ''} onChange={e => {
                        const next = [...watchTargets];
                        next[i] = { ...t, path: e.target.value };
                        setWatchTargets(next);
                      }} className="text-[10px] bg-[#161b22] border border-[#30363d] rounded px-1 py-0.5 text-white flex-1">
                        <option value="">Select agent...</option>
                        {existingAgents.filter(a => a.id !== initial.id).map(a =>
                          <option key={a.id} value={a.id}>{a.icon} {a.label}</option>
                        )}
                      </select>
                    )}
                    {t.type === 'agent_log' && (<>
                      <select value={t.path || ''} onChange={e => {
                        const next = [...watchTargets];
                        next[i] = { ...t, path: e.target.value };
                        setWatchTargets(next);
                      }} className="text-[10px] bg-[#161b22] border border-[#30363d] rounded px-1 py-0.5 text-white flex-1">
                        <option value="">Select agent...</option>
                        {existingAgents.filter(a => a.id !== initial.id).map(a =>
                          <option key={a.id} value={a.id}>{a.icon} {a.label}</option>
                        )}
                      </select>
                      <input value={t.pattern || ''} onChange={e => {
                        const next = [...watchTargets];
                        next[i] = { ...t, pattern: e.target.value };
                        setWatchTargets(next);
                      }} placeholder="keyword (optional)"
                        className="text-[10px] bg-[#161b22] border border-[#30363d] rounded px-1 py-0.5 text-white w-24" />
                    </>)}
                    {t.type === 'session' && (
                      <SessionTargetSelector
                        target={t}
                        agents={existingAgents.filter(a => a.id !== initial.id)}
                        projectPath={projectPath}
                        onChange={(updated) => {
                          const next = [...watchTargets];
                          next[i] = updated;
                          setWatchTargets(next);
                        }}
                      />
                    )}
                    {t.type === 'command' && (
                      <input value={t.cmd || ''} onChange={e => {
                        const next = [...watchTargets];
                        next[i] = { ...t, cmd: e.target.value };
                        setWatchTargets(next);
                      }} placeholder="npm test"
                        className="text-[10px] bg-[#161b22] border border-[#30363d] rounded px-1 py-0.5 text-white flex-1" />
                    )}
                    <button onClick={() => setWatchTargets(watchTargets.filter((_, j) => j !== i))}
                      className="text-[9px] text-gray-500 hover:text-red-400">✕</button>
                  </div>
                ))}
                <button onClick={() => setWatchTargets([...watchTargets, { type: 'directory' }])}
                  className="text-[8px] text-gray-500 hover:text-[#58a6ff] self-start">+ Add target</button>
              </div>
              {watchAction === 'analyze' && (
                <div className="flex flex-col gap-0.5">
                  <label className="text-[8px] text-gray-600">Analysis prompt (optional)</label>
                  <input value={watchPrompt} onChange={e => setWatchPrompt(e.target.value)}
                    placeholder="Analyze these changes and check for issues..."
                    className="text-xs bg-[#161b22] border border-[#30363d] rounded px-2 py-1 text-white focus:outline-none focus:border-[#58a6ff]" />
                </div>
              )}
              {watchAction === 'send_message' && (
                <div className="flex flex-col gap-0.5">
                  <label className="text-[8px] text-gray-600">Message context (sent with detected changes)</label>
                  <input value={watchPrompt} onChange={e => setWatchPrompt(e.target.value)}
                    placeholder="Review the following changes and report issues..."
                    className="text-xs bg-[#161b22] border border-[#30363d] rounded px-2 py-1 text-white focus:outline-none focus:border-[#58a6ff]" />
                </div>
              )}
            </>)}
          </div>
        </div>

        <div className="flex justify-end gap-2 mt-4">
          {mode === 'edit' && (
            <button onClick={() => {
              const config = {
                label: label.trim(), icon: icon.trim() || '🤖', role: role.trim(),
                backend, agentId, workDir: workDirVal.trim() || './',
                outputs: outputs.split(',').map(s => s.trim()).filter(Boolean),
                steps: parseSteps(), plugins: selectedPlugins.length > 0 ? selectedPlugins : undefined,
                persistentSession: persistentSession || undefined, skipPermissions: persistentSession ? (skipPermissions ? undefined : false) : undefined,
                model: agentModel || undefined, requiresApproval: requiresApproval || undefined,
                watch: watchEnabled && watchTargets.length > 0 ? { enabled: true, interval: Math.max(10, parseInt(watchInterval) || 60), targets: watchTargets.map(t => ({ ...t, debounce: parseInt(watchDebounce) || 10 })), action: watchAction, prompt: watchPrompt || undefined, sendTo: watchSendTo || undefined } : undefined,
              };
              const blob = new Blob([JSON.stringify({ config, name: label.trim(), icon: icon.trim() || '🤖', exportedAt: Date.now() }, null, 2)], { type: 'application/json' });
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url; a.download = `smith-${label.trim().toLowerCase().replace(/\s+/g, '-')}.json`; a.click();
              URL.revokeObjectURL(url);
            }} className="text-xs px-3 py-1.5 rounded border border-[#30363d] text-gray-400 hover:text-white mr-auto" title="Export config as file">
              📤 Export
            </button>
          )}
          <button onClick={onCancel} className="text-xs px-3 py-1.5 rounded border border-[#30363d] text-gray-400 hover:text-white">Cancel</button>
          <button disabled={!label.trim()} onClick={() => {
            onConfirm({
              label: label.trim(), icon: icon.trim() || '🤖', role: role.trim(),
              backend, agentId, dependsOn: Array.from(selectedDeps),
              workDir: isPrimary ? './' : (workDirVal.trim() || label.trim().toLowerCase().replace(/\s+/g, '-') + '/'),
              outputs: outputs.split(',').map(s => s.trim()).filter(Boolean),
              steps: parseSteps(),
              primary: isPrimary || undefined,
              requiresApproval: requiresApproval || undefined,
              persistentSession: (() => {
                if (isPrimary) return true;
                // Non-terminal agents (codex, aider, etc.) force headless
                const sa = availableAgents.find(a => a.id === agentId);
                const isClaude = sa?.cliType === 'claude-code' || sa?.base === 'claude' || !sa;
                return (isClaude || isPrimary) ? (persistentSession || undefined) : false;
              })(),
              skipPermissions: persistentSession ? (skipPermissions ? undefined : false) : undefined,
              model: agentModel || undefined,
              watch: watchEnabled && watchTargets.length > 0 ? {
                enabled: true,
                interval: Math.max(10, parseInt(watchInterval) || 60),
                targets: watchTargets.map(t => ({ ...t, debounce: parseInt(watchDebounce) || 10 })),
                action: watchAction,
                prompt: watchPrompt || undefined,
                sendTo: watchSendTo || undefined,
              } : undefined,
              plugins: selectedPlugins.length > 0 ? selectedPlugins : undefined,
            } as any);
          }} className="text-xs px-3 py-1.5 rounded bg-[#238636] text-white hover:bg-[#2ea043] disabled:opacity-40">
            {mode === 'add' ? 'Add' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Message Dialog ──────────────────────────────────────

function MessageDialog({ agentLabel, onSend, onCancel }: {
  agentLabel: string;
  onSend: (msg: string) => void;
  onCancel: () => void;
}) {
  const [msg, setMsg] = useState('');
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.75)' }}
      onClick={e => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="w-96 rounded-lg border border-[#30363d] p-4 shadow-xl" style={{ background: '#0d1117' }}>
        <div className="text-sm font-bold text-white mb-2">Message to {agentLabel}</div>
        <textarea value={msg} onChange={e => setMsg(e.target.value)} rows={3} autoFocus
          placeholder="Type your message..."
          className="w-full text-xs bg-[#161b22] border border-[#30363d] rounded px-2 py-1.5 text-white focus:outline-none focus:border-[#58a6ff] resize-none" />
        <div className="flex justify-end gap-2 mt-3">
          <button onClick={onCancel} className="text-xs px-3 py-1.5 rounded border border-[#30363d] text-gray-400 hover:text-white">Cancel</button>
          <button onClick={() => { if (msg.trim()) onSend(msg.trim()); }}
            className="text-xs px-3 py-1.5 rounded bg-[#238636] text-white hover:bg-[#2ea043]">Send</button>
        </div>
      </div>
    </div>
  );
}

// ─── Run Prompt Dialog ───────────────────────────────────

function RunPromptDialog({ agentLabel, onRun, onCancel }: {
  agentLabel: string;
  onRun: (input: string) => void;
  onCancel: () => void;
}) {
  const [input, setInput] = useState('');
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.75)' }}
      onClick={e => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="w-[460px] rounded-lg border border-[#30363d] p-4 shadow-xl" style={{ background: '#0d1117' }}>
        <div className="text-sm font-bold text-white mb-1">Run {agentLabel}</div>
        <div className="text-[9px] text-gray-500 mb-3">Describe the task or requirements. This will be the initial input for the agent.</div>
        <textarea value={input} onChange={e => setInput(e.target.value)} rows={5} autoFocus
          placeholder="e.g. Build a REST API for user management with login, registration, and profile endpoints. Use Express + TypeScript + PostgreSQL."
          className="w-full text-xs bg-[#161b22] border border-[#30363d] rounded px-2 py-1.5 text-white focus:outline-none focus:border-[#58a6ff] resize-none" />
        <div className="flex items-center justify-between mt-3">
          <span className="text-[8px] text-gray-600">Leave empty to run without specific input</span>
          <div className="flex gap-2">
            <button onClick={onCancel} className="text-xs px-3 py-1.5 rounded border border-[#30363d] text-gray-400 hover:text-white">Cancel</button>
            <button onClick={() => onRun(input.trim())}
              className="text-xs px-3 py-1.5 rounded bg-[#238636] text-white hover:bg-[#2ea043]">▶ Run</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Log Panel (overlay) ─────────────────────────────────

/** Format log content: extract readable text from JSON, format nicely */
function LogContent({ content, subtype }: { content: string; subtype?: string }) {
  if (!content) return null;
  const MAX_LINES = 40;
  const MAX_CHARS = 4000;

  let text = content;

  // Try to parse JSON and extract human-readable content
  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed === 'string') {
        text = parsed;
      } else if (parsed.content) {
        text = String(parsed.content);
      } else if (parsed.text) {
        text = String(parsed.text);
      } else if (parsed.result) {
        text = typeof parsed.result === 'string' ? parsed.result : JSON.stringify(parsed.result, null, 2);
      } else if (parsed.message?.content) {
        // Claude stream-json format
        const blocks = Array.isArray(parsed.message.content) ? parsed.message.content : [parsed.message.content];
        text = blocks.map((b: any) => {
          if (typeof b === 'string') return b;
          if (b.type === 'text') return b.text;
          if (b.type === 'tool_use') return `🔧 ${b.name}(${typeof b.input === 'string' ? b.input : JSON.stringify(b.input).slice(0, 100)})`;
          if (b.type === 'tool_result') return `→ ${typeof b.content === 'string' ? b.content.slice(0, 200) : JSON.stringify(b.content).slice(0, 200)}`;
          return JSON.stringify(b).slice(0, 100);
        }).join('\n');
      } else if (Array.isArray(parsed)) {
        text = parsed.map((item: any) => typeof item === 'string' ? item : JSON.stringify(item)).join('\n');
      } else {
        // Generic object — show key fields only
        const keys = Object.keys(parsed);
        if (keys.length <= 5) {
          text = keys.map(k => `${k}: ${typeof parsed[k] === 'string' ? parsed[k] : JSON.stringify(parsed[k]).slice(0, 80)}`).join('\n');
        } else {
          text = JSON.stringify(parsed, null, 2);
        }
      }
    } catch {
      // Not valid JSON, keep as-is
    }
  }

  // Truncate
  const lines = text.split('\n');
  const truncatedLines = lines.length > MAX_LINES;
  const truncatedChars = text.length > MAX_CHARS;
  if (truncatedLines) text = lines.slice(0, MAX_LINES).join('\n');
  if (truncatedChars) text = text.slice(0, MAX_CHARS);
  const truncated = truncatedLines || truncatedChars;

  return (
    <span className="break-all">
      <pre className="whitespace-pre-wrap text-[10px] leading-relaxed inline">{text}</pre>
      {truncated && <span className="text-gray-600 text-[9px]"> ...({lines.length} lines)</span>}
    </span>
  );
}

function LogPanel({ agentId, agentLabel, workspaceId, onClose }: {
  agentId: string; agentLabel: string; workspaceId: string; onClose: () => void;
}) {
  const [logs, setLogs] = useState<any[]>([]);
  const [filter, setFilter] = useState<'all' | 'messages' | 'summaries'>('all');
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Read persistent logs from logs.jsonl (not in-memory state history)
    fetch(`/api/workspace/${workspaceId}/smith`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'logs', agentId }),
    }).then(r => r.json()).then(data => {
      if (data.logs?.length) setLogs(data.logs);
    }).catch(() => {});
  }, [workspaceId, agentId]);

  useEffect(() => {
    scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight);
  }, [logs, filter]);

  const filteredLogs = filter === 'all' ? logs :
    filter === 'messages' ? logs.filter((e: any) => e.subtype === 'bus_message' || e.subtype === 'revalidation_request' || e.subtype === 'user_message') :
    logs.filter((e: any) => e.subtype === 'step_summary' || e.subtype === 'final_summary');

  const msgCount = logs.filter((e: any) => e.subtype === 'bus_message' || e.subtype === 'revalidation_request' || e.subtype === 'user_message').length;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.85)' }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="flex flex-col rounded-xl overflow-hidden shadow-2xl" style={{ width: '75vw', height: '65vh', border: '1px solid #30363d', background: '#0d1117' }}>
        <div className="flex items-center gap-2 px-4 py-2 border-b border-[#30363d] shrink-0">
          <span className="text-sm font-bold text-white">Logs: {agentLabel}</span>
          <span className="text-[9px] text-gray-500">{filteredLogs.length}/{logs.length}</span>
          {/* Filter tabs */}
          <div className="flex gap-1 ml-3">
            {([['all', 'All'], ['messages', `📨 Messages${msgCount > 0 ? ` (${msgCount})` : ''}`], ['summaries', '📊 Summaries']] as const).map(([key, label]) => (
              <button key={key} onClick={() => setFilter(key as any)}
                className={`text-[8px] px-2 py-0.5 rounded ${filter === key ? 'bg-[#21262d] text-white' : 'text-gray-500 hover:text-gray-300'}`}>
                {label}
              </button>
            ))}
          </div>
          <button onClick={async () => {
            await fetch(`/api/workspace/${workspaceId}/smith`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action: 'clear_logs', agentId }),
            });
            setLogs([]);
          }} className="text-[8px] text-gray-500 hover:text-red-400 ml-auto mr-2">Clear</button>
          <button onClick={onClose} className="text-gray-500 hover:text-white text-sm">✕</button>
        </div>
        <div ref={scrollRef} className="flex-1 overflow-auto p-3 font-mono text-[11px] space-y-0.5">
          {filteredLogs.length === 0 && <div className="text-gray-600 text-center mt-8">{filter === 'all' ? 'No logs yet' : 'No matching entries'}</div>}
          {filteredLogs.map((entry, i) => {
            const isSummary = entry.subtype === 'step_summary' || entry.subtype === 'final_summary';
            const isBusMsg = entry.subtype === 'bus_message' || entry.subtype === 'revalidation_request' || entry.subtype === 'user_message';
            return (
              <div key={i} className={`${
                isSummary ? 'my-1 px-2 py-1.5 rounded border border-[#21262d] text-[#58a6ff] bg-[#161b22]' :
                isBusMsg ? 'my-0.5 px-2 py-1 rounded border border-[#f0883e30] text-[#f0883e] bg-[#f0883e08]' :
                'flex gap-2 ' + (
                  entry.type === 'system' ? 'text-gray-600' :
                  entry.type === 'result' ? 'text-green-400' : 'text-gray-300'
                )
              }`}>
                {isSummary ? (
                  <pre className="whitespace-pre-wrap text-[10px] leading-relaxed">{entry.content}</pre>
                ) : isBusMsg ? (
                  <div className="text-[10px] flex items-center gap-2">
                    <span>📨</span>
                    <span className="text-[8px] text-gray-500">{entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString() : ''}</span>
                    <span>{entry.content}</span>
                  </div>
                ) : (
                  <>
                    <span className="text-[8px] text-gray-600 shrink-0 w-16">{entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString() : ''}</span>
                    {entry.subtype === 'tool_use' && <span className="text-yellow-500 shrink-0">🔧 {entry.tool || 'tool'}</span>}
                    {entry.subtype === 'tool_result' && <span className="text-cyan-500 shrink-0">→</span>}
                    {entry.subtype === 'init' && <span className="text-blue-400 shrink-0">⚡</span>}
                    {entry.subtype === 'daemon' && <span className="text-purple-400 shrink-0">👁</span>}
                    {entry.subtype === 'watch_detected' && <span className="text-orange-400 shrink-0">🔍</span>}
                    {entry.subtype === 'error' && <span className="text-red-400 shrink-0">❌</span>}
                    {!entry.tool && entry.subtype === 'text' && <span className="text-gray-500 shrink-0">💬</span>}
                    <LogContent content={entry.content} subtype={entry.subtype} />
                  </>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ─── Memory Panel ────────────────────────────────────────

const TYPE_COLORS: Record<string, string> = {
  decision: 'text-yellow-400', bugfix: 'text-red-400', feature: 'text-green-400',
  refactor: 'text-cyan-400', discovery: 'text-purple-400', change: 'text-gray-400', session: 'text-blue-400',
};

function MemoryPanel({ agentId, agentLabel, workspaceId, onClose }: {
  agentId: string; agentLabel: string; workspaceId: string; onClose: () => void;
}) {
  const [data, setData] = useState<any>(null);

  useEffect(() => {
    fetch(`/api/workspace/${workspaceId}/memory?agentId=${encodeURIComponent(agentId)}`)
      .then(r => r.json()).then(setData).catch(() => {});
  }, [workspaceId, agentId]);

  const stats = data?.stats;
  const display: any[] = data?.display || [];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.85)' }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="flex flex-col rounded-xl overflow-hidden shadow-2xl" style={{ width: '70vw', height: '65vh', border: '1px solid #30363d', background: '#0d1117' }}>
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-2 border-b border-[#30363d] shrink-0">
          <span className="text-sm">🧠</span>
          <span className="text-sm font-bold text-white">Memory: {agentLabel}</span>
          {stats && (
            <span className="text-[9px] text-gray-500">
              {stats.totalObservations} observations, {stats.totalSessions} sessions
              {stats.lastUpdated && ` · last updated ${new Date(stats.lastUpdated).toLocaleString()}`}
            </span>
          )}
          <button onClick={onClose} className="text-gray-500 hover:text-white text-sm ml-auto">✕</button>
        </div>

        {/* Stats bar */}
        {stats?.typeBreakdown && Object.keys(stats.typeBreakdown).length > 0 && (
          <div className="flex items-center gap-3 px-4 py-1.5 border-b border-[#21262d] text-[9px]">
            {Object.entries(stats.typeBreakdown).map(([type, count]) => (
              <span key={type} className={TYPE_COLORS[type] || 'text-gray-400'}>
                {type}: {count as number}
              </span>
            ))}
          </div>
        )}

        {/* Entries */}
        <div className="flex-1 overflow-auto p-3 space-y-1.5">
          {display.length === 0 && (
            <div className="text-gray-600 text-center mt-8">No memory yet. Run this agent to build memory.</div>
          )}
          {display.map((entry: any) => (
            <div key={entry.id} className={`rounded px-3 py-2 ${entry.isCompact ? 'opacity-60' : ''}`}
              style={{ background: '#161b22', border: '1px solid #21262d' }}>
              <div className="flex items-center gap-2">
                <span className="text-[10px]">{entry.icon}</span>
                <span className={`text-[9px] font-medium ${TYPE_COLORS[entry.type] || 'text-gray-400'}`}>{entry.type}</span>
                <span className="text-[10px] text-white flex-1 truncate">{entry.title}</span>
                <span className="text-[8px] text-gray-600 shrink-0">
                  {new Date(entry.timestamp).toLocaleString()}
                </span>
              </div>
              {!entry.isCompact && entry.subtitle && (
                <div className="text-[9px] text-gray-500 mt-1">{entry.subtitle}</div>
              )}
              {!entry.isCompact && entry.facts && entry.facts.length > 0 && (
                <div className="mt-1 space-y-0.5">
                  {entry.facts.map((f: string, i: number) => (
                    <div key={i} className="text-[8px] text-gray-500">• {f}</div>
                  ))}
                </div>
              )}
              {entry.files && entry.files.length > 0 && (
                <div className="text-[8px] text-gray-600 mt-1">
                  Files: {entry.files.join(', ')}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Bus Message Panel ───────────────────────────────────

// ─── Agent Inbox/Outbox Panel ────────────────────────────

function InboxPanel({ agentId, agentLabel, busLog, agents, workspaceId, onClose }: {
  agentId: string; agentLabel: string; busLog: any[]; agents: AgentConfig[]; workspaceId: string; onClose: () => void;
}) {
  const labelMap = new Map(agents.map(a => [a.id, `${a.icon} ${a.label}`]));
  const getLabel = (id: string) => labelMap.get(id) || id;
  const [deletedIds, setDeletedIds] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Filter messages related to this agent, exclude locally deleted
  const inbox = busLog.filter(m => m.to === agentId && m.type !== 'ack' && !deletedIds.has(m.id));
  const outbox = busLog.filter(m => m.from === agentId && m.to !== '_system' && m.type !== 'ack' && !deletedIds.has(m.id));
  const [tab, setTab] = useState<'inbox' | 'outbox'>('inbox');
  const messages = tab === 'inbox' ? inbox : outbox;

  const handleDelete = async (msgId: string) => {
    await wsApi(workspaceId, 'delete_message', { messageId: msgId });
    setDeletedIds(prev => new Set(prev).add(msgId));
  };

  const toggleSelect = (msgId: string) => {
    setSelected(prev => { const s = new Set(prev); s.has(msgId) ? s.delete(msgId) : s.add(msgId); return s; });
  };

  const selectAll = () => {
    const deletable = messages.filter(m => m.status === 'done' || m.status === 'failed');
    setSelected(new Set(deletable.map(m => m.id)));
  };

  const handleBatchDelete = async () => {
    for (const id of selected) {
      await wsApi(workspaceId, 'delete_message', { messageId: id });
      setDeletedIds(prev => new Set(prev).add(id));
    }
    setSelected(new Set());
  };

  const handleAbortAllPending = async () => {
    const pendingMsgs = messages.filter(m => m.status === 'pending');
    await Promise.all(pendingMsgs.map(m =>
      wsApi(workspaceId, 'abort_message', { messageId: m.id }).catch(() => {})
    ));
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.85)' }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="flex flex-col rounded-xl overflow-hidden shadow-2xl" style={{ width: '60vw', height: '50vh', border: '1px solid #30363d', background: '#0d1117' }}>
        <div className="flex items-center gap-2 px-4 py-2 border-b border-[#30363d] shrink-0">
          <span className="text-sm">📨</span>
          <span className="text-sm font-bold text-white">{agentLabel}</span>
          <div className="flex gap-1 ml-3">
            <button onClick={() => setTab('inbox')}
              className={`text-[9px] px-2 py-0.5 rounded ${tab === 'inbox' ? 'bg-[#21262d] text-white' : 'text-gray-500 hover:text-gray-300'}`}>
              Inbox ({inbox.length})
            </button>
            <button onClick={() => setTab('outbox')}
              className={`text-[9px] px-2 py-0.5 rounded ${tab === 'outbox' ? 'bg-[#21262d] text-white' : 'text-gray-500 hover:text-gray-300'}`}>
              Outbox ({outbox.length})
            </button>
          </div>
          {selected.size > 0 && (
            <div className="flex items-center gap-2 ml-3">
              <span className="text-[9px] text-gray-400">{selected.size} selected</span>
              <button onClick={handleBatchDelete}
                className="text-[8px] px-2 py-0.5 rounded bg-red-600/20 text-red-400 hover:bg-red-600/30">
                Delete selected
              </button>
              <button onClick={() => setSelected(new Set())}
                className="text-[8px] px-2 py-0.5 rounded bg-gray-600/20 text-gray-400 hover:bg-gray-600/30">
                Clear
              </button>
            </div>
          )}
          {selected.size === 0 && (
            <div className="flex items-center gap-2 ml-3">
              {messages.some(m => m.status === 'done' || m.status === 'failed') && (
                <button onClick={selectAll}
                  className="text-[8px] px-2 py-0.5 rounded text-gray-500 hover:text-gray-300">
                  Select all completed
                </button>
              )}
              {messages.some(m => m.status === 'pending') && (
                <button onClick={handleAbortAllPending}
                  className="text-[8px] px-2 py-0.5 rounded bg-red-600/20 text-red-400 hover:bg-red-600/30">
                  Abort all pending ({messages.filter(m => m.status === 'pending').length})
                </button>
              )}
            </div>
          )}
          <button onClick={onClose} className="text-gray-500 hover:text-white text-sm ml-auto">✕</button>
        </div>
        <div className="flex-1 overflow-auto p-3 space-y-1.5">
          {messages.length === 0 && (
            <div className="text-gray-600 text-center mt-8">No {tab} messages</div>
          )}
          {[...messages].reverse().map((msg, i) => {
            const isTicket = msg.category === 'ticket';
            const canSelect = msg.status === 'done' || msg.status === 'failed';
            return (
            <div key={i} className="flex items-start gap-2 px-3 py-2 rounded text-[10px]" style={{
              background: '#161b22',
              border: `1px solid ${isTicket ? '#6e40c9' : '#21262d'}`,
              borderLeft: isTicket ? '3px solid #a371f7' : undefined,
            }}>
              {canSelect && (
                <input type="checkbox" checked={selected.has(msg.id)} onChange={() => toggleSelect(msg.id)}
                  className="mt-1 shrink-0 accent-[#58a6ff]" />
              )}
              <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1 flex-wrap">
                <span className="text-[8px] text-gray-600">{new Date(msg.timestamp).toLocaleString()}</span>
                {tab === 'inbox' ? (
                  <span className="text-blue-400">← {getLabel(msg.from)}</span>
                ) : (
                  <span className="text-green-400">→ {getLabel(msg.to)}</span>
                )}
                {/* Category badge */}
                {isTicket && (
                  <span className="px-1 py-0.5 rounded text-[7px] bg-purple-500/20 text-purple-400">TICKET</span>
                )}
                {/* Action badge */}
                <span className={`px-1.5 py-0.5 rounded text-[8px] ${
                  msg.payload?.action === 'fix_request' || msg.payload?.action === 'bug_report' ? 'bg-red-500/20 text-red-400' :
                  msg.payload?.action === 'update_notify' || msg.payload?.action === 'request_complete' ? 'bg-blue-500/20 text-blue-400' :
                  msg.payload?.action === 'question' ? 'bg-yellow-500/20 text-yellow-400' :
                  'bg-gray-500/20 text-gray-400'
                }`}>{msg.payload?.action}</span>
                {/* Ticket status */}
                {isTicket && msg.ticketStatus && (
                  <span className={`text-[7px] px-1 rounded ${
                    msg.ticketStatus === 'open' ? 'bg-yellow-500/20 text-yellow-400' :
                    msg.ticketStatus === 'in_progress' ? 'bg-blue-500/20 text-blue-400' :
                    msg.ticketStatus === 'fixed' ? 'bg-green-500/20 text-green-400' :
                    msg.ticketStatus === 'verified' ? 'bg-green-600/20 text-green-300' :
                    msg.ticketStatus === 'closed' ? 'bg-gray-500/20 text-gray-400' :
                    'bg-gray-500/20 text-gray-400'
                  }`}>{msg.ticketStatus}</span>
                )}
                {/* Message delivery status */}
                <span className={`text-[7px] ${msg.status === 'done' ? 'text-green-500' : msg.status === 'running' ? 'text-blue-400' : msg.status === 'failed' ? 'text-red-500' : msg.status === 'pending_approval' ? 'text-orange-400' : 'text-yellow-500'}`}>
                  {msg.status || 'pending'}
                </span>
                {/* Retry count for tickets */}
                {isTicket && (msg.ticketRetries || 0) > 0 && (
                  <span className="text-[7px] text-orange-400">retry {msg.ticketRetries}/{msg.maxRetries || 3}</span>
                )}
                {/* CausedBy trace */}
                {msg.causedBy && (
                  <span className="text-[7px] text-gray-600" title={`Triggered by message from ${getLabel(msg.causedBy.from)}`}>
                    ← {getLabel(msg.causedBy.from)}
                  </span>
                )}
                {/* Actions */}
                {msg.status === 'pending_approval' && (
                  <div className="flex gap-1 ml-auto">
                    <button onClick={() => wsApi(workspaceId, 'approve_message', { messageId: msg.id })}
                      className="text-[7px] px-1.5 py-0.5 rounded bg-green-600/20 text-green-400 hover:bg-green-600/30">
                      ✓ Approve
                    </button>
                    <button onClick={() => wsApi(workspaceId, 'reject_message', { messageId: msg.id })}
                      className="text-[7px] px-1.5 py-0.5 rounded bg-red-600/20 text-red-400 hover:bg-red-600/30">
                      ✕ Reject
                    </button>
                  </div>
                )}
                {(msg.status === 'pending' || msg.status === 'running') && msg.type !== 'ack' && (
                  <div className="flex gap-1 ml-auto">
                    <button onClick={() => wsApi(workspaceId, 'message_done', { messageId: msg.id })}
                      className="text-[7px] px-1.5 py-0.5 rounded bg-green-600/20 text-green-400 hover:bg-green-600/30">
                      ✓ Done
                    </button>
                    <button onClick={() => wsApi(workspaceId, 'abort_message', { messageId: msg.id })}
                      className="text-[7px] px-1.5 py-0.5 rounded bg-red-600/20 text-red-400 hover:bg-red-600/30">
                      ✕ Abort
                    </button>
                  </div>
                )}
                {(msg.status === 'done' || msg.status === 'failed') && msg.type !== 'ack' && (
                  <div className="flex gap-1 ml-auto">
                    <button onClick={() => wsApi(workspaceId, 'retry_message', { messageId: msg.id })}
                      className="text-[7px] px-1.5 py-0.5 rounded bg-orange-600/20 text-orange-400 hover:bg-orange-600/30">
                      {msg.status === 'done' ? '↻ Re-run' : '↻ Retry'}
                    </button>
                    <button onClick={() => handleDelete(msg.id)}
                      className="text-[7px] px-1.5 py-0.5 rounded bg-gray-600/20 text-gray-400 hover:bg-red-600/20 hover:text-red-400">
                      🗑
                    </button>
                  </div>
                )}
              </div>
              <div className="text-gray-300">{msg.payload?.content || ''}</div>
              {msg.payload?.files?.length > 0 && (
                <div className="text-[8px] text-gray-600 mt-1">Files: {msg.payload.files.join(', ')}</div>
              )}
              </div>
            </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function BusPanel({ busLog, agents, onClose }: {
  busLog: any[]; agents: AgentConfig[]; onClose: () => void;
}) {
  const labelMap = new Map(agents.map(a => [a.id, `${a.icon} ${a.label}`]));
  const getLabel = (id: string) => labelMap.get(id) || id;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.85)' }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="flex flex-col rounded-xl overflow-hidden shadow-2xl" style={{ width: '65vw', height: '55vh', border: '1px solid #30363d', background: '#0d1117' }}>
        <div className="flex items-center gap-2 px-4 py-2 border-b border-[#30363d] shrink-0">
          <span className="text-sm">📡</span>
          <span className="text-sm font-bold text-white">Agent Communication Logs</span>
          <span className="text-[9px] text-gray-500">{busLog.length} messages</span>
          <button onClick={onClose} className="text-gray-500 hover:text-white text-sm ml-auto">✕</button>
        </div>
        <div className="flex-1 overflow-auto p-3 space-y-1">
          {busLog.length === 0 && <div className="text-gray-600 text-center mt-8">No messages yet</div>}
          {[...busLog].reverse().map((msg, i) => (
            <div key={i} className="flex items-start gap-2 text-[10px] px-3 py-1.5 rounded"
              style={{ background: '#161b22', border: '1px solid #21262d' }}>
              <span className="text-gray-600 shrink-0 w-14">{new Date(msg.timestamp).toLocaleTimeString()}</span>
              <span className="text-blue-400 shrink-0">{getLabel(msg.from)}</span>
              <span className="text-gray-600">→</span>
              <span className="text-green-400 shrink-0">{msg.to === '_system' ? '📡 system' : getLabel(msg.to)}</span>
              <span className={`px-1 rounded text-[8px] ${
                msg.payload?.action === 'fix_request' ? 'bg-red-500/20 text-red-400' :
                msg.payload?.action === 'task_complete' ? 'bg-green-500/20 text-green-400' :
                msg.payload?.action === 'ack' ? 'bg-gray-500/20 text-gray-500' :
                'bg-blue-500/20 text-blue-400'
              }`}>{msg.payload?.action}</span>
              <span className="text-gray-400 truncate flex-1">{msg.payload?.content || ''}</span>
              {msg.status && msg.status !== 'done' && (
                <span className={`text-[7px] px-1 rounded ${
                  msg.status === 'done' ? 'text-green-500' : msg.status === 'failed' ? 'text-red-500' : 'text-yellow-500'
                }`}>{msg.status}</span>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Terminal Launch Dialog ───────────────────────────────

function SessionItem({ session, formatTime, formatSize, onSelect }: {
  session: { id: string; modified: string; size: number };
  formatTime: (iso: string) => string;
  formatSize: (bytes: number) => string;
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
        <span className="text-[8px] text-gray-600">{formatTime(session.modified)}</span>
        <span className="text-[8px] text-gray-600">{formatSize(session.size)}</span>
        <button onClick={(e) => { e.stopPropagation(); onSelect(); }}
          className="ml-auto text-[8px] px-1.5 py-0.5 rounded bg-[#238636]/20 text-[#3fb950] hover:bg-[#238636]/40">Resume</button>
      </div>
      {expanded && (
        <div className="px-3 pb-2 flex items-center gap-1.5">
          <code className="text-[8px] text-gray-500 font-mono bg-[#161b22] px-1.5 py-0.5 rounded border border-[#21262d] select-all flex-1 overflow-hidden text-ellipsis">
            {session.id}
          </code>
          <button onClick={copyId}
            className="text-[8px] px-1.5 py-0.5 rounded bg-[#30363d] text-gray-400 hover:text-white hover:bg-[#484f58] shrink-0">
            {copied ? '✓' : 'Copy'}
          </button>
        </div>
      )}
    </div>
  );
}

function TerminalLaunchDialog({ agent, workDir, sessName, projectPath, workspaceId, supportsSession, onLaunch, onCancel }: {
  agent: AgentConfig; workDir?: string; sessName: string; projectPath: string; workspaceId: string;
  supportsSession?: boolean;
  onLaunch: (resumeMode: boolean, sessionId?: string) => void; onCancel: () => void;
}) {
  const [sessions, setSessions] = useState<{ id: string; modified: string; size: number }[]>([]);
  const [showSessions, setShowSessions] = useState(false);
  // Use resolved supportsSession from API (defaults to true for backwards compat)
  const isClaude = supportsSession !== false;

  // Fetch recent sessions (only for claude-based agents)
  useEffect(() => {
    if (!isClaude) return;
    fetch(`/api/workspace/${workspaceId}/smith`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'sessions', agentId: agent.id }),
    }).then(r => r.json()).then(d => {
      if (d.sessions?.length) setSessions(d.sessions);
    }).catch(() => {});
  }, [workspaceId, isClaude]);

  const formatTime = (iso: string) => {
    const d = new Date(iso);
    const now = new Date();
    const diff = now.getTime() - d.getTime();
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    return d.toLocaleDateString();
  };

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1048576) return `${(bytes / 1024).toFixed(0)}KB`;
    return `${(bytes / 1048576).toFixed(1)}MB`;
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.75)' }}
      onClick={e => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="w-80 rounded-lg border border-[#30363d] p-4 shadow-xl" style={{ background: '#0d1117' }}>
        <div className="text-sm font-bold text-white mb-3">⌨️ {agent.label}</div>

        <div className="space-y-2">
          <button onClick={() => onLaunch(false)}
            className="w-full text-left px-3 py-2 rounded border border-[#30363d] hover:border-[#58a6ff] hover:bg-[#161b22] transition-colors">
            <div className="text-xs text-white font-semibold">{isClaude ? 'New Session' : 'Open Terminal'}</div>
            <div className="text-[9px] text-gray-500">{isClaude ? 'Start fresh claude session' : `Launch ${agent.agentId || 'agent'}`}</div>
          </button>

          {isClaude && sessions.length > 0 && (
            <button onClick={() => onLaunch(true)}
              className="w-full text-left px-3 py-2 rounded border border-[#30363d] hover:border-[#3fb950] hover:bg-[#161b22] transition-colors">
              <div className="text-xs text-white font-semibold">Resume Latest</div>
              <div className="text-[9px] text-gray-500">
                {sessions[0].id.slice(0, 8)} · {formatTime(sessions[0].modified)} · {formatSize(sessions[0].size)}
              </div>
            </button>
          )}

          {isClaude && sessions.length > 1 && (
            <button onClick={() => setShowSessions(!showSessions)}
              className="w-full text-[9px] text-gray-500 hover:text-white py-1">
              {showSessions ? '▼' : '▶'} All sessions ({sessions.length})
            </button>
          )}

          {showSessions && sessions.map(s => (
            <SessionItem key={s.id} session={s} formatTime={formatTime} formatSize={formatSize}
              onSelect={() => onLaunch(true, s.id)} />
          ))}
        </div>

        <button onClick={onCancel}
          className="w-full mt-3 text-[9px] text-gray-500 hover:text-white">Cancel</button>
      </div>
    </div>
  );
}

// ─── Floating Terminal ────────────────────────────────────

function getWsUrl() {
  if (typeof window === 'undefined') return 'ws://localhost:8404';
  const p = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const h = window.location.hostname;
  if (h !== 'localhost' && h !== '127.0.0.1') return `${p}//${window.location.host}/terminal-ws`;
  const port = parseInt(window.location.port) || 8403;
  return `${p}//${h}:${port + 1}`;
}

// ─── Bell notification (smith taskStatus changes) ────────

const bellLastFired = new Map<string, number>();
const BELL_COOLDOWN = 30000; // 30s cooldown per smith
function fireSmithBell(label: string, status: 'done' | 'failed') {
  const key = `${label}-${status}`;
  const now = Date.now();
  const last = bellLastFired.get(key) || 0;
  if (now - last < BELL_COOLDOWN) return;
  bellLastFired.set(key, now);
  const title = status === 'done' ? 'Forge — Smith Done ✅' : 'Forge — Smith Failed ❌';
  const body = `"${label}" task ${status === 'done' ? 'completed' : 'failed'}.`;
  // Browser notification
  if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
    new Notification(title, { body, icon: '/icon.png' });
  }
  // Telegram + in-app via API (reuse terminal-bell endpoint, marked as workspace source)
  fetch('/api/terminal-bell', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tabLabel: `${label} (${status})`, source: 'workspace' }),
  }).catch(() => {});
}

// ─── Terminal Dock (right side panel with tabs) ──────────
type TerminalEntry = { agentId: string; label: string; icon: string; cliId: string; cliCmd?: string; cliType?: string; workDir?: string; tmuxSession?: string; sessionName: string; resumeMode?: boolean; resumeSessionId?: string; profileEnv?: Record<string, string> };

function TerminalDock({ terminals, projectPath, workspaceId, onSessionReady, onClose }: {
  terminals: TerminalEntry[];
  projectPath: string;
  workspaceId: string | null;
  onSessionReady: (agentId: string, name: string) => void;
  onClose: (agentId: string) => void;
}) {
  const [activeTab, setActiveTab] = useState(terminals[0]?.agentId || '');
  const [width, setWidth] = useState(520);
  const dragRef = useRef<{ startX: number; origW: number } | null>(null);

  // Auto-select new tab when added
  useEffect(() => {
    if (terminals.length > 0 && !terminals.find(t => t.agentId === activeTab)) {
      setActiveTab(terminals[terminals.length - 1].agentId);
    }
  }, [terminals, activeTab]);

  const active = terminals.find(t => t.agentId === activeTab);

  return (
    <div className="flex shrink-0" style={{ width }}>
      {/* Resize handle */}
      <div
        className="w-1 cursor-col-resize hover:bg-[#58a6ff]/30 active:bg-[#58a6ff]/50 transition-colors"
        style={{ background: '#21262d' }}
        onMouseDown={(e) => {
          e.preventDefault();
          dragRef.current = { startX: e.clientX, origW: width };
          const onMove = (ev: MouseEvent) => {
            if (!dragRef.current) return;
            const newW = dragRef.current.origW - (ev.clientX - dragRef.current.startX);
            setWidth(Math.max(300, Math.min(1200, newW)));
          };
          const onUp = () => { dragRef.current = null; window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
          window.addEventListener('mousemove', onMove);
          window.addEventListener('mouseup', onUp);
        }}
      />
      <div className="flex-1 flex flex-col min-w-0 bg-[#0d1117] border-l border-[#30363d]">
        {/* Tabs */}
        <div className="flex items-center bg-[#161b22] border-b border-[#30363d] overflow-x-auto shrink-0">
          {terminals.map(t => (
            <div
              key={t.agentId}
              onClick={() => setActiveTab(t.agentId)}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-[10px] border-r border-[#30363d] shrink-0 cursor-pointer ${
                t.agentId === activeTab
                  ? 'bg-[#0d1117] text-white border-b-2 border-b-[#58a6ff]'
                  : 'text-gray-500 hover:text-gray-300 hover:bg-[#1c2128]'
              }`}
            >
              <span>{t.icon}</span>
              <span className="font-medium">{t.label}</span>
              <span
                onClick={(e) => { e.stopPropagation(); onClose(t.agentId); }}
                className="ml-1 text-gray-600 hover:text-red-400 text-[8px] cursor-pointer"
              >✕</span>
            </div>
          ))}
        </div>
        {/* Active terminal */}
        {active && (
          <div className="flex-1 min-h-0" key={active.agentId}>
            <FloatingTerminalInline
              agentLabel={active.label}
              agentIcon={active.icon}
              projectPath={projectPath}
              agentCliId={active.cliId}
              cliCmd={active.cliCmd}
              cliType={active.cliType}
              workDir={active.workDir}
              preferredSessionName={active.sessionName}
              existingSession={active.tmuxSession}
              resumeMode={active.resumeMode}
              resumeSessionId={active.resumeSessionId}
              profileEnv={active.profileEnv}
              onSessionReady={(name) => onSessionReady(active.agentId, name)}
            />
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Inline Terminal (no drag/resize, fills parent) ──────
function FloatingTerminalInline({ agentLabel, agentIcon, projectPath, agentCliId, cliCmd: cliCmdProp, cliType, workDir, preferredSessionName, existingSession, resumeMode, resumeSessionId, profileEnv, isPrimary, skipPermissions, boundSessionId, onSessionReady }: {
  agentLabel: string;
  agentIcon: string;
  projectPath: string;
  agentCliId: string;
  cliCmd?: string;
  cliType?: string;
  workDir?: string;
  preferredSessionName?: string;
  existingSession?: string;
  resumeMode?: boolean;
  resumeSessionId?: string;
  profileEnv?: Record<string, string>;
  isPrimary?: boolean;
  skipPermissions?: boolean;
  boundSessionId?: string;
  onSessionReady?: (name: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let disposed = false;

    Promise.all([
      import('@xterm/xterm'),
      import('@xterm/addon-fit'),
    ]).then(([{ Terminal }, { FitAddon }]) => {
      if (disposed) return;

      const term = new Terminal({
        cursorBlink: true, fontSize: 13,
        fontFamily: 'Menlo, Monaco, "Courier New", monospace',
        scrollback: 5000,
        theme: { background: '#0d1117', foreground: '#c9d1d9', cursor: '#58a6ff' },
      });
      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.open(el);
      setTimeout(() => { try { fitAddon.fit(); } catch {} }, 100);

      const ro = new ResizeObserver(() => { try { fitAddon.fit(); } catch {} });
      ro.observe(el);

      // Connect to terminal server
      const wsUrl = getWsUrl();
      const ws = new WebSocket(wsUrl);
      ws.binaryType = 'arraybuffer';
      const decoder = new TextDecoder();

      ws.onopen = () => {
        ws.send(JSON.stringify({
          type: 'create',
          cols: term.cols, rows: term.rows,
          sessionName: existingSession || preferredSessionName,
          existingSession: existingSession || undefined,
        }));
      };
      ws.onmessage = async (event) => {
        try {
          const msg = JSON.parse(typeof event.data === 'string' ? event.data : decoder.decode(event.data));
          if (msg.type === 'data') {
            term.write(typeof msg.data === 'string' ? msg.data : new Uint8Array(Object.values(msg.data)));
          } else if (msg.type === 'created') {
            onSessionReady?.(msg.sessionName);
            // Auto-run CLI on newly created session
            if (!existingSession) {
              const cli = cliCmdProp || 'claude';
              const targetDir = workDir ? `${projectPath}/${workDir}` : projectPath;
              const cdCmd = `mkdir -p "${targetDir}" && cd "${targetDir}"`;
              const isClaude = (cliType || 'claude-code') === 'claude-code';
              const modelFlag = isClaude && profileEnv?.CLAUDE_MODEL ? ` --model ${profileEnv.CLAUDE_MODEL}` : '';
              const envWithoutModel = profileEnv ? Object.fromEntries(
                Object.entries(profileEnv).filter(([k]) => k !== 'CLAUDE_MODEL')
              ) : {};
              // Build commands as separate short lines
              const commands: string[] = [];
              const profileVarsToReset = ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_SMALL_FAST_MODEL', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', 'DISABLE_TELEMETRY', 'DISABLE_ERROR_REPORTING', 'DISABLE_AUTOUPDATER', 'DISABLE_NON_ESSENTIAL_MODEL_CALLS', 'CLAUDE_MODEL'];
              commands.push(profileVarsToReset.map(v => `unset ${v}`).join('; '));
              const envWithoutForge = Object.entries(envWithoutModel).filter(([k]) => !k.startsWith('FORGE_'));
              if (envWithoutForge.length > 0) {
                commands.push(envWithoutForge.map(([k, v]) => `export ${k}="${v}"`).join('; '));
              }
              const forgeVars = Object.entries(envWithoutModel).filter(([k]) => k.startsWith('FORGE_'));
              if (forgeVars.length > 0) {
                commands.push(forgeVars.map(([k, v]) => `export ${k}="${v}"`).join('; '));
              }
              let resumeId = resumeSessionId || boundSessionId;
              if (isClaude && !resumeId && isPrimary) {
                try {
                  const { resolveFixedSession } = await import('@/lib/session-utils');
                  resumeId = (await resolveFixedSession(projectPath)) || undefined;
                } catch {}
              }
              const resumeFlag = isClaude && resumeId ? ` --resume ${resumeId}` : '';
              let mcpFlag = '';
              if (isClaude) { try { const { getMcpFlag } = await import('@/lib/session-utils'); mcpFlag = await getMcpFlag(projectPath); } catch {} }
              const sf = skipPermissions ? (cliType === 'codex' ? ' --full-auto' : cliType === 'aider' ? ' --yes' : ' --dangerously-skip-permissions') : '';
              commands.push(`${cdCmd} && ${cli}${resumeFlag}${modelFlag}${sf}${mcpFlag}`);
              commands.forEach((cmd, i) => {
                setTimeout(() => {
                  if (!disposed && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input', data: cmd + '\n' }));
                }, 300 + i * 300);
              });
            }
          }
        } catch {}
      };

      term.onData(data => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input', data })); });
      term.onResize(({ cols, rows }) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resize', cols, rows })); });

      return () => {
        disposed = true;
        ro.disconnect();
        ws.close();
        term.dispose();
      };
    });

    return () => { disposed = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return <div ref={containerRef} className="w-full h-full" style={{ background: '#0d1117' }} />;
}

function FloatingTerminal({ agentLabel, agentIcon, projectPath, agentCliId, cliCmd: cliCmdProp, cliType, workDir, preferredSessionName, existingSession, resumeMode, resumeSessionId, profileEnv, isPrimary, skipPermissions, persistentSession, boundSessionId, initialPos, docked, onSessionReady, onClose }: {
  agentLabel: string;
  agentIcon: string;
  projectPath: string;
  agentCliId: string;
  cliCmd?: string;               // resolved CLI binary (claude/codex/aider)
  cliType?: string;              // claude-code/codex/aider/generic
  workDir?: string;
  preferredSessionName?: string;
  existingSession?: string;
  resumeMode?: boolean;
  resumeSessionId?: string;
  profileEnv?: Record<string, string>;
  isPrimary?: boolean;
  skipPermissions?: boolean;
  persistentSession?: boolean;
  boundSessionId?: string;
  initialPos?: { x: number; y: number };
  docked?: boolean;  // when true, render as grid cell instead of fixed floating window
  onSessionReady?: (name: string) => void;
  onClose: (killSession: boolean) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const sessionNameRef = useRef('');
  const [pos, setPos] = useState(initialPos || { x: 80, y: 60 });
  const [userDragged, setUserDragged] = useState(false);
  // Follow node position unless user manually dragged the terminal
  useEffect(() => {
    if (initialPos && !userDragged) setPos(initialPos);
  }, [initialPos?.x, initialPos?.y]); // eslint-disable-line react-hooks/exhaustive-deps
  const [size, setSize] = useState({ w: 500, h: 300 });
  const [showCloseDialog, setShowCloseDialog] = useState(false);
  const [mouseOn, setMouseOn] = useState(true);
  // Per-terminal "lock" — when locked, × button suspends directly (no kill option)
  // Persisted by session name so it survives refresh
  const lockKey = `forge.term.locked.${preferredSessionName || agentLabel}`;
  const [locked, setLocked] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    // Default LOCKED — user must explicitly unlock to allow kill
    const stored = localStorage.getItem(lockKey);
    return stored === null ? true : stored === '1';
  });
  const toggleLock = () => {
    const next = !locked;
    setLocked(next);
    try { localStorage.setItem(lockKey, next ? '1' : '0'); } catch {}
  };
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);
  const resizeRef = useRef<{ startX: number; startY: number; origW: number; origH: number } | null>(null);

  const toggleMouse = () => {
    const next = !mouseOn;
    setMouseOn(next);
    // Send via current WebSocket (shared for all workspace terminals)
    try {
      const ws = new WebSocket(getWsUrl());
      ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'tmux-mouse', mouse: next }));
        setTimeout(() => ws.close(), 300);
      };
      ws.onerror = () => ws.close();
    } catch {}
  };

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let disposed = false;

    // Dynamic import xterm to avoid SSR issues
    Promise.all([
      import('@xterm/xterm'),
      import('@xterm/addon-fit'),
    ]).then(([{ Terminal }, { FitAddon }]) => {
      if (disposed) return;

      const term = new Terminal({
        cursorBlink: true, fontSize: 10,
        fontFamily: 'Menlo, Monaco, "Courier New", monospace',
        scrollback: 5000,
        theme: { background: '#0d1117', foreground: '#c9d1d9', cursor: '#58a6ff' },
      });
      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.open(el);
      setTimeout(() => { try { fitAddon.fit(); } catch {} }, 100);

      // Scale font: min 10 at small size, max 13 at large size
      const ro = new ResizeObserver(() => {
        try {
          const w = el.clientWidth;
          const newSize = Math.min(13, Math.max(10, Math.floor(w / 60)));
          if (term.options.fontSize !== newSize) term.options.fontSize = newSize;
          fitAddon.fit();
        } catch {}
      });
      ro.observe(el);

      // Connect WebSocket — attach to existing or create new
      const ws = new WebSocket(getWsUrl());
      wsRef.current = ws;
      ws.onopen = () => {
        if (existingSession) {
          ws.send(JSON.stringify({ type: 'attach', sessionName: existingSession, cols: term.cols, rows: term.rows }));
        } else {
          // Use fixed session name so it survives refresh/suspend
          ws.send(JSON.stringify({ type: 'create', sessionName: preferredSessionName, cols: term.cols, rows: term.rows }));
        }
      };

      let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
      const reconnect = () => {
        if (disposed || reconnectTimer) return;
        term.write('\r\n\x1b[93m[Reconnecting...]\x1b[0m\r\n');
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          if (disposed) return;
          const newWs = new WebSocket(getWsUrl());
          wsRef.current = newWs;
          const sn = sessionNameRef.current || preferredSessionName;
          newWs.onopen = () => {
            newWs.send(JSON.stringify({ type: 'attach', sessionName: sn, cols: term.cols, rows: term.rows }));
          };
          newWs.onerror = () => { if (!disposed) reconnect(); };
          newWs.onclose = () => { if (!disposed) reconnect(); };
          newWs.onmessage = ws.onmessage;
        }, 2000);
      };

      ws.onerror = () => {
        if (!disposed) {
          term.write('\r\n\x1b[91m[Connection error]\x1b[0m\r\n');
          reconnect();
        }
      };
      ws.onclose = () => {
        if (!disposed) {
          term.write('\r\n\x1b[90m[Disconnected]\x1b[0m\r\n');
          reconnect();
        }
      };

      let launched = false;
      ws.onmessage = async (event) => {
        if (disposed) return;
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'output') { try { term.write(msg.data); } catch {} }
          else if (msg.type === 'error') {
            // Session no longer exists — fall back to creating a new one
            if (msg.message?.includes('no longer exists') || msg.message?.includes('not found')) {
              term.write(`\r\n\x1b[93m[Session lost — creating new one]\x1b[0m\r\n`);
              ws.send(JSON.stringify({ type: 'create', cols: term.cols, rows: term.rows }));
              // Clear existing session so next connected triggers CLI launch
              (existingSession as any) = undefined;
            } else {
              term.write(`\r\n\x1b[91m[${msg.message || 'error'}]\x1b[0m\r\n`);
            }
          }
          else if (msg.type === 'connected') {
            if (msg.sessionName) {
              sessionNameRef.current = msg.sessionName;
              // Save session name (on create or if session changed after fallback)
              onSessionReady?.(msg.sessionName);
            }
            if (launched) return;
            launched = true;
            if (existingSession) {
              // Force terminal redraw for attached session
              setTimeout(() => {
                if (!disposed && ws.readyState === WebSocket.OPEN) {
                  ws.send(JSON.stringify({ type: 'resize', cols: term.cols - 1, rows: term.rows }));
                  setTimeout(() => {
                    if (!disposed && ws.readyState === WebSocket.OPEN)
                      ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
                  }, 50);
                }
              }, 200);
              return;
            }
            const targetDir = workDir ? `${projectPath}/${workDir}` : projectPath;
            const cli = cliCmdProp || 'claude';

            const cdCmd = `mkdir -p "${targetDir}" && cd "${targetDir}"`;
            const isClaude = (cliType || 'claude-code') === 'claude-code';
            const modelFlag = isClaude && profileEnv?.CLAUDE_MODEL ? ` --model ${profileEnv.CLAUDE_MODEL}` : '';
            const envWithoutModel = profileEnv ? Object.fromEntries(
              Object.entries(profileEnv).filter(([k]) => k !== 'CLAUDE_MODEL')
            ) : {};
            // Build commands as separate short lines to avoid terminal truncation
            const commands: string[] = [];

            // 1. Unset old profile vars
            const profileVarsToReset = ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_SMALL_FAST_MODEL', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', 'DISABLE_TELEMETRY', 'DISABLE_ERROR_REPORTING', 'DISABLE_AUTOUPDATER', 'DISABLE_NON_ESSENTIAL_MODEL_CALLS', 'CLAUDE_MODEL'];
            commands.push(profileVarsToReset.map(v => `unset ${v}`).join('; '));

            // 2. Export new profile vars (if any)
            const envWithoutForge = Object.entries(envWithoutModel).filter(([k]) => !k.startsWith('FORGE_'));
            if (envWithoutForge.length > 0) {
              commands.push(envWithoutForge.map(([k, v]) => `export ${k}="${v}"`).join('; '));
            }

            // 3. Export FORGE vars
            const forgeVars = Object.entries(envWithoutModel).filter(([k]) => k.startsWith('FORGE_'));
            if (forgeVars.length > 0) {
              commands.push(forgeVars.map(([k, v]) => `export ${k}="${v}"`).join('; '));
            }

            // 4. CLI command
            let resumeId = resumeSessionId || boundSessionId;
            if (isClaude && !resumeId && isPrimary) {
              try {
                const { resolveFixedSession } = await import('@/lib/session-utils');
                resumeId = (await resolveFixedSession(projectPath)) || undefined;
              } catch {}
            }
            const resumeFlag = isClaude && resumeId ? ` --resume ${resumeId}` : '';
            let mcpFlag = '';
            if (isClaude) { try { const { getMcpFlag } = await import('@/lib/session-utils'); mcpFlag = await getMcpFlag(projectPath); } catch {} }
            const sf = skipPermissions ? (cliType === 'codex' ? ' --full-auto' : cliType === 'aider' ? ' --yes' : ' --dangerously-skip-permissions') : '';
            commands.push(`${cdCmd} && ${cli}${resumeFlag}${modelFlag}${sf}${mcpFlag}`);

            // Send each command with delay between them
            commands.forEach((cmd, i) => {
              setTimeout(() => {
                if (!disposed && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input', data: cmd + '\n' }));
              }, 300 + i * 300);
            });
          }
        } catch {}
      };

      term.onData(data => {
        const activeWs = wsRef.current;
        if (activeWs?.readyState === WebSocket.OPEN) activeWs.send(JSON.stringify({ type: 'input', data }));
      });
      term.onResize(({ cols, rows }) => {
        const activeWs = wsRef.current;
        if (activeWs?.readyState === WebSocket.OPEN) activeWs.send(JSON.stringify({ type: 'resize', cols, rows }));
      });

      return () => {
        disposed = true;
        if (reconnectTimer) clearTimeout(reconnectTimer);
        ro.disconnect();
        (wsRef.current || ws).close();
        term.dispose();
      };
    });

    return () => { disposed = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div
      className={docked
        ? "relative bg-[#0d1117] border border-[#30363d] rounded-lg flex flex-col overflow-hidden w-full h-full"
        : "fixed z-50 bg-[#0d1117] border border-[#30363d] rounded-lg shadow-2xl flex flex-col overflow-hidden"
      }
      style={docked ? undefined : { left: pos.x, top: pos.y, width: size.w, height: size.h }}
    >
      {/* Header — draggable in floating mode, static in docked mode */}
      <div
        className={`flex items-center gap-2 px-3 py-1.5 bg-[#161b22] border-b border-[#30363d] shrink-0 select-none ${docked ? '' : 'cursor-move'}`}
        onMouseDown={docked ? undefined : (e) => {
          e.preventDefault();
          dragRef.current = { startX: e.clientX, startY: e.clientY, origX: pos.x, origY: pos.y };
          setUserDragged(true);
          const onMove = (ev: MouseEvent) => {
            if (!dragRef.current) return;
            setPos({ x: Math.max(0, dragRef.current.origX + ev.clientX - dragRef.current.startX), y: Math.max(0, dragRef.current.origY + ev.clientY - dragRef.current.startY) });
          };
          const onUp = () => { dragRef.current = null; window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
          window.addEventListener('mousemove', onMove);
          window.addEventListener('mouseup', onUp);
        }}
      >
        <span className="text-sm">{agentIcon}</span>
        <span className="text-[11px] font-semibold text-white truncate">{agentLabel}</span>
        {!docked && <span className="text-[8px] text-gray-500">⌨️ manual terminal</span>}
        <button
          onClick={(e) => { e.stopPropagation(); toggleMouse(); }}
          onMouseDown={(e) => e.stopPropagation()}
          className={`ml-auto text-[9px] px-1.5 py-0.5 rounded border transition-colors ${mouseOn ? 'border-green-600/40 text-green-400 bg-green-500/10' : 'border-gray-600 text-gray-500 bg-gray-800/50'}`}
          title={mouseOn ? 'Mouse ON (trackpad scroll, Shift+drag to select text)' : 'Mouse OFF (drag to select text, Ctrl+B [ to scroll)'}
        >
          🖱️ {mouseOn ? 'ON' : 'OFF'}
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); toggleLock(); }}
          onMouseDown={(e) => e.stopPropagation()}
          className={`text-[9px] px-1.5 py-0.5 rounded border transition-colors ${locked ? 'border-yellow-500/60 text-yellow-400 bg-yellow-500/10' : 'border-gray-600 text-gray-500 bg-gray-800/50'}`}
          title={locked ? 'Locked — × will only suspend (kill disabled). Click to unlock.' : 'Click to lock — prevents accidental kill, × always suspends'}
        >
          {locked ? '🔒' : '🔓'}
        </button>
        <button
          onClick={() => setShowCloseDialog(true)}
          className="text-gray-500 hover:text-white text-sm shrink-0"
          title="Close terminal"
        >✕</button>
      </div>

      {/* Terminal */}
      <div ref={containerRef} className="flex-1 min-h-0" style={{ background: '#0d1117' }} />

      {/* Resize handle — floating mode only */}
      {!docked && (
        <div
          className="absolute bottom-0 right-0 w-4 h-4 cursor-se-resize"
          onMouseDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
            resizeRef.current = { startX: e.clientX, startY: e.clientY, origW: size.w, origH: size.h };
            const onMove = (ev: MouseEvent) => {
              if (!resizeRef.current) return;
              setSize({ w: Math.max(400, resizeRef.current.origW + ev.clientX - resizeRef.current.startX), h: Math.max(250, resizeRef.current.origH + ev.clientY - resizeRef.current.startY) });
            };
            const onUp = () => { resizeRef.current = null; window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
            window.addEventListener('mousemove', onMove);
            window.addEventListener('mouseup', onUp);
          }}
        >
          <svg viewBox="0 0 16 16" className="w-3 h-3 absolute bottom-0.5 right-0.5 text-gray-600">
            <path d="M14 14L8 14L14 8Z" fill="currentColor" />
          </svg>
        </div>
      )}

      {/* Close confirmation dialog */}
      {showCloseDialog && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50" onClick={() => setShowCloseDialog(false)}>
          <div className="bg-[#161b22] border border-[#30363d] rounded-lg p-4 shadow-xl max-w-sm" onClick={e => e.stopPropagation()}>
            <h3 className="text-sm font-semibold text-white mb-2">
              Close Terminal — {agentLabel}
              {locked && <span className="ml-2 text-[9px] text-yellow-400">🔒 Locked</span>}
            </h3>
            <p className="text-xs text-gray-400 mb-3">
              {locked
                ? 'Terminal is locked — kill is disabled. Click 🔒 in the header to unlock first.'
                : 'This agent has an active terminal session.'}
            </p>
            <div className="flex gap-2">
              <button onClick={() => { setShowCloseDialog(false); onClose(false); }}
                className="flex-1 px-3 py-1.5 text-[11px] rounded bg-[#2a2a4a] text-gray-300 hover:bg-[#3a3a5a] hover:text-white">
                Suspend
                <span className="block text-[9px] text-gray-500 mt-0.5">Hide panel, session keeps running</span>
              </button>
              <button
                disabled={locked}
                onClick={() => {
                  if (locked) return;
                  setShowCloseDialog(false);
                  if (wsRef.current?.readyState === WebSocket.OPEN && sessionNameRef.current) {
                    wsRef.current.send(JSON.stringify({ type: 'kill', sessionName: sessionNameRef.current }));
                  }
                  onClose(true);
                }}
                className={`flex-1 px-3 py-1.5 text-[11px] rounded ${locked ? 'bg-gray-700/30 text-gray-500 cursor-not-allowed' : persistentSession ? 'bg-yellow-500/20 text-yellow-400 hover:bg-yellow-500/30' : 'bg-red-500/20 text-red-400 hover:bg-red-500/30'}`}>
                {locked ? '🔒 Locked' : persistentSession ? 'Restart Session' : 'Kill Session'}
                <span className={`block text-[9px] mt-0.5 ${locked ? 'text-gray-500' : persistentSession ? 'text-yellow-400/60' : 'text-red-400/60'}`}>
                  {locked ? 'Unlock first to allow kill' : persistentSession ? 'Kill and restart with fresh env' : 'End session permanently'}
                </span>
              </button>
            </div>
            <button onClick={() => setShowCloseDialog(false)}
              className="w-full mt-2 px-3 py-1 text-[10px] text-gray-500 hover:text-gray-300">
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── ReactFlow Input Node ────────────────────────────────

interface InputNodeData {
  config: AgentConfig;
  state: AgentState;
  onSubmit: (content: string) => void;
  onEdit: () => void;
  onRemove: () => void;
  [key: string]: unknown;
}

function InputFlowNode({ data }: NodeProps<Node<InputNodeData>>) {
  const { config, state, onSubmit, onEdit, onRemove } = data;
  const isDone = state?.taskStatus === 'done';
  const [text, setText] = useState('');
  const entries = config.entries || [];

  return (
    <div className="w-60 flex flex-col rounded-lg select-none"
      style={{ border: `1px solid ${isDone ? '#58a6ff60' : '#30363d50'}`, background: '#0d1117',
        boxShadow: isDone ? '0 0 10px #58a6ff15' : 'none' }}>
      <Handle type="source" position={Position.Right} style={{ background: '#58a6ff', width: 8, height: 8, border: 'none' }} />

      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2" style={{ borderBottom: '1px solid #21262d' }}>
        <span className="text-sm">{config.icon || '📝'}</span>
        <span className="text-xs font-semibold text-white flex-1">{config.label || 'Input'}</span>
        {entries.length > 0 && <span className="text-[8px] text-gray-600">{entries.length}</span>}
        <div className="w-2 h-2 rounded-full" style={{ background: isDone ? '#58a6ff' : '#484f58', boxShadow: isDone ? '0 0 6px #58a6ff' : 'none' }} />
      </div>

      {/* History entries (scrollable, compact) */}
      {entries.length > 0 && (
        <div className="max-h-24 overflow-auto px-3 py-1.5 space-y-1" style={{ borderBottom: '1px solid #21262d' }}
          onPointerDown={e => e.stopPropagation()}>
          {entries.map((e, i) => (
            <div key={i} className={`text-[9px] leading-relaxed ${i === entries.length - 1 ? 'text-gray-300' : 'text-gray-600'}`}>
              <span className="text-[7px] text-gray-700 mr-1">#{i + 1}</span>
              {e.content.length > 80 ? e.content.slice(0, 80) + '…' : e.content}
            </div>
          ))}
        </div>
      )}

      {/* New input */}
      <div className="px-3 py-2">
        <textarea value={text} onChange={e => setText(e.target.value)} rows={2}
          placeholder={entries.length > 0 ? 'Add new requirement or change...' : 'Describe requirements...'}
          className="w-full text-[10px] bg-[#0d1117] border border-[#21262d] rounded px-2 py-1.5 text-gray-300 placeholder-gray-600 focus:outline-none focus:border-[#58a6ff]/50 resize-none"
          onPointerDown={e => e.stopPropagation()} />
      </div>

      {/* Actions */}
      <div className="flex items-center gap-1 px-2 py-1.5" style={{ borderTop: '1px solid #21262d' }}>
        <button onPointerDown={e => e.stopPropagation()} onClick={e => {
          e.stopPropagation();
          if (!text.trim()) return;
          onSubmit(text.trim());
          setText('');
        }}
          className="text-[9px] px-2 py-0.5 rounded bg-[#238636]/20 text-[#3fb950] hover:bg-[#238636]/30 disabled:opacity-30"
          disabled={!text.trim()}>
          {entries.length > 0 ? '+ Add' : '✓ Submit'}
        </button>
        <div className="flex-1" />
        <button onPointerDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); onRemove(); }}
          className="text-[9px] text-gray-700 hover:text-red-400 px-1">✕</button>
      </div>
    </div>
  );
}

// ─── ReactFlow Agent Node ────────────────────────────────

interface AgentNodeData {
  config: AgentConfig;
  state: AgentState;
  colorIdx: number;
  previewLines: string[];
  projectPath: string;
  workspaceId: string | null;
  onRun: () => void;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
  onRetry: () => void;
  onEdit: () => void;
  onRemove: () => void;
  onMessage: () => void;
  onApprove: () => void;
  onShowLog: () => void;
  onShowMemory: () => void;
  onShowInbox: () => void;
  onOpenTerminal: () => void;
  onSwitchSession: () => void;
  onSaveAsTemplate: () => void;
  mascotTheme: MascotTheme;
  bellOn?: boolean;
  onToggleBell?: () => void;
  onMarkIdle?: () => void;
  onMarkDone?: (notify: boolean) => void;
  onMarkFailed?: (notify: boolean) => void;
  inboxPending?: number;
  inboxFailed?: number;
  [key: string]: unknown;
}

// PortalTerminal/NodeTerminal removed — xterm cannot render inside React Flow nodes
// and createPortal causes event routing issues. Using FloatingTerminal instead.

// ─── Worker Mascot — SVG stick figure with pose-based animations ──────────────
const MASCOT_STYLES = `
@keyframes mascot-sleep {
  0%, 100% { transform: translateY(0) rotate(-3deg); opacity: 0.6; }
  50% { transform: translateY(-2px) rotate(3deg); opacity: 0.9; }
}
@keyframes mascot-work {
  0%, 100% { transform: translateY(0) rotate(0deg); }
  25% { transform: translateY(-2px) rotate(-6deg); }
  50% { transform: translateY(0) rotate(0deg); }
  75% { transform: translateY(-2px) rotate(6deg); }
}
@keyframes mascot-celebrate {
  0% { transform: translateY(0) scale(1); }
  12% { transform: translateY(-6px) scale(1.15) rotate(-10deg); }
  25% { transform: translateY(-3px) scale(1.1) rotate(0deg); }
  37% { transform: translateY(-6px) scale(1.15) rotate(10deg); }
  50% { transform: translateY(0) scale(1) rotate(0deg); }
  100% { transform: translateY(0) scale(1) rotate(0deg); }
}
@keyframes mascot-fall {
  0% { transform: translateY(0) rotate(0deg); }
  30% { transform: translateY(2px) rotate(-15deg); }
  60% { transform: translateY(4px) rotate(-90deg); }
  100% { transform: translateY(4px) rotate(-90deg); opacity: 0.6; }
}
@keyframes mascot-idle {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-1px); }
}
@keyframes mascot-blink { 0%, 95%, 100% { opacity: 1; } 97% { opacity: 0.3; } }
@keyframes stick-arm-hammer {
  0%, 100% { transform: rotate(-40deg); }
  50% { transform: rotate(20deg); }
}
@keyframes stick-arm-wave {
  0%, 100% { transform: rotate(-120deg); }
  50% { transform: rotate(-150deg); }
}
@keyframes stick-leg-walk-l {
  0%, 100% { transform: rotate(-10deg); }
  50% { transform: rotate(10deg); }
}
@keyframes stick-leg-walk-r {
  0%, 100% { transform: rotate(10deg); }
  50% { transform: rotate(-10deg); }
}
@keyframes stick-zzz {
  0% { opacity: 0; transform: translate(0, 0) scale(0.5); }
  50% { opacity: 1; transform: translate(4px, -6px) scale(1); }
  100% { opacity: 0; transform: translate(8px, -12px) scale(1.2); }
}
@keyframes stick-spark {
  0%, 100% { opacity: 0; }
  50% { opacity: 1; }
}
@keyframes stick-spark-burst {
  0% { opacity: 0; transform: scale(0.5); }
  30% { opacity: 1; transform: scale(1.2); }
  70% { opacity: 1; transform: scale(1); }
  100% { opacity: 0; transform: scale(0.8); }
}
`;
type MascotPose = 'idle' | 'work' | 'done' | 'fail' | 'sleep' | 'wake';
export type MascotTheme = 'off' | 'stick' | 'cat' | 'pixel' | 'emoji';

function StickCat({ pose, color, accentColor }: { pose: MascotPose; color: string; accentColor: string }) {
  const strokeProps = { stroke: color, strokeWidth: 1.5, strokeLinecap: 'round' as const, fill: 'none' };
  const body = (tailAnim: string) => (
    <>
      {/* head */}
      <circle cx="10" cy="18" r="5" stroke={color} strokeWidth="1.5" fill="none" />
      {/* ears */}
      <path d="M 6 15 L 7 11 L 10 14 Z" fill={color} />
      <path d="M 14 15 L 13 11 L 10 14 Z" fill={color} />
      {/* eyes */}
      <circle cx="8" cy="18" r="0.8" fill={accentColor} />
      <circle cx="12" cy="18" r="0.8" fill={accentColor} />
      {/* nose */}
      <path d="M 9.5 19.5 L 10 20 L 10.5 19.5" stroke={accentColor} strokeWidth="0.8" fill="none" strokeLinecap="round" />
      {/* whiskers */}
      <line x1="5" y1="19" x2="2" y2="18" stroke={color} strokeWidth="0.6" />
      <line x1="5" y1="20" x2="2" y2="20" stroke={color} strokeWidth="0.6" />
      <line x1="15" y1="19" x2="18" y2="18" stroke={color} strokeWidth="0.6" />
      <line x1="15" y1="20" x2="18" y2="20" stroke={color} strokeWidth="0.6" />
      {/* body — oval */}
      <ellipse cx="18" cy="26" rx="8" ry="5" stroke={color} strokeWidth="1.5" fill="none" />
      {/* tail */}
      <g style={{ transformOrigin: '26px 26px', animation: tailAnim }}>
        <path d="M 26 26 Q 30 22 28 18" {...strokeProps} />
      </g>
      {/* legs */}
      <line x1="13" y1="30" x2="13" y2="36" {...strokeProps} />
      <line x1="23" y1="30" x2="23" y2="36" {...strokeProps} />
      <line x1="16" y1="31" x2="16" y2="36" {...strokeProps} />
      <line x1="20" y1="31" x2="20" y2="36" {...strokeProps} />
    </>
  );

  if (pose === 'sleep') {
    return (
      <svg width="32" height="40" viewBox="0 0 32 40">
        {/* curled up cat — circle with tail */}
        <circle cx="16" cy="30" r="8" stroke={color} strokeWidth="1.5" fill="none" />
        <circle cx="10" cy="28" r="3" stroke={color} strokeWidth="1.5" fill="none" />
        <line x1="9" y1="27" x2="9" y2="29" stroke={color} strokeWidth="0.8" />
        <line x1="11" y1="27" x2="11" y2="29" stroke={color} strokeWidth="0.8" />
        <path d="M 23 32 Q 28 32 26 26" {...strokeProps} />
        {/* zzz */}
        <text x="20" y="20" fill={accentColor} fontSize="6" fontWeight="bold" style={{ animation: 'stick-zzz 2s ease-out infinite' }}>z</text>
        <text x="24" y="14" fill={accentColor} fontSize="4" fontWeight="bold" style={{ animation: 'stick-zzz 2s ease-out infinite 0.7s' }}>z</text>
      </svg>
    );
  }

  if (pose === 'fail') {
    return (
      <svg width="32" height="40" viewBox="0 0 32 40">
        {/* belly up */}
        <ellipse cx="18" cy="26" rx="8" ry="5" stroke={color} strokeWidth="1.5" fill="none" />
        <circle cx="10" cy="24" r="4" stroke={color} strokeWidth="1.5" fill="none" />
        <line x1="8" y1="23" x2="9" y2="24" stroke={accentColor} strokeWidth="0.8" />
        <line x1="9" y1="23" x2="8" y2="24" stroke={accentColor} strokeWidth="0.8" />
        <line x1="11" y1="23" x2="12" y2="24" stroke={accentColor} strokeWidth="0.8" />
        <line x1="12" y1="23" x2="11" y2="24" stroke={accentColor} strokeWidth="0.8" />
        {/* legs up */}
        <line x1="14" y1="22" x2="14" y2="16" {...strokeProps} />
        <line x1="18" y1="22" x2="18" y2="15" {...strokeProps} />
        <line x1="22" y1="22" x2="22" y2="16" {...strokeProps} />
      </svg>
    );
  }

  if (pose === 'done') {
    return (
      <svg width="32" height="40" viewBox="0 0 32 40">
        {/* jumping — body elevated */}
        <g style={{ transform: 'translateY(-2px)' }}>
          {body('none')}
        </g>
        <text x="2" y="8" fill="#ffd700" fontSize="6" style={{ animation: 'stick-spark-burst 1.2s ease-out forwards' }}>✦</text>
        <text x="26" y="10" fill="#ffd700" fontSize="8" style={{ animation: 'stick-spark-burst 1.2s ease-out forwards 0.3s' }}>✦</text>
      </svg>
    );
  }

  if (pose === 'work') {
    return (
      <svg width="32" height="40" viewBox="0 0 32 40">
        {body('stick-arm-hammer 0.4s ease-in-out infinite')}
      </svg>
    );
  }

  if (pose === 'wake') {
    return (
      <svg width="32" height="40" viewBox="0 0 32 40">
        {/* stretching — elongated body */}
        <circle cx="8" cy="22" r="4" stroke={color} strokeWidth="1.5" fill="none" />
        <path d="M 4 19 L 5 16 L 8 18 Z" fill={color} />
        <path d="M 12 19 L 11 16 L 8 18 Z" fill={color} />
        <circle cx="6.5" cy="22" r="0.6" fill={accentColor} />
        <circle cx="9.5" cy="22" r="0.6" fill={accentColor} />
        <ellipse cx="20" cy="28" rx="10" ry="4" stroke={color} strokeWidth="1.5" fill="none" />
        <line x1="14" y1="32" x2="14" y2="38" {...strokeProps} />
        <line x1="26" y1="32" x2="26" y2="38" {...strokeProps} />
        <path d="M 30 28 Q 32 24 30 20" {...strokeProps} />
      </svg>
    );
  }

  // idle — tail swaying
  return (
    <svg width="32" height="40" viewBox="0 0 32 40">
      {body('stick-arm-wave 2s ease-in-out infinite')}
    </svg>
  );
}


function PixelPerson({ pose, color, accentColor }: { pose: MascotPose; color: string; accentColor: string }) {
  // Retro 8-bit pixel character (RPG hero style)
  const skin = '#f4c69d';
  const hair = color;
  const shirt = accentColor;
  const pants = '#3b5998';
  const shoes = '#1a1a1a';
  const eye = '#000';

  // Standing character 32x40, pixel 2
  const body = (armAnim?: string, legAnim?: string) => (
    <g shapeRendering="crispEdges">
      {/* hair top */}
      <rect x="10" y="6" width="12" height="2" fill={hair} />
      <rect x="8" y="8" width="16" height="2" fill={hair} />
      {/* head */}
      <rect x="10" y="10" width="12" height="6" fill={skin} />
      {/* hair sides */}
      <rect x="8" y="10" width="2" height="4" fill={hair} />
      <rect x="22" y="10" width="2" height="4" fill={hair} />
      {/* eyes */}
      <rect x="12" y="12" width="2" height="2" fill={eye} />
      <rect x="18" y="12" width="2" height="2" fill={eye} />
      {/* mouth */}
      <rect x="14" y="15" width="4" height="1" fill={eye} />
      {/* neck */}
      <rect x="14" y="16" width="4" height="1" fill={skin} />
      {/* body/shirt */}
      <rect x="10" y="17" width="12" height="8" fill={shirt} />
      <rect x="12" y="19" width="8" height="1" fill="#fff" opacity="0.3" />
      {/* arms */}
      <g style={armAnim ? { animation: armAnim, transformOrigin: '16px 18px' } : {}}>
        <rect x="8" y="17" width="2" height="7" fill={shirt} />
        <rect x="22" y="17" width="2" height="7" fill={shirt} />
        <rect x="8" y="24" width="2" height="2" fill={skin} />
        <rect x="22" y="24" width="2" height="2" fill={skin} />
      </g>
      {/* pants */}
      <g style={legAnim ? { animation: legAnim, transformOrigin: '16px 28px' } : {}}>
        <rect x="11" y="25" width="4" height="8" fill={pants} />
        <rect x="17" y="25" width="4" height="8" fill={pants} />
        {/* shoes */}
        <rect x="10" y="33" width="5" height="2" fill={shoes} />
        <rect x="17" y="33" width="5" height="2" fill={shoes} />
      </g>
    </g>
  );

  if (pose === 'sleep') {
    return (
      <svg width="32" height="40" viewBox="0 0 32 40">
        <g shapeRendering="crispEdges">
          {/* lying down horizontally */}
          <rect x="4" y="22" width="4" height="4" fill={hair} />
          <rect x="8" y="22" width="6" height="4" fill={skin} />
          <rect x="10" y="24" width="1" height="1" fill={eye} />
          <rect x="14" y="22" width="12" height="4" fill={shirt} />
          <rect x="26" y="22" width="4" height="4" fill={pants} />
        </g>
        <text x="18" y="16" fill={accentColor} fontSize="6" fontWeight="bold" style={{ animation: 'stick-zzz 2s ease-out infinite' }}>z</text>
        <text x="22" y="10" fill={accentColor} fontSize="4" fontWeight="bold" style={{ animation: 'stick-zzz 2s ease-out infinite 0.7s' }}>z</text>
      </svg>
    );
  }

  if (pose === 'fail') {
    return (
      <svg width="32" height="40" viewBox="0 0 32 40">
        {/* knocked out — rotated */}
        <g transform="rotate(-80 16 28)">
          {body()}
        </g>
        <text x="18" y="14" fill={accentColor} fontSize="5">×_×</text>
      </svg>
    );
  }

  if (pose === 'done') {
    return (
      <svg width="32" height="40" viewBox="0 0 32 40">
        <g style={{ transform: 'translateY(-3px)' }}>
          {body('stick-arm-wave 0.3s ease-in-out infinite')}
        </g>
        <text x="2" y="8" fill="#ffd700" fontSize="6" style={{ animation: 'stick-spark-burst 1.2s ease-out forwards' }}>✦</text>
        <text x="26" y="10" fill="#ffd700" fontSize="8" style={{ animation: 'stick-spark-burst 1.2s ease-out forwards 0.3s' }}>✦</text>
      </svg>
    );
  }

  if (pose === 'work') {
    return (
      <svg width="32" height="40" viewBox="0 0 32 40">
        {body('stick-arm-hammer 0.4s ease-in-out infinite')}
      </svg>
    );
  }

  if (pose === 'wake') {
    return (
      <svg width="32" height="40" viewBox="0 0 32 40">
        {body('stick-arm-wave 1.8s ease-in-out infinite')}
      </svg>
    );
  }

  // idle
  return (
    <svg width="32" height="40" viewBox="0 0 32 40">
      {body('stick-arm-wave 2.2s ease-in-out infinite')}
    </svg>
  );
}


function EmojiMascot({ pose, seed }: { pose: MascotPose; seed: number }) {
  const characters = ['🦊', '🐱', '🐼', '🦉', '🐸', '🦝', '🐙', '🦖', '🐰', '🦄', '🐺', '🧙‍♂️', '🧝‍♀️', '🦸‍♂️', '🥷', '🐲'];
  const character = characters[seed % characters.length];
  let display = character;
  if (pose === 'sleep') display = ['😴', '💤', '🌙', '💤'][Math.floor(Date.now() / 1200) % 4];
  else if (pose === 'work') { const tools = ['🔨', '⚙️', '🛠️', '⚡']; const tick = Math.floor(Date.now() / 400); display = tick % 3 === 0 ? character : tools[tick % tools.length]; }
  else if (pose === 'done') display = ['🎉', '🎊', '🥳', '🌟'][Math.floor(Date.now() / 600) % 4];
  else if (pose === 'fail') display = ['😵', '💫', '🤕', '😿'][seed % 4];
  else if (pose === 'wake') display = ['🥱', '☕', '🌅'][Math.floor(Date.now() / 1000) % 3];
  return <div style={{ fontSize: '24px', lineHeight: 1 }}>{display}</div>;
}

function StickFigure({ pose, color, accentColor }: { pose: MascotPose; color: string; accentColor: string }) {
  // viewBox 32×40: head at (16,8), body (16,12)→(16,26), arms from (16,14), legs from (16,26)
  const strokeProps = { stroke: color, strokeWidth: 2, strokeLinecap: 'round' as const, fill: 'none' };

  if (pose === 'sleep') {
    // Lying down, sleeping
    return (
      <svg width="32" height="40" viewBox="0 0 32 40">
        {/* body horizontal */}
        <circle cx="8" cy="30" r="3" {...strokeProps} fill={color} />
        <line x1="11" y1="30" x2="26" y2="30" {...strokeProps} />
        <line x1="14" y1="30" x2="18" y2="26" {...strokeProps} />
        <line x1="20" y1="30" x2="24" y2="34" {...strokeProps} />
        {/* zzz */}
        <text x="18" y="14" fill={accentColor} fontSize="8" fontWeight="bold" style={{ animation: 'stick-zzz 2s ease-out infinite' }}>z</text>
        <text x="22" y="10" fill={accentColor} fontSize="6" fontWeight="bold" style={{ animation: 'stick-zzz 2s ease-out infinite 0.7s' }}>z</text>
      </svg>
    );
  }

  if (pose === 'wake') {
    // Stretching — arms up
    return (
      <svg width="32" height="40" viewBox="0 0 32 40">
        <circle cx="16" cy="8" r="3" {...strokeProps} fill={color} />
        <line x1="16" y1="11" x2="16" y2="26" {...strokeProps} />
        <line x1="16" y1="14" x2="10" y2="6" {...strokeProps} />
        <line x1="16" y1="14" x2="22" y2="6" {...strokeProps} />
        <line x1="16" y1="26" x2="12" y2="34" {...strokeProps} />
        <line x1="16" y1="26" x2="20" y2="34" {...strokeProps} />
        {/* ☼ */}
        <circle cx="26" cy="6" r="2" fill={accentColor} opacity="0.8" />
      </svg>
    );
  }

  if (pose === 'done') {
    // Victory pose — both arms up, legs apart
    return (
      <svg width="32" height="40" viewBox="0 0 32 40">
        <circle cx="16" cy="8" r="3" {...strokeProps} fill={color} />
        {/* smile */}
        <path d="M 14 8 Q 16 10 18 8" stroke={accentColor} strokeWidth="1" fill="none" strokeLinecap="round" />
        <line x1="16" y1="11" x2="16" y2="26" {...strokeProps} />
        <line x1="16" y1="14" x2="8" y2="4" {...strokeProps} />
        <line x1="16" y1="14" x2="24" y2="4" {...strokeProps} />
        <line x1="16" y1="26" x2="10" y2="36" {...strokeProps} />
        <line x1="16" y1="26" x2="22" y2="36" {...strokeProps} />
        {/* sparkles */}
        <text x="4" y="4" fill="#ffd700" fontSize="6" style={{ animation: 'stick-spark-burst 1.2s ease-out forwards' }}>✦</text>
        <text x="26" y="6" fill="#ffd700" fontSize="8" style={{ animation: 'stick-spark-burst 1.2s ease-out forwards 0.3s' }}>✦</text>
        <text x="2" y="20" fill="#ffd700" fontSize="5" style={{ animation: 'stick-spark-burst 1.2s ease-out forwards 0.5s' }}>✦</text>
      </svg>
    );
  }

  if (pose === 'fail') {
    // Fallen down — lying on back, X eyes (handled via external rotate)
    return (
      <svg width="32" height="40" viewBox="0 0 32 40">
        <circle cx="16" cy="8" r="3" {...strokeProps} fill={color} />
        {/* X eyes */}
        <line x1="14" y1="6" x2="15" y2="7" stroke={accentColor} strokeWidth="1" strokeLinecap="round" />
        <line x1="15" y1="6" x2="14" y2="7" stroke={accentColor} strokeWidth="1" strokeLinecap="round" />
        <line x1="17" y1="6" x2="18" y2="7" stroke={accentColor} strokeWidth="1" strokeLinecap="round" />
        <line x1="18" y1="6" x2="17" y2="7" stroke={accentColor} strokeWidth="1" strokeLinecap="round" />
        <line x1="16" y1="11" x2="16" y2="26" {...strokeProps} />
        <line x1="16" y1="14" x2="8" y2="18" {...strokeProps} />
        <line x1="16" y1="14" x2="24" y2="18" {...strokeProps} />
        <line x1="16" y1="26" x2="10" y2="34" {...strokeProps} />
        <line x1="16" y1="26" x2="22" y2="34" {...strokeProps} />
      </svg>
    );
  }

  if (pose === 'work') {
    // Hammering — left arm stable, right arm swinging with hammer
    return (
      <svg width="32" height="40" viewBox="0 0 32 40">
        <circle cx="16" cy="8" r="3" {...strokeProps} fill={color} />
        <line x1="16" y1="11" x2="16" y2="26" {...strokeProps} />
        {/* left arm holding nail */}
        <line x1="16" y1="14" x2="10" y2="20" {...strokeProps} />
        {/* right arm swinging hammer */}
        <g style={{ transformOrigin: '16px 14px', animation: 'stick-arm-hammer 0.5s ease-in-out infinite' }}>
          <line x1="16" y1="14" x2="24" y2="14" {...strokeProps} />
          {/* hammer */}
          <rect x="24" y="11" width="5" height="6" fill={accentColor} stroke={color} strokeWidth="1" rx="1" />
        </g>
        {/* legs walking */}
        <g style={{ transformOrigin: '16px 26px', animation: 'stick-leg-walk-l 0.5s ease-in-out infinite' }}>
          <line x1="16" y1="26" x2="12" y2="36" {...strokeProps} />
        </g>
        <g style={{ transformOrigin: '16px 26px', animation: 'stick-leg-walk-r 0.5s ease-in-out infinite' }}>
          <line x1="16" y1="26" x2="20" y2="36" {...strokeProps} />
        </g>
        {/* sparks from hammer */}
        <text x="26" y="22" fill="#ff9500" fontSize="6" style={{ animation: 'stick-spark 0.5s ease-in-out infinite' }}>✦</text>
      </svg>
    );
  }

  // idle — standing, waving
  return (
    <svg width="32" height="40" viewBox="0 0 32 40">
      <circle cx="16" cy="8" r="3" {...strokeProps} fill={color} />
      {/* eyes dots */}
      <circle cx="15" cy="7" r="0.6" fill={accentColor} />
      <circle cx="17" cy="7" r="0.6" fill={accentColor} />
      <line x1="16" y1="11" x2="16" y2="26" {...strokeProps} />
      {/* left arm down */}
      <line x1="16" y1="14" x2="12" y2="22" {...strokeProps} />
      {/* right arm waving */}
      <g style={{ transformOrigin: '16px 14px', animation: 'stick-arm-wave 2s ease-in-out infinite' }}>
        <line x1="16" y1="14" x2="22" y2="14" {...strokeProps} />
      </g>
      <line x1="16" y1="26" x2="12" y2="36" {...strokeProps} />
      <line x1="16" y1="26" x2="20" y2="36" {...strokeProps} />
    </svg>
  );
}

function WorkerMascot({ taskStatus, smithStatus, seed, accentColor, theme }: { taskStatus: string; smithStatus: string; seed: number; accentColor: string; theme: MascotTheme }) {
  if (theme === 'off') return null;

  let pose: MascotPose = 'idle';
  let animation = 'mascot-idle 3s ease-in-out infinite';
  let title = 'Ready for work';
  const color = '#e6edf3';

  if (smithStatus === 'down') {
    pose = 'sleep';
    animation = 'mascot-sleep 2.5s ease-in-out infinite';
    title = 'Smith is down — sleeping';
  } else if (taskStatus === 'running') {
    pose = 'work';
    animation = 'mascot-work 0.6s ease-in-out infinite';
    title = 'Hard at work!';
  } else if (taskStatus === 'done') {
    pose = 'done';
    // Celebrate 2 times (~2.4s total), then hold the pose quietly
    animation = 'mascot-celebrate 2.4s ease-in-out forwards';
    title = 'Task done!';
  } else if (taskStatus === 'failed') {
    pose = 'fail';
    animation = 'mascot-fall 0.8s ease-out forwards';
    title = 'Task failed';
  } else if (smithStatus === 'starting') {
    pose = 'wake';
    animation = 'mascot-sleep 1.8s ease-in-out infinite';
    title = 'Waking up...';
  } else {
    animation = 'mascot-idle 3s ease-in-out infinite';
    title = 'Ready for work';
  }

  let figure: React.ReactNode;
  if (theme === 'stick') figure = <StickFigure pose={pose} color={color} accentColor={accentColor} />;
  else if (theme === 'cat') figure = <StickCat pose={pose} color={color} accentColor={accentColor} />;
  else if (theme === 'pixel') figure = <PixelPerson pose={pose} color={color} accentColor={accentColor} />;
  else figure = <EmojiMascot pose={pose} seed={seed} />;

  return (
    <div
      className="absolute pointer-events-none select-none"
      style={{
        top: '-36px',
        right: '-8px',
        animation,
        filter: 'drop-shadow(0 2px 3px rgba(0,0,0,0.6))',
        zIndex: 10,
        transformOrigin: 'bottom center',
      }}
      title={title}
    >
      {figure}
    </div>
  );
}

function AgentFlowNode({ data }: NodeProps<Node<AgentNodeData>>) {
  const { config, state, colorIdx, previewLines, projectPath, workspaceId, onRun, onPause, onResume, onStop, onRetry, onEdit, onRemove, onMessage, onApprove, onShowLog, onShowMemory, onShowInbox, onOpenTerminal, onSwitchSession, onSaveAsTemplate, mascotTheme, bellOn = false, onToggleBell, inboxPending = 0, inboxFailed = 0 } = data;
  const c = COLORS[colorIdx % COLORS.length];
  const smithStatus = state?.smithStatus || 'down';
  const taskStatus = state?.taskStatus || 'idle';
  const hasTmux = !!state?.tmuxSession;
  const smithInfo = SMITH_STATUS[smithStatus] || SMITH_STATUS.down;
  const taskInfo = TASK_STATUS[taskStatus] || TASK_STATUS.idle;
  const currentStep = state?.currentStep;
  const step = currentStep !== undefined ? config.steps[currentStep] : undefined;
  const isApprovalPending = taskStatus === 'idle' && smithStatus === 'active';

  // Stable seed for mascot character from agent id
  const mascotSeed = config.id.split('').reduce((a, c) => a + c.charCodeAt(0), 0);

  return (
    <div className="w-52 flex flex-col rounded-lg select-none relative"
      style={{ border: `1px solid ${c.border}${taskStatus === 'running' ? '90' : '40'}`, background: c.bg,
        boxShadow: taskInfo.glow ? `0 0 12px ${taskInfo.color}25` : smithInfo.glow ? `0 0 8px ${smithInfo.color}15` : 'none' }}>
      <style>{MASCOT_STYLES}</style>
      <WorkerMascot taskStatus={taskStatus} smithStatus={smithStatus} seed={mascotSeed} accentColor={c.accent} theme={mascotTheme} />
      <Handle type="target" position={Position.Left} style={{ background: c.accent, width: 8, height: 8, border: 'none' }} />
      <Handle type="source" position={Position.Right} style={{ background: c.accent, width: 8, height: 8, border: 'none' }} />

      {/* Primary badge */}
      {config.primary && <div className="bg-[#f0883e]/20 text-[#f0883e] text-[7px] font-bold text-center py-0.5 rounded-t-lg">PRIMARY</div>}

      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2">
        <span className="text-sm">{config.icon}</span>
        <div className="flex-1 min-w-0">
          <div className="text-xs font-semibold text-white truncate">{config.label}</div>
          <div className="text-[8px]" style={{ color: c.accent }}>{config.backend === 'api' ? config.provider || 'api' : config.agentId || 'cli'}</div>
        </div>
        {/* Status: smith + terminal + task */}
        <div className="flex flex-col items-end gap-0.5">
          <div className="flex items-center gap-1">
            <div className="w-1.5 h-1.5 rounded-full" style={{ background: smithInfo.color, boxShadow: smithInfo.glow ? `0 0 4px ${smithInfo.color}` : 'none' }} />
            <span className="text-[7px]" style={{ color: smithInfo.color }}>{smithInfo.label}</span>
          </div>
          <div className="flex items-center gap-1">
            {(() => {
              // Execution mode is determined by config, not tmux state
              const isTerminalMode = config.persistentSession;
              const isActive = smithStatus === 'active';
              const color = isTerminalMode
                ? (hasTmux ? '#3fb950' : '#f0883e')         // terminal: green (up) / orange (down)
                : (isActive ? '#58a6ff' : '#484f58');        // headless: blue (active) / gray (down)
              const label = isTerminalMode
                ? (hasTmux ? 'terminal' : 'terminal (down)')
                : (isActive ? 'headless' : 'headless (down)');
              return (<>
                <div className="w-1.5 h-1.5 rounded-full" style={{ background: color }} />
                <span className="text-[7px] font-medium" style={{ color }}>{label}</span>
              </>);
            })()}
          </div>
          <div className="flex items-center gap-1">
            <div className="w-1.5 h-1.5 rounded-full" style={{ background: taskInfo.color, boxShadow: taskInfo.glow ? `0 0 4px ${taskInfo.color}` : 'none' }} />
            <span className="text-[7px]" style={{ color: taskInfo.color }}>{taskInfo.label}</span>
          </div>
          {config.watch?.enabled && (
            <div className="flex items-center gap-1">
              <span className="text-[7px]" style={{ color: (state as any)?.lastWatchAlert ? '#f0883e' : '#6e7681' }}>
                {(state as any)?.lastWatchAlert ? '👁 alert' : '👁 watching'}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Current step */}
      {step && taskStatus === 'running' && (
        <div className="px-3 pb-1 text-[8px] text-yellow-400/80" style={{ borderTop: `1px solid ${c.border}15` }}>
          Step {(currentStep || 0) + 1}/{config.steps.length}: {step.label}
        </div>
      )}

      {/* Error */}
      {state?.error && (
        <div className="px-3 pb-1 text-[8px] text-red-400 truncate" style={{ borderTop: `1px solid ${c.border}15` }}>
          {state.error}
        </div>
      )}

      {/* Preview lines */}
      {previewLines.length > 0 && (
        <div className="px-3 pb-2 space-y-0.5 cursor-pointer" style={{ borderTop: `1px solid ${c.border}15` }}
          onPointerDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); onShowLog(); }}>
          {previewLines.map((line, i) => (
            <div key={i} className="text-[8px] text-gray-500 font-mono truncate">{line}</div>
          ))}
        </div>
      )}

      {/* Inbox — prominent, shows pending/failed counts */}
      {(inboxPending > 0 || inboxFailed > 0) && (
        <div className="px-2 py-1" style={{ borderTop: `1px solid ${c.border}15` }}>
          <button onPointerDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); onShowInbox(); }}
            className="w-full text-[9px] px-2 py-1 rounded flex items-center justify-center gap-1.5 bg-orange-600/15 text-orange-400 hover:bg-orange-600/25 border border-orange-600/30">
            📨 Inbox
            {inboxPending > 0 && <span className="px-1 rounded-full bg-yellow-600/30 text-yellow-400 text-[8px]">{inboxPending} pending</span>}
            {inboxFailed > 0 && <span className="px-1 rounded-full bg-red-600/30 text-red-400 text-[8px]">{inboxFailed} failed</span>}
          </button>
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center gap-1 px-2 py-1.5" style={{ borderTop: `1px solid ${c.border}15` }}>
        {taskStatus === 'running' && (
          <>
            <button onPointerDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); data.onMarkIdle?.(); }}
              className="text-[9px] px-1 py-0.5 rounded bg-gray-600/20 text-gray-400 hover:bg-gray-600/30" title="Silent stop — no notifications">■</button>
            <button onPointerDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); data.onMarkDone?.(true); }}
              className="text-[9px] px-1 py-0.5 rounded bg-green-600/20 text-green-400 hover:bg-green-600/30" title="Mark done + notify">✓</button>
            <button onPointerDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); data.onMarkFailed?.(true); }}
              className="text-[9px] px-1 py-0.5 rounded bg-red-600/20 text-red-400 hover:bg-red-600/30" title="Mark failed + notify">✕</button>
          </>
        )}
        {/* Message button — send instructions to agent */}
        {smithStatus === 'active' && taskStatus !== 'running' && !state?.paused && (
          <button onPointerDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); onMessage(); }}
            className="text-[9px] px-1.5 py-0.5 rounded bg-blue-600/20 text-blue-400 hover:bg-blue-600/30">💬 Message</button>
        )}
        {/* Pause / Resume — icon-only so it doesn't widen the card */}
        {smithStatus !== 'down' && config.type !== 'input' && (
          <button onPointerDown={e => e.stopPropagation()}
            onClick={e => { e.stopPropagation(); state?.paused ? onResume() : onPause(); }}
            className={`text-[9px] px-1 ${state?.paused ? 'text-orange-400 hover:text-orange-300' : 'text-gray-600 hover:text-orange-400'}`}
            title={state?.paused
              ? 'Paused — click to resume bus pickups and watch alerts'
              : 'Pause — drop new bus messages and watch alerts as failed (in-flight task continues)'}
          >{state?.paused ? '▶' : '⏸'}</button>
        )}
        <div className="flex-1" />
        <span className="flex items-center">
            <button onPointerDown={e => e.stopPropagation()}
              onClick={e => { e.stopPropagation(); if (smithStatus === 'active') onOpenTerminal(); }}
              disabled={smithStatus !== 'active'}
              className={`text-[9px] px-1 ${smithStatus !== 'active' ? 'text-gray-700 cursor-not-allowed' : hasTmux && taskStatus === 'running' ? 'text-green-400 animate-pulse' : 'text-gray-600 hover:text-green-400'}`}
              title={smithStatus === 'starting' ? 'Starting session…' : smithStatus === 'down' ? 'Smith not started' : 'Open terminal'}>⌨️</button>
            {hasTmux && !config.primary && (
              <button onPointerDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); onSwitchSession(); }}
                className="text-[10px] text-gray-600 hover:text-yellow-400 px-0.5 py-0.5" title="Switch session">▾</button>
            )}
          </span>
        <button onPointerDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); onShowInbox(); }}
          className="text-[9px] text-gray-600 hover:text-orange-400 px-1" title="Messages (inbox/outbox)">📨</button>
        <button onPointerDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); onToggleBell?.(); }}
          className={`text-[9px] px-1 ${bellOn ? 'text-orange-400' : 'text-gray-600 hover:text-orange-400'}`}
          title={bellOn ? 'Bell ON — notify when this smith finishes (click to disable)' : 'Bell OFF — click to enable task done/failed notifications'}>
          {bellOn ? '🔔' : '🔕'}
        </button>
        <SmithMoreMenu
          onShowMemory={onShowMemory}
          onShowLog={onShowLog}
          onSaveAsTemplate={onSaveAsTemplate}
          onRefreshBus={async () => { if (workspaceId) try { await wsApi(workspaceId, 'refresh_bus'); } catch {} }}
        />
        <button onPointerDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); onEdit(); }}
          className="text-[9px] text-gray-600 hover:text-blue-400 px-1">✏️</button>
        <button onPointerDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); onRemove(); }}
          className="text-[9px] text-gray-600 hover:text-red-400 px-1">✕</button>
      </div>
    </div>
  );
}

// ─── Smith Node "More" Menu (⋯) ─────────────────────────

function SmithMoreMenu({ onShowMemory, onShowLog, onSaveAsTemplate, onRefreshBus }: {
  onShowMemory: () => void;
  onShowLog: () => void;
  onSaveAsTemplate: () => void;
  onRefreshBus: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as unknown as globalThis.Node;
      if (ref.current && !ref.current.contains(target)) setOpen(false);
    };
    window.addEventListener('mousedown', handler);
    return () => window.removeEventListener('mousedown', handler);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        onPointerDown={e => e.stopPropagation()}
        onClick={e => { e.stopPropagation(); setOpen(v => !v); }}
        className="text-[10px] text-gray-600 hover:text-white px-1"
        title="More actions"
      >⋯</button>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-50 bg-[#0d1117] border border-[#30363d] rounded shadow-xl py-1 min-w-[120px]">
          <button
            onPointerDown={e => e.stopPropagation()}
            onClick={e => { e.stopPropagation(); setOpen(false); onShowMemory(); }}
            className="w-full text-left text-[10px] px-2 py-1 hover:bg-[#161b22] text-gray-300 flex items-center gap-2"
          >🧠 Memory</button>
          <button
            onPointerDown={e => e.stopPropagation()}
            onClick={e => { e.stopPropagation(); setOpen(false); onShowLog(); }}
            className="w-full text-left text-[10px] px-2 py-1 hover:bg-[#161b22] text-gray-300 flex items-center gap-2"
          >📋 Logs</button>
          <button
            onPointerDown={e => e.stopPropagation()}
            onClick={e => { e.stopPropagation(); setOpen(false); onRefreshBus(); }}
            className="w-full text-left text-[10px] px-2 py-1 hover:bg-[#161b22] text-gray-300 flex items-center gap-2"
          >🔄 Refresh state</button>
          <button
            onPointerDown={e => e.stopPropagation()}
            onClick={e => { e.stopPropagation(); setOpen(false); onSaveAsTemplate(); }}
            className="w-full text-left text-[10px] px-2 py-1 hover:bg-[#161b22] text-gray-300 flex items-center gap-2"
          >💾 Save as template</button>
        </div>
      )}
    </div>
  );
}

const nodeTypes = { agent: AgentFlowNode, input: InputFlowNode };

// ─── Main Workspace ──────────────────────────────────────

export interface WorkspaceViewHandle {
  focusAgent: (agentId: string) => void;
}

function WorkspaceViewInner({ projectPath, projectName, onClose }: {
  projectPath: string;
  projectName: string;
  onClose: () => void;
}, ref: React.Ref<WorkspaceViewHandle>) {
  const reactFlow = useReactFlow();
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [rfNodes, setRfNodes] = useState<Node<any>[]>([]);
  const [modal, setModal] = useState<{ mode: 'add' | 'edit'; initial: Partial<AgentConfig>; editId?: string } | null>(null);
  const [messageTarget, setMessageTarget] = useState<{ id: string; label: string } | null>(null);
  const [logTarget, setLogTarget] = useState<{ id: string; label: string } | null>(null);
  const [runPromptTarget, setRunPromptTarget] = useState<{ id: string; label: string } | null>(null);
  const [userInputRequest, setUserInputRequest] = useState<{ agentId: string; fromAgent: string; question: string } | null>(null);
  const [memoryTarget, setMemoryTarget] = useState<{ id: string; label: string } | null>(null);
  const [inboxTarget, setInboxTarget] = useState<{ id: string; label: string } | null>(null);
  const [showBusPanel, setShowBusPanel] = useState(false);
  const [mascotTheme, setMascotTheme] = useState<MascotTheme>(() => {
    if (typeof window === 'undefined') return 'off';
    const saved = localStorage.getItem('forge.mascotTheme');
    // Migrate legacy values
    if (saved === 'dog' || saved === 'lobster') return 'pixel';
    if (saved === 'pig') return 'pixel';
    return (saved as MascotTheme) || 'off';
  });
  const updateMascotTheme = (t: MascotTheme) => {
    setMascotTheme(t);
    if (typeof window !== 'undefined') localStorage.setItem('forge.mascotTheme', t);
  };
  const [floatingTerminals, setFloatingTerminals] = useState<{ agentId: string; label: string; icon: string; cliId: string; cliCmd?: string; cliType?: string; workDir?: string; tmuxSession?: string; sessionName: string; resumeMode?: boolean; resumeSessionId?: string; profileEnv?: Record<string, string>; isPrimary?: boolean; skipPermissions?: boolean; persistentSession?: boolean; boundSessionId?: string; initialPos?: { x: number; y: number } }[]>([]);
  const [termPicker, setTermPicker] = useState<{ agent: AgentConfig; sessName: string; workDir?: string; supportsSession?: boolean; currentSessionId: string | null; initialPos?: { x: number; y: number } } | null>(null);
  // Terminal layout: floating (draggable windows) or docked (fixed grid at bottom)
  const [terminalLayout, setTerminalLayout] = useState<'floating' | 'docked'>(() => {
    if (typeof window === 'undefined') return 'floating';
    return (localStorage.getItem('forge.termLayout') as 'floating' | 'docked') || 'floating';
  });
  const [dockColumns, setDockColumns] = useState<number>(() => {
    if (typeof window === 'undefined') return 2;
    return parseInt(localStorage.getItem('forge.termDockCols') || '2');
  });
  const [dockHeight, setDockHeight] = useState<number>(() => {
    if (typeof window === 'undefined') return 320;
    return parseInt(localStorage.getItem('forge.termDockHeight') || '320');
  });
  const updateTerminalLayout = (l: 'floating' | 'docked') => {
    setTerminalLayout(l);
    if (typeof window !== 'undefined') localStorage.setItem('forge.termLayout', l);
  };
  const updateDockColumns = (n: number) => {
    setDockColumns(n);
    if (typeof window !== 'undefined') localStorage.setItem('forge.termDockCols', String(n));
  };

  // Expose focusAgent to parent
  useImperativeHandle(ref, () => ({
    focusAgent(agentId: string) {
      const node = rfNodes.find(n => n.id === agentId);
      if (node && node.measured?.width) {
        reactFlow.setCenter(
          node.position.x + (node.measured.width / 2),
          node.position.y + ((node.measured.height || 100) / 2),
          { zoom: 1.2, duration: 400 }
        );
        // Flash highlight via selection
        reactFlow.setNodes(nodes => nodes.map(n => ({ ...n, selected: n.id === agentId })));
        setTimeout(() => {
          reactFlow.setNodes(nodes => nodes.map(n => ({ ...n, selected: false })));
        }, 1500);
      }
    },
  }), [rfNodes, reactFlow]);

  // Initialize workspace
  useEffect(() => {
    ensureWorkspace(projectPath, projectName).then(setWorkspaceId).catch(() => {});
  }, [projectPath, projectName]);

  // Saved node positions from server (loaded once on workspace init)
  const [savedPositions, setSavedPositions] = useState<Record<string, { x: number; y: number }>>({});
  useEffect(() => {
    if (!workspaceId) return;
    wsApi(workspaceId, 'get_positions').then((res: any) => {
      if (res?.positions) setSavedPositions(res.positions);
    }).catch(() => {});
  }, [workspaceId]);

  // Save positions (debounced) when nodes are dragged
  const savePositionsDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveNodePositions = useCallback(() => {
    if (!workspaceId) return;
    if (savePositionsDebounceRef.current) clearTimeout(savePositionsDebounceRef.current);
    savePositionsDebounceRef.current = setTimeout(() => {
      const positions: Record<string, { x: number; y: number }> = {};
      for (const n of rfNodes) {
        positions[n.id] = { x: n.position.x, y: n.position.y };
      }
      wsApi(workspaceId, 'set_positions', { positions }).catch(() => {});
    }, 500);
  }, [workspaceId, rfNodes]);

  // SSE stream — server is the single source of truth
  const { agents, states, logPreview, busLog, daemonActive: daemonActiveFromStream, setDaemonActive: setDaemonActiveFromStream } = useWorkspaceStream(workspaceId, (event) => {
    if (event.type === 'user_input_request') {
      setUserInputRequest(event);
    }
  });

  // Auto-open terminals removed — persistent sessions run in background tmux.
  // User opens terminal via ⌨️ button when needed.

  // ─── Smith bell notifications (per-agent, persisted) ──
  const [bellAgents, setBellAgents] = useState<Set<string>>(() => {
    if (typeof window === 'undefined') return new Set();
    try {
      const raw = localStorage.getItem('forge.workspace.bellAgents');
      return raw ? new Set(JSON.parse(raw)) : new Set();
    } catch { return new Set(); }
  });
  const toggleBell = useCallback((agentId: string) => {
    setBellAgents(prev => {
      const next = new Set(prev);
      if (next.has(agentId)) next.delete(agentId);
      else {
        next.add(agentId);
        // Request browser notification permission on first enable
        if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
          Notification.requestPermission().catch(() => {});
        }
      }
      try { localStorage.setItem('forge.workspace.bellAgents', JSON.stringify([...next])); } catch {}
      return next;
    });
  }, []);

  // Watch taskStatus transitions and fire bell on running → done/failed
  const prevTaskStatusRef = useRef<Record<string, string>>({});
  useEffect(() => {
    const prev = prevTaskStatusRef.current;
    for (const agent of agents) {
      const cur = states[agent.id]?.taskStatus;
      const before = prev[agent.id];
      if (cur && before === 'running' && (cur === 'done' || cur === 'failed')) {
        if (bellAgents.has(agent.id)) {
          fireSmithBell(agent.label, cur);
        }
      }
    }
    // Update snapshot for next tick
    const snapshot: Record<string, string> = {};
    for (const agent of agents) {
      const s = states[agent.id]?.taskStatus;
      if (s) snapshot[agent.id] = s;
    }
    prevTaskStatusRef.current = snapshot;
  }, [states, agents, bellAgents]);

  // Rebuild nodes when agents/states/preview change — preserve existing positions + dimensions
  useEffect(() => {
    setRfNodes(prev => {
      const prevMap = new Map(prev.map(n => [n.id, n]));
      return agents.map((agent, i) => {
        const existing = prevMap.get(agent.id);
        const base = {
          id: agent.id,
          position: existing?.position ?? savedPositions[agent.id] ?? { x: i * 260, y: 60 },
          ...(existing?.measured ? { measured: existing.measured } : {}),
          ...(existing?.width ? { width: existing.width, height: existing.height } : {}),
        };

        // Input node
        if (agent.type === 'input') {
          return {
            ...base,
            type: 'input' as const,
            data: {
              config: agent,
              state: states[agent.id] || { smithStatus: 'down', taskStatus: 'idle', artifacts: [] },
              onSubmit: (content: string) => {
                // Optimistic update
                wsApi(workspaceId!, 'complete_input', { agentId: agent.id, content });
              },
              onEdit: () => setModal({ mode: 'edit', initial: agent, editId: agent.id }),
              onRemove: () => {
                if (!confirm(`Remove "${agent.label}"?`)) return;
                wsApi(workspaceId!, 'remove', { agentId: agent.id });
              },
            } satisfies InputNodeData,
          };
        }

        // Agent node
        return {
          ...base,
          type: 'agent' as const,
          data: {
            config: agent,
            state: states[agent.id] || { smithStatus: 'down', taskStatus: 'idle', artifacts: [] },
            colorIdx: i,
            previewLines: logPreview[agent.id] || [],
            projectPath,
            workspaceId,
            onRun: () => {
              wsApi(workspaceId!, 'run', { agentId: agent.id });
            },
            onPause: () => wsApi(workspaceId!, 'pause', { agentId: agent.id }),
            onResume: () => wsApi(workspaceId!, 'resume', { agentId: agent.id }),
            onStop: () => wsApi(workspaceId!, 'stop', { agentId: agent.id }),
            mascotTheme,
            bellOn: bellAgents.has(agent.id),
            onToggleBell: () => toggleBell(agent.id),
            onMarkIdle: () => wsApi(workspaceId!, 'mark_done', { agentId: agent.id, notify: false }),
            onMarkDone: (notify: boolean) => wsApi(workspaceId!, 'mark_done', { agentId: agent.id, notify }),
            onMarkFailed: (notify: boolean) => wsApi(workspaceId!, 'mark_failed', { agentId: agent.id, notify }),
            onRetry: () => wsApi(workspaceId!, 'retry', { agentId: agent.id }),
            onEdit: () => setModal({ mode: 'edit', initial: agent, editId: agent.id }),
            onRemove: () => {
              if (!confirm(`Remove "${agent.label}"?`)) return;
              wsApi(workspaceId!, 'remove', { agentId: agent.id });
            },
            onMessage: () => setMessageTarget({ id: agent.id, label: agent.label }),
            onApprove: () => wsApi(workspaceId!, 'approve', { agentId: agent.id }),
            onShowLog: () => setLogTarget({ id: agent.id, label: agent.label }),
            onShowMemory: () => setMemoryTarget({ id: agent.id, label: agent.label }),
            onShowInbox: () => setInboxTarget({ id: agent.id, label: agent.label }),
            inboxPending: busLog.filter(m => m.to === agent.id && (m.status === 'pending' || m.status === 'pending_approval') && m.type !== 'ack').length,
            inboxFailed: busLog.filter(m => m.to === agent.id && m.status === 'failed' && m.type !== 'ack').length,
            onOpenTerminal: async () => {
              if (!workspaceId) return;
              // Sync stale daemonActiveFromStream from agent states
              const anyActive = Object.values(states).some(s => s?.smithStatus === 'active');
              if (anyActive && !daemonActiveFromStream) setDaemonActiveFromStream(true);
              // Close existing terminal (config may have changed)
              setFloatingTerminals(prev => prev.filter(t => t.agentId !== agent.id));

              const nodeEl = document.querySelector(`[data-id="${agent.id}"]`);
              const nodeRect = nodeEl?.getBoundingClientRect();
              const initialPos = nodeRect ? { x: nodeRect.left, y: nodeRect.bottom + 4 } : { x: 80, y: 60 };
              const safeName = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').slice(0, 20);
              const sessName = `mw-forge-${safeName(projectName)}-${safeName(agent.label)}`;
              const workDir = agent.workDir && agent.workDir !== './' && agent.workDir !== '.' ? agent.workDir : undefined;
              // All agents: show picker (current session / new session / other sessions)
              const resolveRes = await wsApi(workspaceId, 'open_terminal', { agentId: agent.id, resolveOnly: true }).catch(() => ({})) as any;
              const currentSessionId = resolveRes?.currentSessionId ?? null;
              setTermPicker({ agent, sessName, workDir, supportsSession: resolveRes?.supportsSession ?? true, currentSessionId, initialPos });
            },
            onSaveAsTemplate: async () => {
              const name = prompt('Template name:', agent.label);
              if (!name) return;
              const desc = prompt('Description (optional):', '');
              try {
                await fetch('/api/smith-templates', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ config: agent, name, icon: agent.icon, description: desc || '' }),
                });
              } catch {
                alert('Failed to save template');
              }
            },
            onSwitchSession: async () => {
              if (!workspaceId) return;
              setFloatingTerminals(prev => prev.filter(t => t.agentId !== agent.id));
              if (agent.id) wsApi(workspaceId, 'close_terminal', { agentId: agent.id });
              const nodeEl = document.querySelector(`[data-id="${agent.id}"]`);
              const nodeRect = nodeEl?.getBoundingClientRect();
              const initialPos = nodeRect ? { x: nodeRect.left, y: nodeRect.bottom + 4 } : { x: 80, y: 60 };
              const safeName = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').slice(0, 20);
              const sessName = `mw-forge-${safeName(projectName)}-${safeName(agent.label)}`;
              const workDir = agent.workDir && agent.workDir !== './' && agent.workDir !== '.' ? agent.workDir : undefined;
              const resolveRes = await wsApi(workspaceId, 'open_terminal', { agentId: agent.id, resolveOnly: true }).catch(() => ({})) as any;
              const currentSessionId = resolveRes?.currentSessionId ?? null;
              setTermPicker({ agent, sessName, workDir, supportsSession: resolveRes?.supportsSession ?? true, currentSessionId, initialPos });
            },
          } satisfies AgentNodeData,
        };
      });
    });
  }, [agents, states, logPreview, workspaceId, mascotTheme, savedPositions, bellAgents]); // eslint-disable-line react-hooks/exhaustive-deps

  // Derive edges from dependsOn
  const rfEdges = useMemo(() => {
    const edges: any[] = [];
    for (const agent of agents) {
      for (const depId of agent.dependsOn) {
        const depState = states[depId];
        const targetState = states[agent.id];
        const depTask = depState?.taskStatus || 'idle';
        const targetTask = targetState?.taskStatus || 'idle';
        const isFlowing = depTask === 'running' || targetTask === 'running';
        const isCompleted = depTask === 'done';
        const color = isFlowing ? '#58a6ff70' : isCompleted ? '#58a6ff40' : '#30363d60';

        // Find last bus message between these two agents
        const lastMsg = [...busLog].reverse().find(m =>
          (m.from === depId && m.to === agent.id) || (m.from === agent.id && m.to === depId)
        );
        const edgeLabel = lastMsg?.payload?.action && lastMsg.payload.action !== 'task_complete' && lastMsg.payload.action !== 'ack'
          ? `${lastMsg.payload.action}${lastMsg.payload.content ? ': ' + lastMsg.payload.content.slice(0, 30) : ''}`
          : undefined;

        edges.push({
          id: `${depId}-${agent.id}`,
          source: depId,
          target: agent.id,
          animated: isFlowing,
          label: edgeLabel,
          labelStyle: { fill: '#8b949e', fontSize: 8 },
          labelBgStyle: { fill: '#0d1117', fillOpacity: 0.8 },
          labelBgPadding: [4, 2] as [number, number],
          style: { stroke: color, strokeWidth: isFlowing ? 2 : isCompleted ? 1.5 : 1 },
          markerEnd: { type: MarkerType.ArrowClosed, color },
        });
      }
    }
    return edges;
  }, [agents, states]);

  // Let ReactFlow manage all node changes (position, dimensions, selection, etc.)
  const onNodesChange = useCallback((changes: NodeChange[]) => {
    setRfNodes(prev => applyNodeChanges(changes, prev) as Node<AgentNodeData>[]);
  }, []);

  const handleAddAgent = async (cfg: Omit<AgentConfig, 'id'>) => {
    if (!workspaceId) return;
    const config: AgentConfig = { ...cfg, id: `${cfg.label.toLowerCase().replace(/\s+/g, '-')}-${Date.now()}` };
    // Auto-install base plugins if not already installed (for preset templates)
    // User-selected instances are already installed, so this is a no-op for them
    if (cfg.plugins?.length) {
      await Promise.all(cfg.plugins.map(pluginId =>
        fetch('/api/plugins', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'install', id: pluginId, config: {} }),
        }).catch(() => {})
      ));
    }
    // Optimistic update — show immediately
    setModal(null);
    await wsApi(workspaceId, 'add', { config });
  };

  const handleEditAgent = async (cfg: Omit<AgentConfig, 'id'>) => {
    if (!workspaceId || !modal?.editId) return;
    const config: AgentConfig = { ...cfg, id: modal.editId };
    // Optimistic update
    setModal(null);
    await wsApi(workspaceId, 'update', { agentId: modal.editId, config });
  };

  const handleAddInput = async () => {
    if (!workspaceId) return;
    const config: AgentConfig = {
      id: `input-${Date.now()}`, label: 'Requirements', icon: '📝',
      type: 'input', content: '', entries: [], role: '', backend: 'cli',
      dependsOn: [], outputs: [], steps: [],
    };
    await wsApi(workspaceId, 'add', { config });
  };

  const handleCreatePipeline = async () => {
    if (!workspaceId) return;
    // Create pipeline via API — server uses presets with full prompts
    const res = await fetch(`/api/workspace/${workspaceId}/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'create_pipeline' }),
    });
    const data = await res.json();
    if (!res.ok && data.error) alert(`Error: ${data.error}`);
  };

  const handleExportTemplate = async () => {
    if (!workspaceId) return;
    try {
      const res = await fetch(`/api/workspace?export=${workspaceId}`);
      const template = await res.json();
      // Download as JSON file
      const blob = new Blob([JSON.stringify(template, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `workspace-template-${projectName.replace(/\s+/g, '-')}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      alert('Export failed');
    }
  };

  const handleImportTemplate = async (file: File) => {
    if (!workspaceId) return;
    try {
      const text = await file.text();
      const template = JSON.parse(text);
      await fetch('/api/workspace', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectPath, projectName, template }),
      });
      // Reload page to pick up new workspace
      window.location.reload();
    } catch {
      alert('Import failed — invalid template file');
    }
  };

  const handleRunAll = () => { if (workspaceId) wsApi(workspaceId, 'run_all'); };
  const handleStartDaemon = async () => {
    if (!workspaceId) return;
    const result = await wsApi(workspaceId, 'start_daemon');
    if (result.ok) setDaemonActiveFromStream(true);
  };
  const handleStopDaemon = async () => {
    if (!workspaceId) return;
    const result = await wsApi(workspaceId, 'stop_daemon');
    if (result.ok) setDaemonActiveFromStream(false);
  };

  return (
    <div className="flex-1 flex flex-col min-h-0" style={{ background: '#080810' }}>
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-[#2a2a3a] shrink-0">
        <button onClick={onClose} className="text-gray-400 hover:text-white text-sm">←</button>
        <span className="text-xs font-bold text-white">Workspace</span>
        <span className="text-[9px] text-gray-500">{projectName}</span>
        {agents.length > 0 && !daemonActiveFromStream && (
          <>
            <button onClick={handleRunAll}
              className="text-[8px] px-2 py-0.5 rounded bg-green-600/20 text-green-400 hover:bg-green-600/30 ml-2">
              ▶ Run All
            </button>
            <button onClick={handleStartDaemon}
              className="text-[8px] px-2 py-0.5 rounded bg-emerald-600/20 text-emerald-400 hover:bg-emerald-600/30">
              ⚡ Start Daemon
            </button>
          </>
        )}
        {daemonActiveFromStream && (
          <>
            <span className="text-[8px] px-2 py-0.5 rounded bg-green-600/30 text-green-400 ml-2 animate-pulse">
              ● Daemon Active
            </span>
            <button onClick={handleStopDaemon}
              className="text-[8px] px-2 py-0.5 rounded bg-red-600/20 text-red-400 hover:bg-red-600/30">
              ■ Stop
            </button>
          </>
        )}
        <div className="ml-auto flex items-center gap-2">
          {/* Terminal layout switcher */}
          <div className="flex items-center gap-0.5 px-1 py-0.5 rounded border border-[#30363d] bg-[#0d1117]">
            <button
              onClick={() => updateTerminalLayout('floating')}
              className={`text-[8px] px-1.5 py-0.5 rounded ${terminalLayout === 'floating' ? 'bg-[#58a6ff]/20 text-[#58a6ff]' : 'text-gray-500 hover:text-white'}`}
              title="Floating terminals (draggable windows)"
            >⧉ Float</button>
            <button
              onClick={() => updateTerminalLayout('docked')}
              className={`text-[8px] px-1.5 py-0.5 rounded ${terminalLayout === 'docked' ? 'bg-[#58a6ff]/20 text-[#58a6ff]' : 'text-gray-500 hover:text-white'}`}
              title="Docked terminals (bottom grid)"
            >▤ Dock</button>
            {terminalLayout === 'docked' && (
              <>
                <span className="w-px h-3 bg-[#30363d] mx-0.5" />
                {[1, 2, 3, 4].map(n => (
                  <button
                    key={n}
                    onClick={() => updateDockColumns(n)}
                    className={`text-[8px] px-1 py-0.5 rounded ${dockColumns === n ? 'bg-[#58a6ff]/20 text-[#58a6ff]' : 'text-gray-500 hover:text-white'}`}
                    title={`${n} column${n > 1 ? 's' : ''}`}
                  >{n}</button>
                ))}
              </>
            )}
          </div>
          <select value={mascotTheme} onChange={e => updateMascotTheme(e.target.value as MascotTheme)}
            className="text-[8px] px-1.5 py-0.5 rounded border border-[#30363d] bg-[#0d1117] text-gray-500 hover:text-white hover:border-[#58a6ff]/60 cursor-pointer focus:outline-none"
            title="Mascot theme">
            <option value="stick">🏃 Stick</option>
            <option value="cat">🐱 Cat</option>
            <option value="pixel">👾 Pixel</option>
            <option value="emoji">🎭 Emoji</option>
            <option value="off">⊘ Off</option>
          </select>
          <button onClick={() => setShowBusPanel(true)}
            className={`text-[8px] px-2 py-0.5 rounded border border-[#30363d] hover:border-[#58a6ff]/60 ${busLog.length > 0 ? 'text-[#58a6ff]' : 'text-gray-500'}`}>
            📡 Logs{busLog.length > 0 ? ` (${busLog.length})` : ''}
          </button>
          {agents.length > 0 && (
            <button onClick={handleExportTemplate}
              className="text-[8px] px-2 py-0.5 rounded border border-[#30363d] text-gray-500 hover:text-white hover:border-[#58a6ff]/60">
              📤 Export
            </button>
          )}
          <button onClick={handleAddInput}
            className="text-[8px] px-2 py-0.5 rounded border border-[#30363d] text-gray-400 hover:text-white hover:border-[#58a6ff]/60">
            📝 + Input
          </button>
          <button onClick={() => setModal({ mode: 'add', initial: {} })}
            className="text-[8px] px-2 py-0.5 rounded border border-[#30363d] text-gray-400 hover:text-white hover:border-[#58a6ff]/60">
            + Add Agent
          </button>
        </div>
      </div>

      {/* Graph area */}
      {agents.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-3">
          <span className="text-3xl">🚀</span>
          <div className="text-sm text-gray-400">Set up your workspace</div>
          {/* Primary agent prompt */}
          <button onClick={() => setModal({ mode: 'add', initial: {
            label: 'Engineer', icon: '👨‍💻', primary: true, persistentSession: true,
            role: 'Primary engineer — handles coding tasks in the project root.',
            backend: 'cli' as const, agentId: 'claude', workDir: './', dependsOn: [], outputs: [], steps: [],
          }})}
            className="flex items-center gap-3 px-5 py-3 rounded-lg border-2 border-dashed border-[#f0883e]/50 bg-[#f0883e]/5 hover:bg-[#f0883e]/10 hover:border-[#f0883e]/80 transition-colors">
            <span className="text-2xl">👨‍💻</span>
            <div className="text-left">
              <div className="text-[11px] font-semibold text-[#f0883e]">Add Primary Agent</div>
              <div className="text-[9px] text-gray-500">Terminal-only, root directory, fixed session</div>
            </div>
          </button>
          <div className="text-[9px] text-gray-600 mt-1">or add other agents:</div>
          <div className="flex gap-2 flex-wrap justify-center">
            {PRESET_AGENTS.map((p, i) => (
              <button key={i} onClick={() => setModal({ mode: 'add', initial: p })}
                className="text-[10px] px-3 py-1.5 rounded border border-[#30363d] text-gray-300 hover:text-white hover:border-[#58a6ff]/60 flex items-center gap-1">
                {p.icon} {p.label}
              </button>
            ))}
          </div>
          <div className="flex gap-2 mt-1">
            <button onClick={() => setModal({ mode: 'add', initial: {} })}
              className="text-[10px] px-3 py-1.5 rounded border border-dashed border-[#30363d] text-gray-500 hover:text-white hover:border-[#58a6ff]/60">
              ⚙️ Custom
            </button>
            <button onClick={handleCreatePipeline}
              className="text-[10px] px-3 py-1.5 rounded border border-[#238636] text-[#3fb950] hover:bg-[#238636]/20">
              🚀 Dev Pipeline
            </button>
            <label className="text-[10px] px-3 py-1.5 rounded border border-dashed border-[#30363d] text-gray-500 hover:text-white hover:border-[#58a6ff]/60 cursor-pointer">
              📥 Import
              <input type="file" accept=".json" className="hidden" onChange={e => {
                const file = e.target.files?.[0];
                if (file) handleImportTemplate(file);
                e.target.value = '';
              }} />
            </label>
          </div>
        </div>
      ) : (
        <div className="flex-1 min-h-0 flex flex-col">
          {/* No primary agent hint */}
          {!agents.some(a => a.primary) && (
            <div className="flex items-center gap-2 px-3 py-1.5 bg-[#f0883e]/10 border-b border-[#f0883e]/20 shrink-0">
              <span className="text-[10px] text-[#f0883e]">No primary agent set.</span>
              <button onClick={() => setModal({ mode: 'add', initial: {
                label: 'Engineer', icon: '👨‍💻', primary: true, persistentSession: true,
                role: 'Primary engineer — handles coding tasks in the project root.',
                backend: 'cli' as const, agentId: 'claude', workDir: './', dependsOn: [], outputs: [], steps: [],
              }})}
                className="text-[10px] text-[#f0883e] underline hover:text-white">Add one</button>
              <span className="text-[9px] text-gray-600">or edit an existing agent to set as primary.</span>
            </div>
          )}
          <ReactFlow
            nodes={rfNodes}
            edges={rfEdges}
            onNodesChange={onNodesChange}
            onNodeDragStop={() => {
              // Persist positions
              saveNodePositions();
              // Reposition terminals to follow their nodes
              setFloatingTerminals(prev => prev.map(ft => {
                const nodeEl = document.querySelector(`[data-id="${ft.agentId}"]`);
                const rect = nodeEl?.getBoundingClientRect();
                return rect ? { ...ft, initialPos: { x: rect.left, y: rect.bottom + 4 } } : ft;
              }));
            }}
            onMoveEnd={() => {
              // Reposition after pan/zoom
              setFloatingTerminals(prev => prev.map(ft => {
                const nodeEl = document.querySelector(`[data-id="${ft.agentId}"]`);
                const rect = nodeEl?.getBoundingClientRect();
                return rect ? { ...ft, initialPos: { x: rect.left, y: rect.bottom + 4 } } : ft;
              }));
            }}
            nodeTypes={nodeTypes}
            fitView
            fitViewOptions={{ padding: 0.3 }}
            minZoom={0.3}
            maxZoom={2}
            proOptions={{ hideAttribution: true }}
          >
            <Background color="#1a1a2e" gap={20} size={1} />
            <Controls style={{ background: '#0d1117', border: '1px solid #30363d' }} showInteractive={false} />
          </ReactFlow>
        </div>
      )}

      {/* Config modal */}
      {modal && (
        <AgentConfigModal
          initial={modal.initial}
          mode={modal.mode}
          existingAgents={agents}
          projectPath={projectPath}
          onConfirm={modal.mode === 'add' ? handleAddAgent : handleEditAgent}
          onCancel={() => setModal(null)}
        />
      )}

      {/* Run prompt dialog (for agents with no dependencies) */}
      {runPromptTarget && workspaceId && (
        <RunPromptDialog
          agentLabel={runPromptTarget.label}
          onRun={input => {
            wsApi(workspaceId, 'run', { agentId: runPromptTarget.id, input: input || undefined });
            setRunPromptTarget(null);
          }}
          onCancel={() => setRunPromptTarget(null)}
        />
      )}

      {/* Message dialog */}
      {messageTarget && workspaceId && (
        <MessageDialog
          agentLabel={messageTarget.label}
          onSend={msg => {
            wsApi(workspaceId, 'message', { agentId: messageTarget.id, content: msg });
            setMessageTarget(null);
          }}
          onCancel={() => setMessageTarget(null)}
        />
      )}

      {/* Log panel */}
      {logTarget && workspaceId && (
        <LogPanel
          agentId={logTarget.id}
          agentLabel={logTarget.label}
          workspaceId={workspaceId}
          onClose={() => setLogTarget(null)}
        />
      )}

      {/* Bus message panel */}
      {showBusPanel && (
        <BusPanel busLog={busLog} agents={agents} onClose={() => setShowBusPanel(false)} />
      )}

      {/* Memory panel */}
      {memoryTarget && workspaceId && (
        <MemoryPanel
          agentId={memoryTarget.id}
          agentLabel={memoryTarget.label}
          workspaceId={workspaceId}
          onClose={() => setMemoryTarget(null)}
        />
      )}

      {/* Inbox panel */}
      {inboxTarget && workspaceId && (
        <InboxPanel
          agentId={inboxTarget.id}
          agentLabel={inboxTarget.label}
          busLog={busLog}
          agents={agents}
          workspaceId={workspaceId}
          onClose={() => setInboxTarget(null)}
        />
      )}

      {/* Terminal session picker */}
      {termPicker && workspaceId && (
        <TerminalSessionPickerLazy
          agentLabel={termPicker.agent.label}
          currentSessionId={termPicker.currentSessionId}
          fetchSessions={() => fetchAgentSessions(workspaceId, termPicker.agent.id)}
          supportsSession={termPicker.supportsSession}
          onSelect={async (selection: PickerSelection) => {
            const { agent, sessName, workDir } = termPicker;
            const pickerInitialPos = termPicker.initialPos;
            setTermPicker(null);

            let boundSessionId = agent.boundSessionId;
            if (selection.mode === 'session') {
              // Bind to a specific session
              await wsApi(workspaceId, 'update', { agentId: agent.id, config: { ...agent, boundSessionId: selection.sessionId } }).catch(() => {});
              boundSessionId = selection.sessionId;
            } else if (selection.mode === 'new') {
              // Clear bound session → fresh start
              if (agent.boundSessionId) {
                await wsApi(workspaceId, 'update', { agentId: agent.id, config: { ...agent, boundSessionId: undefined } }).catch(() => {});
              }
              boundSessionId = undefined;
            }
            // mode === 'current': keep existing boundSessionId

            // 'current': just attach — claude is running, don't interrupt.
            // 'session' or 'new': forceRestart — rebuild launch script with correct --resume.
            const forceRestart = selection.mode !== 'current';
            const res = await wsApi(workspaceId, 'open_terminal', { agentId: agent.id, forceRestart }).catch(() => ({})) as any;
            const tmux = res?.tmuxSession || sessName;
            setFloatingTerminals(prev => [...prev, {
              agentId: agent.id, label: agent.label, icon: agent.icon,
              cliId: agent.agentId || 'claude', workDir,
              tmuxSession: tmux, sessionName: sessName,
              isPrimary: agent.primary, skipPermissions: agent.skipPermissions !== false,
              persistentSession: agent.persistentSession, boundSessionId, initialPos: pickerInitialPos,
            }]);
          }}
          onCancel={() => setTermPicker(null)}
        />
      )}

      {/* Terminals — floating (draggable windows) or docked (bottom grid) */}
      {terminalLayout === 'floating' && floatingTerminals.map(ft => (
        <FloatingTerminal
          key={ft.agentId}
          agentLabel={ft.label}
          agentIcon={ft.icon}
          projectPath={projectPath}
          agentCliId={ft.cliId}
          cliCmd={ft.cliCmd}
          cliType={ft.cliType}
          workDir={ft.workDir}
          preferredSessionName={ft.sessionName}
          existingSession={ft.tmuxSession}
          resumeMode={ft.resumeMode}
          resumeSessionId={ft.resumeSessionId}
          profileEnv={ft.profileEnv}
          isPrimary={ft.isPrimary}
          skipPermissions={ft.skipPermissions}
          persistentSession={ft.persistentSession}
          boundSessionId={ft.boundSessionId}
          initialPos={ft.initialPos}
          onSessionReady={(name) => {
            if (workspaceId) wsApi(workspaceId, 'set_tmux_session', { agentId: ft.agentId, sessionName: name });
            setFloatingTerminals(prev => prev.map(t => t.agentId === ft.agentId ? { ...t, tmuxSession: name } : t));
          }}
          onClose={(killSession) => {
            setFloatingTerminals(prev => prev.filter(t => t.agentId !== ft.agentId));
            if (workspaceId) wsApi(workspaceId, 'close_terminal', { agentId: ft.agentId, kill: killSession });
          }}
        />
      ))}

      {/* Docked terminals — bottom panel with grid layout */}
      {terminalLayout === 'docked' && floatingTerminals.length > 0 && (
        <div
          className="fixed bottom-0 left-0 right-0 z-40 bg-[#0a0e14] border-t border-[#30363d] flex flex-col"
          style={{ height: dockHeight }}
        >
          {/* Resize handle */}
          <div
            className="h-1 bg-[#30363d] hover:bg-[var(--accent)] cursor-ns-resize shrink-0"
            onMouseDown={(e) => {
              e.preventDefault();
              const startY = e.clientY;
              const startH = dockHeight;
              const onMove = (ev: MouseEvent) => {
                const newH = Math.max(200, Math.min(window.innerHeight - 100, startH - (ev.clientY - startY)));
                setDockHeight(newH);
              };
              const onUp = () => {
                window.removeEventListener('mousemove', onMove);
                window.removeEventListener('mouseup', onUp);
                if (typeof window !== 'undefined') localStorage.setItem('forge.termDockHeight', String(dockHeight));
              };
              window.addEventListener('mousemove', onMove);
              window.addEventListener('mouseup', onUp);
            }}
          />
          <div className="grid gap-1 p-1 flex-1 min-h-0" style={{ gridTemplateColumns: `repeat(${Math.min(floatingTerminals.length, dockColumns)}, minmax(0, 1fr))` }}>
            {floatingTerminals.map(ft => (
              <FloatingTerminal
                key={ft.agentId}
                agentLabel={ft.label}
                agentIcon={ft.icon}
                projectPath={projectPath}
                agentCliId={ft.cliId}
                cliCmd={ft.cliCmd}
                cliType={ft.cliType}
                workDir={ft.workDir}
                preferredSessionName={ft.sessionName}
                existingSession={ft.tmuxSession}
                resumeMode={ft.resumeMode}
                resumeSessionId={ft.resumeSessionId}
                profileEnv={ft.profileEnv}
                isPrimary={ft.isPrimary}
                skipPermissions={ft.skipPermissions}
                persistentSession={ft.persistentSession}
                boundSessionId={ft.boundSessionId}
                docked
                onSessionReady={(name) => {
                  if (workspaceId) wsApi(workspaceId, 'set_tmux_session', { agentId: ft.agentId, sessionName: name });
                  setFloatingTerminals(prev => prev.map(t => t.agentId === ft.agentId ? { ...t, tmuxSession: name } : t));
                }}
                onClose={(killSession) => {
                  setFloatingTerminals(prev => prev.filter(t => t.agentId !== ft.agentId));
                  if (workspaceId) wsApi(workspaceId, 'close_terminal', { agentId: ft.agentId, kill: killSession });
                }}
              />
            ))}
          </div>
        </div>
      )}

      {/* User input request from agent (via bus) */}
      {userInputRequest && workspaceId && (
        <RunPromptDialog
          agentLabel={`${agents.find(a => a.id === userInputRequest.fromAgent)?.label || 'Agent'} asks`}
          onRun={input => {
            // Send response to the requesting agent's target (Input node)
            wsApi(workspaceId, 'complete_input', {
              agentId: userInputRequest.agentId,
              content: input || userInputRequest.question,
            });
            setUserInputRequest(null);
          }}
          onCancel={() => setUserInputRequest(null)}
        />
      )}
    </div>
  );
}

const WorkspaceViewWithRef = forwardRef(WorkspaceViewInner);

// Wrap with ReactFlowProvider so useReactFlow works
export default forwardRef<WorkspaceViewHandle, { projectPath: string; projectName: string; onClose: () => void }>(
  function WorkspaceView(props, ref) {
    return (
      <ReactFlowProvider>
        <WorkspaceViewWithRef {...props} ref={ref} />
      </ReactFlowProvider>
    );
  }
);
