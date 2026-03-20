/**
 * Skills & Commands marketplace — sync from registry, install/uninstall.
 *
 * Skills:   ~/.claude/skills/<name>/  (directory with SKILL.md + support files)
 * Commands: ~/.claude/commands/<name>.md  (single .md file)
 *
 * Install = download all files from GitHub repo directory → write to local.
 * No tar.gz — direct file sync via GitHub raw URLs.
 * Version tracking — compare registry version with installed version for update detection.
 */

import { getDb } from '@/src/core/db/database';
import { getDbPath } from '@/src/config';
import { loadSettings } from './settings';
import { existsSync, mkdirSync, writeFileSync, unlinkSync, readdirSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { getClaudeDir } from './dirs';

export type ItemType = 'skill' | 'command';

export interface SkillItem {
  name: string;
  type: ItemType;
  displayName: string;
  description: string;
  author: string;
  version: string;
  tags: string[];
  score: number;
  rating: number;       // 0-5 star rating from registry
  sourceUrl: string;
  installedGlobal: boolean;
  installedProjects: string[];
  installedVersion: string;  // version currently installed (empty if not installed)
  hasUpdate: boolean;         // true if registry version > installed version
}

function db() {
  return getDb(getDbPath());
}

const GLOBAL_SKILLS_DIR = join(getClaudeDir(), 'skills');
const GLOBAL_COMMANDS_DIR = join(getClaudeDir(), 'commands');

function getBaseUrl(): string {
  const settings = loadSettings();
  return settings.skillsRepoUrl || 'https://raw.githubusercontent.com/aiwatching/forge-skills/main';
}

function getRepoInfo(): string {
  const baseUrl = getBaseUrl();
  const match = baseUrl.match(/github\.com\/([^/]+\/[^/]+)/);
  return match ? match[1] : 'aiwatching/forge-skills';
}

// ─── Version comparison ──────────────────────────────────────

function compareVersions(a: string, b: string): number {
  const pa = (a || '0.0.0').split('.').map(Number);
  const pb = (b || '0.0.0').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Read installed version from info.json (skills) or return DB version (commands) */
function getInstalledVersion(name: string, type: string, basePath?: string): string {
  if (type === 'skill') {
    const dir = basePath
      ? join(basePath, '.claude', 'skills', name)
      : join(GLOBAL_SKILLS_DIR, name);
    const infoPath = join(dir, 'info.json');
    try {
      const info = JSON.parse(readFileSync(infoPath, 'utf-8'));
      return info.version || '';
    } catch { return ''; }
  }
  // Commands don't have version files — use DB installed_version
  const row = db().prepare('SELECT installed_version FROM skills WHERE name = ?').get(name) as any;
  return row?.installed_version || '';
}

// ─── Sync from registry ──────────────────────────────────────

export async function syncSkills(): Promise<{ synced: number; error?: string }> {
  const baseUrl = getBaseUrl();

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(`${baseUrl}/registry.json`, {
      signal: controller.signal,
      headers: { 'Accept': 'application/json' },
    });
    clearTimeout(timeout);

    if (!res.ok) return { synced: 0, error: `Registry fetch failed: ${res.status}` };

    const data = await res.json();

    // Support both v1 (flat skills array) and v2 (separate skills + commands)
    let items: any[] = [];
    if (data.version === 2) {
      const rawItems = [
        ...(data.skills || []).map((s: any) => ({ ...s, type: s.type || 'skill' })),
        ...(data.commands || []).map((c: any) => ({ ...c, type: c.type || 'command' })),
      ];
      // Always enrich from info.json for latest rating/score/version
      items = await Promise.all(rawItems.map(async (s: any) => {
        try {
          const repoDir = s.type === 'skill' ? 'skills' : 'commands';
          let infoRes = await fetch(`${baseUrl}/${repoDir}/${s.name}/info.json`, { signal: AbortSignal.timeout(5000) });
          if (!infoRes.ok) {
            const altDir = s.type === 'skill' ? 'commands' : 'skills';
            infoRes = await fetch(`${baseUrl}/${altDir}/${s.name}/info.json`, { signal: AbortSignal.timeout(5000) });
          }
          if (infoRes.ok) {
            const info = await infoRes.json();
            return {
              ...s,
              version: info.version || s.version,
              score: info.score ?? s.score ?? 0,
              rating: info.rating ?? s.rating ?? 0,
              description: info.description || s.description,
            };
          }
        } catch {}
        return s;
      }));
    } else {
      // v1: enrich from info.json in parallel
      const rawItems = data.skills || [];
      const enriched = await Promise.all(rawItems.map(async (s: any) => {
        // Fetch info.json for metadata and type
        try {
          let infoRes = await fetch(`${baseUrl}/skills/${s.name}/info.json`, { signal: AbortSignal.timeout(5000) });
          if (!infoRes.ok) {
            infoRes = await fetch(`${baseUrl}/commands/${s.name}/info.json`, { signal: AbortSignal.timeout(5000) });
          }
          if (infoRes.ok) {
            const info = await infoRes.json();
            return {
              ...s,
              type: info.type || s.type || 'command',
              display_name: info.display_name || s.display_name,
              description: info.description || s.description,
              version: info.version || s.version,
              tags: info.tags || s.tags,
              score: info.score ?? s.score,
              rating: info.rating ?? s.rating ?? 0,
            };
          }
        } catch {}
        return { ...s, type: s.type || 'command' };
      }));
      items = enriched;
    }

    const stmt = db().prepare(`
      INSERT OR REPLACE INTO skills (name, type, display_name, description, author, version, tags, score, rating, source_url, archive, synced_at,
        installed_global, installed_projects, installed_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'),
        COALESCE((SELECT installed_global FROM skills WHERE name = ?), 0),
        COALESCE((SELECT installed_projects FROM skills WHERE name = ?), '[]'),
        COALESCE((SELECT installed_version FROM skills WHERE name = ?), ''))
    `);

    const tx = db().transaction(() => {
      for (const s of items) {
        stmt.run(
          s.name, s.type || 'skill',
          s.display_name, s.description || '',
          s.author?.name || '', s.version || '', JSON.stringify(s.tags || []),
          s.score || 0, s.rating || 0, s.source?.url || '',
          '', // archive field (unused now, kept for compat)
          s.name, s.name, s.name
        );
      }
    });
    tx();

    // Remove items no longer in registry (not installed locally)
    const registryNames = new Set(items.map(s => s.name));
    const dbItems = db().prepare('SELECT name, installed_global, installed_projects FROM skills').all() as any[];
    for (const row of dbItems) {
      if (!registryNames.has(row.name)) {
        const hasLocal = !!row.installed_global || JSON.parse(row.installed_projects || '[]').length > 0;
        if (!hasLocal) {
          db().prepare('DELETE FROM skills WHERE name = ?').run(row.name);
        }
      }
    }

    return { synced: items.length };
  } catch (e) {
    return { synced: 0, error: e instanceof Error ? e.message : String(e) };
  }
}

// ─── List ────────────────────────────────────────────────────

export function listSkills(): SkillItem[] {
  const rows = db().prepare('SELECT * FROM skills ORDER BY type ASC, score DESC, display_name ASC').all() as any[];
  return rows.map(r => {
    const installedVersion = r.installed_version || '';
    const registryVersion = r.version || '';
    const isInstalled = !!r.installed_global || JSON.parse(r.installed_projects || '[]').length > 0;
    return {
      name: r.name,
      type: r.type || 'skill',
      displayName: r.display_name,
      description: r.description,
      author: r.author,
      version: registryVersion,
      tags: JSON.parse(r.tags || '[]'),
      score: r.score,
      rating: r.rating || 0,
      sourceUrl: r.source_url,
      installedGlobal: !!r.installed_global,
      installedProjects: JSON.parse(r.installed_projects || '[]'),
      installedVersion,
      hasUpdate: isInstalled && !!registryVersion && !!installedVersion && compareVersions(registryVersion, installedVersion) > 0,
    };
  });
}

// ─── Download directory from GitHub ──────────────────────────

/** Recursively list all files in a skill/command directory via GitHub API */
async function listRepoFiles(name: string, type: ItemType): Promise<{ path: string; download_url: string }[]> {
  const repo = getRepoInfo();
  const files: { path: string; download_url: string }[] = [];

  async function recurse(apiUrl: string, prefix: string) {
    const res = await fetch(apiUrl, {
      headers: { 'Accept': 'application/vnd.github.v3+json' },
    });
    if (!res.ok) return;
    const items = await res.json();
    if (!Array.isArray(items)) return;

    for (const item of items) {
      const relPath = prefix ? `${prefix}/${item.name}` : item.name;
      if (item.type === 'file') {
        files.push({ path: relPath, download_url: item.download_url });
      } else if (item.type === 'dir') {
        await recurse(item.url, relPath);
      }
    }
  }

  // Try skills/ first, then commands/
  await recurse(`https://api.github.com/repos/${repo}/contents/skills/${name}`, '');
  if (files.length === 0) {
    await recurse(`https://api.github.com/repos/${repo}/contents/commands/${name}`, '');
  }
  return files;
}

/** Download all files to a local directory */
async function downloadToDir(files: { path: string; download_url: string }[], destDir: string): Promise<void> {
  if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true });

  for (const file of files) {
    const filePath = join(destDir, file.path);
    const fileDir = join(destDir, file.path.split('/').slice(0, -1).join('/'));
    if (fileDir !== destDir && !existsSync(fileDir)) mkdirSync(fileDir, { recursive: true });

    const res = await fetch(file.download_url);
    if (!res.ok) continue;
    const content = await res.text();
    writeFileSync(filePath, content, 'utf-8');
  }
}

