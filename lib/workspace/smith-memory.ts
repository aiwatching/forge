/**
 * Smith Memory — persistent per-agent memory system.
 *
 * Inspired by claude-mem (https://github.com/thedotmack/claude-mem):
 * - Per-step observation capture (not just end-of-run)
 * - 6 observation types: decision, bugfix, feature, refactor, discovery, change
 * - Session summary at end (request/investigated/learned/completed/next_steps)
 * - Progressive disclosure: recent entries full detail, older ones title-only
 * - Structured observations: title, facts, concepts, files_read, files_modified
 *
 * Storage: ~/.forge/workspaces/{workspace-id}/agents/{agent-id}/memory.json
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// ─── Types ───────────────────────────────────────────────

export type ObservationType = 'decision' | 'bugfix' | 'feature' | 'refactor' | 'discovery' | 'change';

export interface Observation {
  id: string;                         // unique per observation
  timestamp: number;
  type: ObservationType;
  title: string;                      // one-line summary
  subtitle?: string;                  // additional detail
  facts?: string[];                   // extracted structured facts
  concepts?: string[];                // abstract tags/categories
  filesRead?: string[];
  filesModified?: string[];
  stepLabel?: string;                 // which step produced this
  detail?: string;                    // full detail (pruned in older entries)
}

export interface SessionSummary {
  timestamp: number;
  request: string;                    // what was asked
  investigated: string;               // what was explored
  learned: string;                    // key insights
  completed: string;                  // what was finished
  nextSteps: string;                  // remaining work
  filesRead: string[];
  filesModified: string[];
}

export interface SmithMemory {
  agentId: string;
  agentLabel: string;
  role: string;
  observations: Observation[];
  sessions: SessionSummary[];
  lastUpdated: number;
  version: number;                    // schema version for migration
}

// ─── Constants ───────────────────────────────────────────

const WORKSPACES_ROOT = join(homedir(), '.forge', 'workspaces');
const MAX_OBSERVATIONS = 100;
const MAX_SESSIONS = 20;
const FULL_DETAIL_COUNT = 15;         // most recent N observations keep full detail
const SCHEMA_VERSION = 2;

const TYPE_ICONS: Record<ObservationType, string> = {
  decision: '🎯',
  bugfix: '🐛',
  feature: '✨',
  refactor: '♻️',
  discovery: '🔍',
  change: '📝',
};

// ─── Paths ───────────────────────────────────────────────

function memoryDir(workspaceId: string, agentId: string): string {
  return join(WORKSPACES_ROOT, workspaceId, 'agents', agentId);
}

function memoryFile(workspaceId: string, agentId: string): string {
  return join(memoryDir(workspaceId, agentId), 'memory.json');
}

// ─── CRUD ────────────────────────────────────────────────

export function loadMemory(workspaceId: string, agentId: string): SmithMemory | null {
  const file = memoryFile(workspaceId, agentId);
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, 'utf-8'));
    // Migrate from v1 if needed
    if (!raw.version || raw.version < SCHEMA_VERSION) {
      return migrateMemory(raw);
    }
    return raw;
  } catch {
    return null;
  }
}

export function saveMemory(workspaceId: string, agentId: string, memory: SmithMemory): void {
  const dir = memoryDir(workspaceId, agentId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(memoryFile(workspaceId, agentId), JSON.stringify(memory, null, 2), 'utf-8');
}

export function createMemory(agentId: string, agentLabel: string, role: string): SmithMemory {
  return {
    agentId,
    agentLabel,
    role,
    observations: [],
    sessions: [],
    lastUpdated: Date.now(),
    version: SCHEMA_VERSION,
  };
}

/** Migrate from v1 (entries-based) to v2 (observations + sessions) */
function migrateMemory(raw: any): SmithMemory {
  const observations: Observation[] = (raw.entries || []).map((e: any, i: number) => ({
    id: `migrated-${i}`,
    timestamp: e.timestamp || Date.now(),
    type: mapLegacyType(e.type),
    title: e.summary || '',
    filesModified: e.files,
    detail: e.details,
  }));
  return {
    agentId: raw.agentId || '',
    agentLabel: raw.agentLabel || '',
    role: raw.role || '',
    observations,
    sessions: [],
    lastUpdated: Date.now(),
    version: SCHEMA_VERSION,
  };
}

