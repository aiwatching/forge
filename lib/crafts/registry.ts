// Craft marketplace — slim version of skills.ts.
//
// Mirrors the Forge skills marketplace pattern: a GitHub-hosted repo with
// `registry.json` at the root + per-craft folders containing the manifest
// and ui.tsx/server.ts. Default repo: aiwatching/forge-crafts. Override via
// settings.craftsRepoUrl.
//
// Install state for crafts is implicit (file-system): if
// <project>/.forge/crafts/<name>/ exists, it's installed. No DB rows needed.

import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import * as YAML from 'yaml';
import { loadSettings } from '../settings';
import type { CraftManifest, CraftRequirements } from './types';
import { matchesRequirements, listProjectCrafts } from './loader';

export interface RegistryEntry {
  name: string;
  displayName: string;
  description?: string;
  version: string;
  author?: string;
  tags?: string[];
  requires?: CraftRequirements;
  files: string[];                   // relative paths inside the craft dir on the registry
  sourceUrl?: string;                // GitHub web URL for browsing
}

export interface RegistryItem extends RegistryEntry {
  // Per-project install info (populated by listMarketplace for a given project)
  installed: boolean;
  installedVersion?: string;
  hasUpdate: boolean;
  compatible: boolean;               // requires gate against the project
}

function getBaseUrl(): string {
  const s = loadSettings();
  return (s as any).craftsRepoUrl || 'https://raw.githubusercontent.com/aiwatching/forge-crafts/main';
}

function compareVersions(a: string, b: string): number {
  const pa = (a || '0.0.0').split('.').map(Number);
  const pb = (b || '0.0.0').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

// ── Registry fetch ─────────────────────────────────────

let cachedRegistry: { fetchedAt: number; entries: RegistryEntry[] } | null = null;
const REGISTRY_TTL_MS = 5 * 60_000;

export async function fetchRegistry(force = false): Promise<RegistryEntry[]> {
  if (!force && cachedRegistry && Date.now() - cachedRegistry.fetchedAt < REGISTRY_TTL_MS) {
    return cachedRegistry.entries;
  }
  const baseUrl = getBaseUrl();
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10000);
    const res = await fetch(`${baseUrl}/registry.json?_t=${Date.now()}`, {
      signal: ctrl.signal,
      headers: { 'Accept': 'application/json', 'Cache-Control': 'no-cache' },
    });
    clearTimeout(t);
    if (!res.ok) {
      console.warn(`[craft-registry] fetch failed: ${res.status}`);
      return cachedRegistry?.entries || [];
    }
    const data = await res.json() as { crafts?: RegistryEntry[] };
    const entries = (data.crafts || []).filter(e => e.name && e.version && Array.isArray(e.files));
    cachedRegistry = { fetchedAt: Date.now(), entries };
    return entries;
  } catch (e) {
    console.warn('[craft-registry] fetch error', e);
    return cachedRegistry?.entries || [];
  }
}

// ── Per-project marketplace listing ────────────────────

export async function listMarketplace(projectPath: string): Promise<RegistryItem[]> {
  const [entries, projectCrafts] = await Promise.all([
    fetchRegistry(),
    Promise.resolve(listProjectCrafts(projectPath)),
  ]);
  const installedByName = new Map(projectCrafts.filter(c => c.__scope === 'project').map(c => [c.name, c]));

  return entries.map(e => {
    const inst = installedByName.get(e.name);
    const installedVersion = inst?.version;
    const hasUpdate = !!installedVersion && compareVersions(e.version, installedVersion) > 0;
    const compatible = e.requires ? matchesRequirements(e.requires, projectPath) : true;
    return {
      ...e,
      installed: !!inst,
      installedVersion,
      hasUpdate,
      compatible,
    };
  });
}

// ── Install / uninstall ────────────────────────────────

export async function installCraft(name: string, projectPath: string): Promise<{ ok: boolean; error?: string }> {
  const entries = await fetchRegistry();
  const entry = entries.find(e => e.name === name);
  if (!entry) return { ok: false, error: `craft "${name}" not in registry` };

  const baseUrl = getBaseUrl();
  const targetDir = join(projectPath, '.forge', 'crafts', name);
  if (existsSync(targetDir)) {
    return { ok: false, error: `craft "${name}" already installed at ${targetDir} (uninstall first to upgrade)` };
  }
  mkdirSync(targetDir, { recursive: true });
  mkdirSync(join(targetDir, 'data'), { recursive: true });

  for (const rel of entry.files) {
    try {
      const url = `${baseUrl}/${name}/${rel}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${url}: ${res.status}`);
      const text = await res.text();
      const dest = join(targetDir, rel);
      mkdirSync(join(dest, '..'), { recursive: true });
      writeFileSync(dest, text, 'utf8');
    } catch (e: any) {
      // Roll back partial install
      try { rmSync(targetDir, { recursive: true, force: true }); } catch {}
      return { ok: false, error: `download failed: ${e?.message || e}` };
    }
  }
  return { ok: true };
}

export function uninstallCraft(name: string, projectPath: string): { ok: boolean; error?: string } {
  const targetDir = join(projectPath, '.forge', 'crafts', name);
  if (!existsSync(targetDir)) return { ok: false, error: 'not installed' };
  rmSync(targetDir, { recursive: true, force: true });
  return { ok: true };
}

// ── Publish helper ─────────────────────────────────────
// MVP: returns a registry-entry JSON snippet + a tar of the craft dir for
// the user to attach to a PR on the registry repo. Real "press a button to
// publish" requires GitHub auth + write — out of scope for v1.

export function bundleCraftForPublish(projectPath: string, craftName: string): { entry: RegistryEntry; files: { path: string; content: string }[]; error?: string } {
  const dir = join(projectPath, '.forge', 'crafts', craftName);
  if (!existsSync(dir)) return { entry: null as any, files: [], error: 'craft not found' };

  let manifest: CraftManifest;
  try {
    manifest = YAML.parse(readFileSync(join(dir, 'craft.yaml'), 'utf8'));
  } catch {
    return { entry: null as any, files: [], error: 'craft.yaml unreadable' };
  }

  // Collect publishable files (non-data, non-prompt history)
  const files: { path: string; content: string }[] = [];
  const include = ['craft.yaml', 'ui.tsx', 'server.ts', 'README.md'];
  for (const f of include) {
    const fp = join(dir, f);
    if (existsSync(fp)) files.push({ path: f, content: readFileSync(fp, 'utf8') });
  }

  const entry: RegistryEntry = {
    name: manifest.name,
    displayName: manifest.displayName || manifest.name,
    description: manifest.description,
    version: manifest.version || '0.1.0',
    author: manifest.author,
    tags: manifest.tags,
    requires: manifest.requires,
    files: files.map(f => f.path),
  };
  return { entry, files };
}
