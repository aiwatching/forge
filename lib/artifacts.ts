/**
 * Artifact system — structured data passing between delivery agents.
 * Each artifact is a named document (requirements, architecture, test-plan, etc.)
 * stored as a separate JSON file for lazy loading.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getDataDir } from './dirs';

export type ArtifactType = 'requirements' | 'architecture' | 'test-plan' | 'code-diff' | 'review-report' | 'custom';

export interface Artifact {
  id: string;
  deliveryId: string;
  type: ArtifactType;
  name: string;          // e.g., "requirements.md"
  content: string;
  producedBy: string;    // phase name or 'user'
  consumedBy: string[];  // phases that consumed this
  createdAt: string;
}

function artifactsDir(deliveryId: string): string {
  const dir = join(getDataDir(), 'deliveries', deliveryId, 'artifacts');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function createArtifact(deliveryId: string, opts: {
  type: ArtifactType;
  name: string;
  content: string;
  producedBy: string;
}): Artifact {
  const id = randomUUID().slice(0, 8);
  const artifact: Artifact = {
    id,
    deliveryId,
    type: opts.type,
    name: opts.name,
    content: opts.content,
    producedBy: opts.producedBy,
    consumedBy: [],
    createdAt: new Date().toISOString(),
  };
  writeFileSync(join(artifactsDir(deliveryId), `${id}.json`), JSON.stringify(artifact, null, 2));
  return artifact;
}

export function getArtifact(deliveryId: string, id: string): Artifact | null {
  try {
    return JSON.parse(readFileSync(join(artifactsDir(deliveryId), `${id}.json`), 'utf-8'));
  } catch { return null; }
}

export function listArtifacts(deliveryId: string): Artifact[] {
  const dir = artifactsDir(deliveryId);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try { return JSON.parse(readFileSync(join(dir, f), 'utf-8')) as Artifact; } catch { return null; }
    })
    .filter(Boolean) as Artifact[];
}

export function deleteArtifact(deliveryId: string, id: string): void {
  try { unlinkSync(join(artifactsDir(deliveryId), `${id}.json`)); } catch {}
}

/** Extract artifacts from agent output using ===ARTIFACT:name=== markers */
export function extractArtifacts(output: string, deliveryId: string, producedBy: string): Artifact[] {
  const artifacts: Artifact[] = [];
  const regex = /===ARTIFACT:([\w.-]+)===\n([\s\S]*?)(?=\n===ARTIFACT:|$)/g;
  let match;

  while ((match = regex.exec(output)) !== null) {
    const name = match[1];
    const content = match[2].trim();
    if (!content) continue;

    // Infer type from name
    let type: ArtifactType = 'custom';
    if (name.includes('requirement')) type = 'requirements';
    else if (name.includes('architect') || name.includes('design')) type = 'architecture';
    else if (name.includes('test')) type = 'test-plan';
    else if (name.includes('review')) type = 'review-report';
    else if (name.includes('diff')) type = 'code-diff';

    artifacts.push(createArtifact(deliveryId, { type, name, content, producedBy }));
  }

  // Fallback: if no markers found, don't create any artifact — let the engine decide
  return artifacts;
}

/** Write artifact content to the project directory */
export function writeArtifactToProject(artifact: Artifact, projectPath: string, subDir = '.forge-delivery'): string {
  const dir = join(projectPath, subDir);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const filePath = join(dir, artifact.name);
  writeFileSync(filePath, artifact.content, 'utf-8');
  return filePath;
}
