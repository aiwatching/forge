// Per-project file storage at <project>/.forge/migration/

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import * as YAML from 'yaml';
import type { Endpoint, MigrationConfig, RunResult, Failure } from './types';
import { DEFAULT_CONFIG } from './types';

function migrationDir(projectPath: string): string {
  return join(projectPath, '.forge', 'migration');
}
function ensureDir(dir: string) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// ── Config ──────────────────────────────────────────────
export function loadConfig(projectPath: string): MigrationConfig {
  const file = join(migrationDir(projectPath), 'config.yaml');
  if (!existsSync(file)) return structuredClone(DEFAULT_CONFIG);
  try {
    const parsed = YAML.parse(readFileSync(file, 'utf8')) || {};
    return { ...DEFAULT_CONFIG, ...parsed,
      auth: { ...DEFAULT_CONFIG.auth, ...(parsed.auth || {}) },
      healthCheck: { ...DEFAULT_CONFIG.healthCheck, ...(parsed.healthCheck || {}) },
      endpointSource: { ...DEFAULT_CONFIG.endpointSource, ...(parsed.endpointSource || {}) },
      pathSubstitutions: { ...DEFAULT_CONFIG.pathSubstitutions, ...(parsed.pathSubstitutions || {}) },
    };
  } catch {
    return structuredClone(DEFAULT_CONFIG);
  }
}

export function saveConfig(projectPath: string, config: MigrationConfig): void {
  const dir = migrationDir(projectPath);
  ensureDir(dir);
  writeFileSync(join(dir, 'config.yaml'), YAML.stringify(config), 'utf8');
}

// ── Endpoints ───────────────────────────────────────────
export function loadEndpoints(projectPath: string): Endpoint[] {
  const file = join(migrationDir(projectPath), 'endpoints.json');
  if (!existsSync(file)) return [];
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return []; }
}

export function saveEndpoints(projectPath: string, endpoints: Endpoint[]): void {
  const dir = migrationDir(projectPath);
  ensureDir(dir);
  writeFileSync(join(dir, 'endpoints.json'), JSON.stringify(endpoints, null, 2), 'utf8');
}

// ── Runs ────────────────────────────────────────────────
export function saveRun(projectPath: string, results: RunResult[]): string {
  const runsDir = join(migrationDir(projectPath), 'runs');
  ensureDir(runsDir);
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const file = join(runsDir, `${ts}.json`);
  writeFileSync(file, JSON.stringify(results, null, 2), 'utf8');
  return file;
}

export function listRuns(projectPath: string): { name: string; path: string; mtime: number }[] {
  const runsDir = join(migrationDir(projectPath), 'runs');
  if (!existsSync(runsDir)) return [];
  return readdirSync(runsDir)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      const path = join(runsDir, f);
      return { name: f, path, mtime: 0 };
    });
}

export function loadRun(file: string): RunResult[] {
  if (!existsSync(file)) return [];
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return []; }
}

// ── Failures ────────────────────────────────────────────
export function saveFailures(projectPath: string, failures: Failure[]): void {
  const dir = join(migrationDir(projectPath), 'failures');
  ensureDir(dir);
  writeFileSync(join(dir, 'current.json'), JSON.stringify(failures, null, 2), 'utf8');
}

export function loadFailures(projectPath: string): Failure[] {
  const file = join(migrationDir(projectPath), 'failures', 'current.json');
  if (!existsSync(file)) return [];
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return []; }
}