// ─── Install ─────────────────────────────────────────────────

export async function installGlobal(name: string): Promise<void> {
  const row = db().prepare('SELECT type, version FROM skills WHERE name = ?').get(name) as any;
  if (!row) throw new Error(`Not found: ${name}`);
  const type: ItemType = row.type || 'skill';
  const version = row.version || '';

  const files = await listRepoFiles(name, type);

  if (type === 'skill') {
    const dest = join(GLOBAL_SKILLS_DIR, name);
    if (existsSync(dest)) rmSync(dest, { recursive: true });
    await downloadToDir(files, dest);
  } else {
    // Command: download all files to commands/<name>/ directory
    // If only a single .md, also copy as <name>.md directly for slash command registration
    const dest = join(GLOBAL_COMMANDS_DIR);
    if (!existsSync(dest)) mkdirSync(dest, { recursive: true });
    const mdFiles = files.filter(f => f.path.endsWith('.md') && f.path !== 'info.json');
    if (mdFiles.length === 1 && files.filter(f => f.path !== 'info.json').length === 1) {
      // Single .md command — write directly as <name>.md
      const res = await fetch(mdFiles[0].download_url);
      if (res.ok) writeFileSync(join(dest, `${name}.md`), await res.text(), 'utf-8');
    } else {
      // Multi-file command — copy all files (except info.json) to commands/<name>/
      const cmdDir = join(dest, name);
      if (existsSync(cmdDir)) rmSync(cmdDir, { recursive: true });
      const nonInfo = files.filter(f => f.path !== 'info.json');
      await downloadToDir(nonInfo, cmdDir);
    }
  }

  db().prepare('UPDATE skills SET installed_global = 1, installed_version = ? WHERE name = ?').run(version, name);
}

