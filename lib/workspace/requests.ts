/**
 * Request/Response Document System — structured YAML documents for
 * multi-agent delivery workflows.
 *
 * Storage layout:
 *   <project>/.forge/requests/<id>/
 *     ├── request.yml    — created by Architect
 *     └── response.yml   — updated by Engineer, Reviewer, QA
 *
 * Inspired by Accord protocol: YAML frontmatter + structured content,
 * status lifecycle (open → in_progress → review → qa → done).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';

// ─── Types ──────────────────────────────────────────────

export type RequestStatus = 'open' | 'in_progress' | 'review' | 'qa' | 'done' | 'rejected';
export type RequestPriority = 'high' | 'medium' | 'low';
export type RequestType = 'feature' | 'bugfix' | 'refactor' | 'task';

export interface RequestModule {
  name: string;
  description: string;
  acceptance_criteria: string[];
}

export interface RequestDocument {
  id: string;
  batch: string;                    // groups requests into a delivery
  title: string;
  description: string;
  type: RequestType;
  modules: RequestModule[];
  priority: RequestPriority;
  status: RequestStatus;
  assigned_to: string;              // agent label
  created_by: string;               // agent label
  created_at: string;               // ISO timestamp
  updated_at: string;
}

export interface EngineerResponse {
  completed_at?: string;
  files_changed: string[];
  notes: string;
}

export interface ReviewResponse {
  completed_at?: string;
  result: 'approved' | 'changes_requested' | 'rejected';
  findings: Array<{ severity: string; description: string }>;
}

export interface QaResponse {
  completed_at?: string;
  result: 'passed' | 'failed';
  test_files: string[];
  findings: Array<{ severity: string; description: string }>;
}

export interface ResponseDocument {
  request_id: string;
  status: RequestStatus;
  engineer?: EngineerResponse;
  review?: ReviewResponse;
  qa?: QaResponse;
}

// ─── Paths ──────────────────────────────────────────────

function requestsRoot(projectPath: string): string {
  return join(projectPath, '.forge', 'requests');
}

function requestDir(projectPath: string, requestId: string): string {
  return join(requestsRoot(projectPath), requestId);
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// ─── CRUD ───────────────────────────────────────────────

/**
 * Generate a request ID: REQ-YYYYMMDD-NNN
 */
export function generateRequestId(projectPath: string): string {
  const now = new Date();
  const date = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  const root = requestsRoot(projectPath);
  if (!existsSync(root)) return `REQ-${date}-001`;
  const existing = readdirSync(root).filter(f => f.startsWith(`REQ-${date}-`));
  const num = existing.length + 1;
  return `REQ-${date}-${String(num).padStart(3, '0')}`;
}

/**
 * Create a new request document.
 * Returns the relative path to request.yml (for use as ref in bus messages).
 */
export function createRequest(projectPath: string, doc: Omit<RequestDocument, 'id' | 'created_at' | 'updated_at'> & { id?: string }): string {
  const id = doc.id || generateRequestId(projectPath);
  const dir = requestDir(projectPath, id);
  ensureDir(dir);

  const now = new Date().toISOString();
  const full: RequestDocument = {
    ...doc,
    id,
    status: doc.status || 'open',
    created_at: now,
    updated_at: now,
  };

  const filePath = join(dir, 'request.yml');
  writeFileSync(filePath, YAML.stringify(full), 'utf-8');
  console.log(`[requests] Created ${id}: ${doc.title}`);

  // Return relative path for bus ref
  return `.forge/requests/${id}/request.yml`;
}

/**
 * Get a request and its optional response.
 */
export function getRequest(projectPath: string, requestId: string): { request: RequestDocument; response?: ResponseDocument } | null {
  const dir = requestDir(projectPath, requestId);
  const reqFile = join(dir, 'request.yml');
  if (!existsSync(reqFile)) return null;

  try {
    const request: RequestDocument = YAML.parse(readFileSync(reqFile, 'utf-8'));
    let response: ResponseDocument | undefined;
    const resFile = join(dir, 'response.yml');
    if (existsSync(resFile)) {
      response = YAML.parse(readFileSync(resFile, 'utf-8'));
    }
    return { request, response };
  } catch (err: any) {
    console.error(`[requests] Failed to read ${requestId}: ${err.message}`);
    return null;
  }
}

