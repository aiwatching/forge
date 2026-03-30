/**
 * Project-level fixed session binding.
 * Stores { projectPath: sessionId } in ~/.forge/data/project-sessions.json
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { getDataDir } from '@/src/config';

function getFilePath(): string {
  const dir = getDataDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, 'project-sessions.json');
}

function loadAll(): Record<string, string> {
  const fp = getFilePath();
  if (!existsSync(fp)) return {};
  try { return JSON.parse(readFileSync(fp, 'utf-8')); } catch { return {}; }
}

function saveAll(data: Record<string, string>): void {
  writeFileSync(getFilePath(), JSON.stringify(data, null, 2));
}

/** Get the fixed session ID for a project */
export function getFixedSession(projectPath: string): string | undefined {
  return loadAll()[projectPath] || undefined;
}

/** Set the fixed session ID for a project */
export function setFixedSession(projectPath: string, sessionId: string): void {
  const data = loadAll();
  data[projectPath] = sessionId;
  saveAll(data);
}

/** Clear the fixed session for a project */
export function clearFixedSession(projectPath: string): void {
  const data = loadAll();
  delete data[projectPath];
  saveAll(data);
}

/** Get all bindings */
export function getAllFixedSessions(): Record<string, string> {
  return loadAll();
}