export async function installProject(name: string, projectPath: string): Promise<void> {
  const row = db().prepare('SELECT type, version FROM skills WHERE name = ?').get(name) as any;
  if (!row) throw new Error(`Not found: ${name}`);
  const type: ItemType = row.type || 'skill';
  const version = row.version || '';

  const files = await listRepoFiles(name, type);

  if (type === 'skill') {
    const dest = join(projectPath, '.claude', 'skills', name);
    if (existsSync(dest)) rmSync(dest, { recursive: true });
    await downloadToDir(files, dest);
  } else {
    const cmdDir = join(projectPath, '.claude', 'commands');
    if (!existsSync(cmdDir)) mkdirSync(cmdDir, { recursive: true });
    const mdFiles = files.filter(f => f.path.endsWith('.md') && f.path !== 'info.json');
    if (mdFiles.length === 1 && files.filter(f => f.path !== 'info.json').length === 1) {
      const res = await fetch(mdFiles[0].download_url);
      if (res.ok) writeFileSync(join(cmdDir, `${name}.md`), await res.text(), 'utf-8');
    } else {
      const subDir = join(cmdDir, name);
      if (existsSync(subDir)) rmSync(subDir, { recursive: true });
      const nonInfo = files.filter(f => f.path !== 'info.json');
      await downloadToDir(nonInfo, subDir);
    }
  }

  // Update installed_projects + version
  const current = db().prepare('SELECT installed_projects FROM skills WHERE name = ?').get(name) as any;
  const projects: string[] = JSON.parse(current?.installed_projects || '[]');
  if (!projects.includes(projectPath)) {
    projects.push(projectPath);
  }
  db().prepare('UPDATE skills SET installed_projects = ?, installed_version = ? WHERE name = ?')
    .run(JSON.stringify(projects), version, name);
}

