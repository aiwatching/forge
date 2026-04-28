// Per-endpoint annotations stored at <project>/.forge/migration/annotations.json

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Annotation } from './types';

function annotationsFile(projectPath: string): string {
  return join(projectPath, '.forge', 'migration', 'annotations.json');
}

export function loadAnnotations(projectPath: string): Record<string, Annotation> {
  const f = annotationsFile(projectPath);
  if (!existsSync(f)) return {};
  try {
    const raw = JSON.parse(readFileSync(f, 'utf8'));
    if (Array.isArray(raw)) {
      // Migrate old array format → keyed map
      const out: Record<string, Annotation> = {};
      for (const a of raw) if (a?.endpointId) out[a.endpointId] = a;
      return out;
    }
    return raw || {};
  } catch {
    return {};
  }
}

export function saveAnnotations(projectPath: string, all: Record<string, Annotation>): void {
  const f = annotationsFile(projectPath);
  const dir = join(projectPath, '.forge', 'migration');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(f, JSON.stringify(all, null, 2), 'utf8');
}

export function upsertAnnotation(projectPath: string, ann: Annotation): void {
  const all = loadAnnotations(projectPath);
  all[ann.endpointId] = { ...ann, flaggedAt: ann.flaggedAt || new Date().toISOString() };
  saveAnnotations(projectPath, all);
}

export function removeAnnotation(projectPath: string, endpointId: string): void {
  const all = loadAnnotations(projectPath);
  if (all[endpointId]) {
    delete all[endpointId];
    saveAnnotations(projectPath, all);
  }
}

export function getAnnotation(projectPath: string, endpointId: string): Annotation | null {
  return loadAnnotations(projectPath)[endpointId] || null;
}