/**
 * List all requests, optionally filtered by batch or status.
 */
export function listRequests(projectPath: string, opts?: { batch?: string; status?: RequestStatus }): RequestDocument[] {
  const root = requestsRoot(projectPath);
  if (!existsSync(root)) return [];

  const results: RequestDocument[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const reqFile = join(root, entry.name, 'request.yml');
    if (!existsSync(reqFile)) continue;
    try {
      const doc: RequestDocument = YAML.parse(readFileSync(reqFile, 'utf-8'));
      if (opts?.batch && doc.batch !== opts.batch) continue;
      if (opts?.status && doc.status !== opts.status) continue;
      results.push(doc);
    } catch {}
  }

  return results.sort((a, b) => a.created_at.localeCompare(b.created_at));
}

/**
 * Update a response document section (engineer, review, or qa).
 * Automatically advances request status:
 *   engineer → review, review(approved) → qa, qa(passed) → done
 * Returns the relative path to response.yml.
 */
export function updateResponse(
  projectPath: string,
  requestId: string,
  section: 'engineer' | 'review' | 'qa',
  data: Record<string, any>,
): string {
  const dir = requestDir(projectPath, requestId);
  const reqFile = join(dir, 'request.yml');
  if (!existsSync(reqFile)) throw new Error(`Request ${requestId} not found`);

  ensureDir(dir);
  const resFile = join(dir, 'response.yml');

  // Load or create response
  let response: ResponseDocument;
  if (existsSync(resFile)) {
    response = YAML.parse(readFileSync(resFile, 'utf-8'));
  } else {
    response = { request_id: requestId, status: 'in_progress' };
  }

  // Update section with timestamp
  const now = new Date().toISOString();
  (response as any)[section] = { ...data, completed_at: now };

  // Auto-advance status
  const request: RequestDocument = YAML.parse(readFileSync(reqFile, 'utf-8'));
  let newStatus: RequestStatus = request.status;

  if (section === 'engineer') {
    newStatus = 'review';
  } else if (section === 'review') {
    newStatus = data.result === 'rejected' ? 'rejected' : data.result === 'changes_requested' ? 'in_progress' : 'qa';
  } else if (section === 'qa') {
    newStatus = data.result === 'passed' ? 'done' : 'in_progress'; // failed → back to engineer
  }

  response.status = newStatus;
  request.status = newStatus;
  request.updated_at = now;

  // Write both files
  writeFileSync(resFile, YAML.stringify(response), 'utf-8');
  writeFileSync(reqFile, YAML.stringify(request), 'utf-8');

  console.log(`[requests] ${requestId}: ${section} updated → status=${newStatus}`);
  return `.forge/requests/${requestId}/response.yml`;
}

/**
 * Manually update request status.
 */
export function updateRequestStatus(projectPath: string, requestId: string, status: RequestStatus): void {
  const dir = requestDir(projectPath, requestId);
  const reqFile = join(dir, 'request.yml');
  if (!existsSync(reqFile)) throw new Error(`Request ${requestId} not found`);

  const doc: RequestDocument = YAML.parse(readFileSync(reqFile, 'utf-8'));
  doc.status = status;
  doc.updated_at = new Date().toISOString();
  writeFileSync(reqFile, YAML.stringify(doc), 'utf-8');
}

/**
 * Get batch completion status.
 */
export function getBatchStatus(projectPath: string, batch: string): { total: number; done: number; allDone: boolean; requests: Array<{ id: string; title: string; status: RequestStatus }> } {
  const all = listRequests(projectPath, { batch });
  const done = all.filter(r => r.status === 'done' || r.status === 'rejected').length;
  return {
    total: all.length,
    done,
    allDone: all.length > 0 && done === all.length,
    requests: all.map(r => ({ id: r.id, title: r.title, status: r.status })),
  };
}