function mapLegacyType(t: string): ObservationType {
  const map: Record<string, ObservationType> = {
    task_completed: 'feature',
    artifact_produced: 'change',
    decision_made: 'decision',
    issue_found: 'bugfix',
    context_learned: 'discovery',
    update: 'change',
  };
  return map[t] || 'change';
}

// ─── Observation capture ─────────────────────────────────

/** Add a single observation after a step completes */
export function addObservation(
  workspaceId: string,
  agentId: string,
  agentLabel: string,
  role: string,
  obs: Omit<Observation, 'id' | 'timestamp'>,
): void {
  let memory = loadMemory(workspaceId, agentId) || createMemory(agentId, agentLabel, role);
  memory.agentLabel = agentLabel;
  memory.role = role;

  memory.observations.push({
    ...obs,
    id: `obs-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    timestamp: Date.now(),
  });

  // Prune: keep max observations, compact older ones
  pruneObservations(memory);

  memory.lastUpdated = Date.now();
  saveMemory(workspaceId, agentId, memory);
}

/** Add session summary when agent finishes all steps */
export function addSessionSummary(
  workspaceId: string,
  agentId: string,
  summary: Omit<SessionSummary, 'timestamp'>,
): void {
  let memory = loadMemory(workspaceId, agentId);
  if (!memory) return;

  memory.sessions.push({ ...summary, timestamp: Date.now() });

  // Keep bounded
  if (memory.sessions.length > MAX_SESSIONS) {
    memory.sessions = memory.sessions.slice(-MAX_SESSIONS);
  }

  memory.lastUpdated = Date.now();
  saveMemory(workspaceId, agentId, memory);
}

// ─── Progressive disclosure pruning ──────────────────────

function pruneObservations(memory: SmithMemory): void {
  if (memory.observations.length <= MAX_OBSERVATIONS) return;

  // Keep most recent MAX_OBSERVATIONS
  memory.observations = memory.observations.slice(-MAX_OBSERVATIONS);

  // Compact older entries: remove detail, keep title + type + files
  const compactBoundary = memory.observations.length - FULL_DETAIL_COUNT;
  for (let i = 0; i < compactBoundary; i++) {
    const obs = memory.observations[i];
    delete obs.detail;
    delete obs.subtitle;
    delete obs.facts;
    // Keep title, type, concepts, files — enough for context
  }
}

// ─── Format for injection into agent context ─────────────

export function formatMemoryForPrompt(memory: SmithMemory | null, maxTokenEstimate = 3000): string {
  if (!memory) return '';
  if (memory.observations.length === 0 && memory.sessions.length === 0) return '';

  const lines: string[] = [];
  lines.push(`## Smith Memory — ${memory.agentLabel}`);
  lines.push(`Role: ${memory.role}`);
  lines.push(`Memory entries: ${memory.observations.length} observations, ${memory.sessions.length} sessions\n`);

  // Last session summary (most important for continuity)
  const lastSession = memory.sessions[memory.sessions.length - 1];
  if (lastSession) {
    lines.push('### Last Session:');
    if (lastSession.request) lines.push(`- **Request:** ${lastSession.request}`);
    if (lastSession.completed) lines.push(`- **Completed:** ${lastSession.completed}`);
    if (lastSession.learned) lines.push(`- **Learned:** ${lastSession.learned}`);
    if (lastSession.nextSteps) lines.push(`- **Next steps:** ${lastSession.nextSteps}`);
    if (lastSession.filesModified.length > 0) {
      lines.push(`- **Files modified:** ${lastSession.filesModified.join(', ')}`);
    }
    lines.push('');
  }

  // Recent observations (full detail for FULL_DETAIL_COUNT, title-only for older)
  if (memory.observations.length > 0) {
    lines.push('### Recent Work:');

    const obs = memory.observations;
    const compactBoundary = Math.max(0, obs.length - FULL_DETAIL_COUNT);

    // Compact older entries (title only, grouped by type)
    if (compactBoundary > 0) {
      const older = obs.slice(0, compactBoundary);
      const byType = new Map<ObservationType, string[]>();
      for (const o of older) {
        if (!byType.has(o.type)) byType.set(o.type, []);
        byType.get(o.type)!.push(o.title);
      }
      for (const [type, titles] of byType) {
        lines.push(`${TYPE_ICONS[type]} **${type}** (${titles.length} earlier):`);
        // Show only last 3 titles per type to save tokens
        for (const t of titles.slice(-3)) {
          lines.push(`  - ${t}`);
        }
        if (titles.length > 3) lines.push(`  - ... and ${titles.length - 3} more`);
      }
      lines.push('');
    }

    // Recent entries with full detail
    const recent = obs.slice(compactBoundary);
    for (const o of recent) {
      const icon = TYPE_ICONS[o.type] || '📝';
      const time = new Date(o.timestamp).toLocaleString();
      let line = `${icon} **${o.title}**`;
      if (o.stepLabel) line += ` (${o.stepLabel})`;
      lines.push(line);
      if (o.subtitle) lines.push(`  ${o.subtitle}`);
      if (o.facts && o.facts.length > 0) {
        for (const f of o.facts) lines.push(`  - ${f}`);
      }
      if (o.filesModified && o.filesModified.length > 0) {
        lines.push(`  Files: ${o.filesModified.join(', ')}`);
      }
      if (o.detail) lines.push(`  ${o.detail}`);
    }
  }

  lines.push('\n---');
  lines.push('**Instructions:** Use this memory to work incrementally. Do NOT redo completed work unless explicitly asked. Focus on what is new or changed. Update your understanding based on the latest observations.');

  return lines.join('\n');
}

// ─── Format for UI display ───────────────────────────────

export interface MemoryDisplayEntry {
  id: string;
  timestamp: number;
  type: ObservationType | 'session';
  icon: string;
  title: string;
  subtitle?: string;
  facts?: string[];
  files?: string[];
  detail?: string;
  isCompact: boolean;
}

export function formatMemoryForDisplay(memory: SmithMemory | null): MemoryDisplayEntry[] {
  if (!memory) return [];

  const entries: MemoryDisplayEntry[] = [];

  // Add session summaries
  for (const s of memory.sessions) {
    entries.push({
      id: `session-${s.timestamp}`,
      timestamp: s.timestamp,
      type: 'session',
      icon: '📋',
      title: `Session: ${s.request || 'Work session'}`,
      subtitle: s.completed,
      facts: [
        s.learned && `Learned: ${s.learned}`,
        s.nextSteps && `Next: ${s.nextSteps}`,
      ].filter(Boolean) as string[],
      files: [...(s.filesRead || []), ...(s.filesModified || [])],
      isCompact: false,
    });
  }

  // Add observations
  const compactBoundary = Math.max(0, memory.observations.length - FULL_DETAIL_COUNT);
  for (let i = 0; i < memory.observations.length; i++) {
    const o = memory.observations[i];
    entries.push({
      id: o.id,
      timestamp: o.timestamp,
      type: o.type,
      icon: TYPE_ICONS[o.type] || '📝',
      title: o.title,
      subtitle: o.subtitle,
      facts: o.facts,
      files: [...(o.filesRead || []), ...(o.filesModified || [])],
      detail: o.detail,
      isCompact: i < compactBoundary,
    });
  }

  // Sort by timestamp descending (most recent first)
  entries.sort((a, b) => b.timestamp - a.timestamp);
  return entries;
}

// ─── Parse step result into observations ─────────────────

/**
 * Parse a step's output into structured observations.
 * Uses heuristic parsing (no LLM call needed).
 */
export function parseStepToObservations(
  stepLabel: string,
  stepResult: string,
  artifacts: { path?: string; summary?: string }[],
): Observation[] {
  const now = Date.now();
  const observations: Observation[] = [];
  const id = () => `obs-${now}-${Math.random().toString(36).slice(2, 6)}`;

  // Extract file references from result
  const filePatterns = stepResult.match(/(?:wrote|created|modified|updated|edited|added|deleted)\s+[`"]?([a-zA-Z0-9_\-./]+\.[a-zA-Z]+)[`"]?/gi) || [];
  const filesModified = [
    ...artifacts.filter(a => a.path).map(a => a.path!),
    ...filePatterns.map(m => {
      const match = m.match(/[`"]?([a-zA-Z0-9_\-./]+\.[a-zA-Z]+)[`"]?$/);
      return match ? match[1] : '';
    }).filter(Boolean),
  ];
  const uniqueFiles = [...new Set(filesModified)];

  // Detect observation type from content
  const lower = stepResult.toLowerCase();
  let type: ObservationType = 'change';
  if (lower.includes('fix') || lower.includes('bug') || lower.includes('error') || lower.includes('issue')) {
    type = 'bugfix';
  } else if (lower.includes('implement') || lower.includes('feature') || lower.includes('add') || lower.includes('create')) {
    type = 'feature';
  } else if (lower.includes('refactor') || lower.includes('restructur') || lower.includes('cleanup') || lower.includes('reorganiz')) {
    type = 'refactor';
  } else if (lower.includes('decide') || lower.includes('decision') || lower.includes('chose') || lower.includes('architecture')) {
    type = 'decision';
  } else if (lower.includes('discover') || lower.includes('found') || lower.includes('learn') || lower.includes('analyz') || lower.includes('review')) {
    type = 'discovery';
  }

  // Extract key sentences (first meaningful lines)
  const sentences = stepResult
    .split(/[.\n]/)
    .map(s => s.trim())
    .filter(s => s.length > 20 && s.length < 300)
    .slice(0, 5);

  const title = sentences[0]
    ? sentences[0].slice(0, 120)
    : `${stepLabel} completed`;

  observations.push({
    id: id(),
    timestamp: now,
    type,
    title,
    subtitle: sentences[1]?.slice(0, 150),
    stepLabel,
    facts: sentences.slice(1, 4).map(s => s.slice(0, 150)),
    filesModified: uniqueFiles.length > 0 ? uniqueFiles : undefined,
    detail: stepResult.length > 500 ? stepResult.slice(0, 500) + '...' : stepResult,
  });

  // Add separate artifact observations
  for (const artifact of artifacts) {
    if (artifact.path) {
      observations.push({
        id: id(),
        timestamp: now,
        type: 'change',
        title: `Produced ${artifact.path}`,
        subtitle: artifact.summary,
        stepLabel,
        filesModified: [artifact.path],
      });
    }
  }

  return observations;
}

/**
 * Build a session summary from all step results.
 */
export function buildSessionSummary(
  stepLabels: string[],
  stepResults: string[],
  allArtifacts: { path?: string }[],
): Omit<SessionSummary, 'timestamp'> {
  const allFiles = allArtifacts.filter(a => a.path).map(a => a.path!);
  const uniqueFiles = [...new Set(allFiles)];

  // Extract key info from results
  const allText = stepResults.join('\n\n');
  const sentences = allText
    .split(/[.\n]/)
    .map(s => s.trim())
    .filter(s => s.length > 20 && s.length < 300);

  // Simple heuristic extraction
  const request = `Execute steps: ${stepLabels.join(' → ')}`;
  const completed = sentences.slice(0, 3).join('. ') || `Completed ${stepLabels.length} steps`;
  const learned = sentences.find(s =>
    /learn|discover|found|realiz|understand|insight/i.test(s)
  ) || '';
  const nextSteps = sentences.find(s =>
    /next|todo|remaining|should|need to|follow.?up/i.test(s)
  ) || '';

  return {
    request,
    investigated: `Worked through ${stepLabels.length} steps`,
    learned: learned.slice(0, 200),
    completed: completed.slice(0, 300),
    nextSteps: nextSteps.slice(0, 200),
    filesRead: [],
    filesModified: uniqueFiles,
  };
}

// ─── API endpoint helper ─────────────────────────────────

/** Get memory stats for display */
export function getMemoryStats(memory: SmithMemory | null): {
  totalObservations: number;
  totalSessions: number;
  lastUpdated: number | null;
  typeBreakdown: Record<string, number>;
} {
  if (!memory) {
    return { totalObservations: 0, totalSessions: 0, lastUpdated: null, typeBreakdown: {} };
  }

  const typeBreakdown: Record<string, number> = {};
  for (const o of memory.observations) {
    typeBreakdown[o.type] = (typeBreakdown[o.type] || 0) + 1;
  }

  return {
    totalObservations: memory.observations.length,
    totalSessions: memory.sessions.length,
    lastUpdated: memory.lastUpdated,
    typeBreakdown,
  };
}
