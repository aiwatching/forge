// Craft marketplace — slim version of skills.ts.
//
// Mirrors the Forge skills marketplace pattern: a GitHub-hosted repo with
// `registry.json` at the root + per-craft folders containing the manifest
// and ui.tsx/server.ts. Default repo: aiwatching/forge-crafts. Override via
// settings.craftsRepoUrl.
//
// Install state for crafts is implicit (file-system): if
// <project>/.forge/crafts/<name>/ exists, it's installed. No DB rows needed.

import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
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
// Short TTL — registry.json is tiny + GitHub Pages caches independently anyway.
// 5-minute cache used to leave users staring at stale data after their own
// publish landed; 30s is the right "barely noticeable but still saves repeat
// hits during a single UI session" balance.
const REGISTRY_TTL_MS = 30_000;

export function invalidateRegistry() {
  cachedRegistry = null;
}

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
  // Always pull fresh on install — user just clicked install, can't be stale.
  const entries = await fetchRegistry(true);
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
      const url = `${baseUrl}/${name}/${rel}?_t=${Date.now()}`;
      const res = await fetch(url, { headers: { 'Cache-Control': 'no-cache' } });
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

// In-place update — preserves <project>/.forge/crafts/<name>/data/ (which holds
// useStore JSON) and overwrites everything else. Atomic: downloads first, then
// writes; if any download fails the existing install is untouched.
export async function updateCraft(name: string, projectPath: string): Promise<{ ok: boolean; error?: string; from?: string; to?: string }> {
  const targetDir = join(projectPath, '.forge', 'crafts', name);
  if (!existsSync(targetDir)) return { ok: false, error: 'not installed' };

  const entries = await fetchRegistry(true);
  const entry = entries.find(e => e.name === name);
  if (!entry) return { ok: false, error: `craft "${name}" not in registry` };

  // Read current version from local craft.yaml for the response
  let fromVersion: string | undefined;
  try {
    const m = YAML.parse(readFileSync(join(targetDir, 'craft.yaml'), 'utf8')) as any;
    fromVersion = m?.version;
  } catch {}

  // Download everything into memory first
  const baseUrl = getBaseUrl();
  const downloaded: { rel: string; content: string }[] = [];
  for (const rel of entry.files) {
    try {
      const res = await fetch(`${baseUrl}/${name}/${rel}?_t=${Date.now()}`, { headers: { 'Cache-Control': 'no-cache' } });
      if (!res.ok) throw new Error(`${rel}: HTTP ${res.status}`);
      downloaded.push({ rel, content: await res.text() });
    } catch (e: any) {
      return { ok: false, error: `download failed for ${rel}: ${e?.message || e}` };
    }
  }

  // All downloads succeeded — write them. data/ stays intact.
  const fs = require('node:fs');
  for (const d of downloaded) {
    const dest = join(targetDir, d.rel);
    mkdirSync(dest.split('/').slice(0, -1).join('/'), { recursive: true });
    fs.writeFileSync(dest, d.content, 'utf8');
  }
  return { ok: true, from: fromVersion, to: entry.version };
}

// Returns just the names of installed crafts that have updates available.
// Used by the dropdown badge — cheap, no per-craft enrichment beyond version
// compare.
export async function listAvailableUpdates(projectPath: string): Promise<{ name: string; from?: string; to: string }[]> {
  const items = await listMarketplace(projectPath);
  return items
    .filter(it => it.installed && it.hasUpdate)
    .map(it => ({ name: it.name, from: it.installedVersion, to: it.version }));
}

// ── File scanner ───────────────────────────────────────

const EXCLUDE_DIRS = new Set(['data', '.git', 'node_modules', '.next', 'dist', 'build', '.cache']);
const EXCLUDE_FILES = new Set(['prompt.md', '.DS_Store']);
const INCLUDE_EXT = new Set(['.yaml', '.yml', '.tsx', '.ts', '.jsx', '.js', '.md', '.json', '.css']);
const MAX_FILE_BYTES = 1024 * 1024;   // 1 MB per file

function collectCraftFiles(dir: string): { path: string; content: string }[] {
  const out: { path: string; content: string }[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      if (name.startsWith('.') && name !== '.gitignore') continue;
      if (EXCLUDE_FILES.has(name)) continue;
      const full = join(d, name);
      const st = statSync(full);
      if (st.isDirectory()) {
        if (EXCLUDE_DIRS.has(name)) continue;
        walk(full);
        continue;
      }
      if (!st.isFile()) continue;
      if (st.size > MAX_FILE_BYTES) continue;
      const ext = name.lastIndexOf('.') >= 0 ? name.slice(name.lastIndexOf('.')) : '';
      if (ext && !INCLUDE_EXT.has(ext)) continue;
      out.push({ path: relative(dir, full), content: readFileSync(full, 'utf8') });
    }
  };
  walk(dir);
  return out;
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

  // Recursive scan — pick up arbitrary multi-file crafts (e.g. server.ts split
  // into _types.ts / _runner.ts / etc.) while excluding runtime data, history,
  // and anything obviously not source.
  const files = collectCraftFiles(dir);

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