// ─── Uninstall ───────────────────────────────────────────────

export function uninstallGlobal(name: string): void {
  // Remove from all possible locations
  try { rmSync(join(GLOBAL_SKILLS_DIR, name), { recursive: true }); } catch {}
  try { unlinkSync(join(GLOBAL_COMMANDS_DIR, `${name}.md`)); } catch {}
  try { rmSync(join(GLOBAL_COMMANDS_DIR, name), { recursive: true }); } catch {}

  db().prepare('UPDATE skills SET installed_global = 0, installed_version = ? WHERE name = ?')
    .run('', name);
}

export function uninstallProject(name: string, projectPath: string): void {
  // Remove from all possible locations
  try { rmSync(join(projectPath, '.claude', 'skills', name), { recursive: true }); } catch {}
  try { unlinkSync(join(projectPath, '.claude', 'commands', `${name}.md`)); } catch {}
  try { rmSync(join(projectPath, '.claude', 'commands', name), { recursive: true }); } catch {}

  const current = db().prepare('SELECT installed_projects FROM skills WHERE name = ?').get(name) as any;
  const projects: string[] = JSON.parse(current?.installed_projects || '[]');
  const updated = projects.filter(p => p !== projectPath);
  db().prepare('UPDATE skills SET installed_projects = ? WHERE name = ?').run(JSON.stringify(updated), name);
  // Clear installed_version if no longer installed anywhere
  if (updated.length === 0) {
    const row2 = db().prepare('SELECT installed_global FROM skills WHERE name = ?').get(name) as any;
    if (!row2?.installed_global) {
      db().prepare('UPDATE skills SET installed_version = ? WHERE name = ?').run('', name);
    }
  }
}

// ─── Scan installed state from filesystem ────────────────────

export function refreshInstallState(projectPaths: string[]): void {
  const items = db().prepare('SELECT name, type FROM skills').all() as { name: string; type: string }[];

  for (const { name, type } of items) {
    let globalInstalled = false;
    let installedVersion = '';

    // Check BOTH locations — skill dir and command file/dir
    const skillDir = join(GLOBAL_SKILLS_DIR, name);
    const cmdFile = join(GLOBAL_COMMANDS_DIR, `${name}.md`);
    const cmdDir = join(GLOBAL_COMMANDS_DIR, name);

    if (existsSync(skillDir)) {
      globalInstalled = true;
      installedVersion = getInstalledVersion(name, 'skill');
    } else if (existsSync(cmdFile)) {
      globalInstalled = true;
    } else if (existsSync(cmdDir)) {
      globalInstalled = true;
    }

    const installedIn: string[] = [];
    for (const pp of projectPaths) {
      // Check all possible install locations for this project
      const projSkillDir = join(pp, '.claude', 'skills', name);
      const projCmdFile = join(pp, '.claude', 'commands', `${name}.md`);
      const projCmdDir = join(pp, '.claude', 'commands', name);
      if (existsSync(projSkillDir) || existsSync(projCmdFile) || existsSync(projCmdDir)) {
        installedIn.push(pp);
      }
    }

    db().prepare('UPDATE skills SET installed_global = ?, installed_projects = ?, installed_version = CASE WHEN ? != \'\' THEN ? ELSE installed_version END WHERE name = ?')
      .run(globalInstalled ? 1 : 0, JSON.stringify(installedIn), installedVersion, installedVersion, name);
  }
}

// ─── Check local modifications ───────────────────────────────

/** Compare local installed files against remote. Returns true if any file was locally modified. */
export async function checkLocalModified(name: string): Promise<boolean> {
  const row = db().prepare('SELECT type FROM skills WHERE name = ?').get(name) as any;
  if (!row) return false;
  const type: ItemType = row.type || 'command';

  // Get remote file list
  const remoteFiles = await listRepoFiles(name, type);

  // Compare each file
  for (const rf of remoteFiles) {
    if (rf.path === 'info.json') continue; // skip metadata

    let localPath: string;
    if (type === 'skill') {
      localPath = join(GLOBAL_SKILLS_DIR, name, rf.path);
    } else {
      // Single file command
      const cmdFile = join(GLOBAL_COMMANDS_DIR, `${name}.md`);
      const cmdDir = join(GLOBAL_COMMANDS_DIR, name);
      if (existsSync(cmdDir)) {
        localPath = join(cmdDir, rf.path);
      } else {
        localPath = cmdFile;
      }
    }

    if (!existsSync(localPath)) continue;
    const localContent = readFileSync(localPath, 'utf-8');

    // Fetch remote content
    try {
      const res = await fetch(rf.download_url);
      if (!res.ok) continue;
      const remoteContent = await res.text();
      const localHash = createHash('md5').update(localContent).digest('hex');
      const remoteHash = createHash('md5').update(remoteContent).digest('hex');
      if (localHash !== remoteHash) return true;
    } catch { continue; }
  }

  return false;
}

// ─── Local-to-local install (copy between projects/global) ───

/** Recursively copy a directory */
function copyDir(src: string, dest: string): void {
  if (!existsSync(dest)) mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      writeFileSync(destPath, readFileSync(srcPath));
    }
  }
}

/** Resolve the source path for a local skill/command */
function resolveLocalSource(name: string, type: string, sourceProject?: string): string | null {
  const base = sourceProject ? join(sourceProject, '.claude') : join(getClaudeDir());
  if (type === 'skill') {
    const dir = join(base, 'skills', name);
    if (existsSync(dir)) return dir;
  } else {
    const file = join(base, 'commands', `${name}.md`);
    if (existsSync(file)) return file;
    const dir = join(base, 'commands', name);
    if (existsSync(dir)) return dir;
  }
  return null;
}

/** Install a local skill/command to a target (global or project path). Force=overwrite existing. */
export function installLocal(name: string, type: string, sourceProject: string | undefined, target: string, force?: boolean): { ok: boolean; error?: string } {
  const src = resolveLocalSource(name, type, sourceProject);
  if (!src) return { ok: false, error: 'Source not found' };

  const isGlobal = target === 'global';
  const isFile = !existsSync(src) ? false : require('node:fs').statSync(src).isFile();

  if (type === 'skill') {
    const dest = isGlobal
      ? join(GLOBAL_SKILLS_DIR, name)
      : join(target, '.claude', 'skills', name);
    if (existsSync(dest) && !force) return { ok: false, error: 'Already installed. Use force to overwrite.' };
    if (existsSync(dest)) rmSync(dest, { recursive: true });
    copyDir(src, dest);
  } else {
    const destBase = isGlobal ? GLOBAL_COMMANDS_DIR : join(target, '.claude', 'commands');
    if (!existsSync(destBase)) mkdirSync(destBase, { recursive: true });
    if (isFile) {
      const destFile = join(destBase, `${name}.md`);
      if (existsSync(destFile) && !force) return { ok: false, error: 'Already installed. Use force to overwrite.' };
      writeFileSync(destFile, readFileSync(src));
    } else {
      const dest = join(destBase, name);
      if (existsSync(dest) && !force) return { ok: false, error: 'Already installed. Use force to overwrite.' };
      if (existsSync(dest)) rmSync(dest, { recursive: true });
      copyDir(src, dest);
    }
  }

  return { ok: true };
}

/** Delete a local skill/command from a specific project or global */
export function deleteLocal(name: string, type: string, projectPath?: string): boolean {
  const base = projectPath ? join(projectPath, '.claude') : getClaudeDir();
  if (type === 'skill') {
    const dir = join(base, 'skills', name);
    try { rmSync(dir, { recursive: true }); return true; } catch { return false; }
  } else {
    // Try file first, then directory
    const file = join(base, 'commands', `${name}.md`);
    const dir = join(base, 'commands', name);
    let deleted = false;
    try { unlinkSync(file); deleted = true; } catch {}
    try { rmSync(dir, { recursive: true }); deleted = true; } catch {}
    return deleted;
  }
}
