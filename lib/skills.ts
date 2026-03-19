/**
 * Skills management — sync from registry, install/uninstall to local.
 *
 * Global install: ~/.claude/commands/<name>.md
 * Project install: <projectPath>/.claude/commands/<name>.md
 */

import { getDb } from '@/src/core/db/database';
import { getDbPath } from '@/src/config';
import { loadSettings } from './settings';
import { existsSync, mkdirSync, writeFileSync, unlinkSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

export interface Skill {
  name: string;
  displayName: string;
  description: string;
  author: string;
  version: string;
  tags: string[];
  score: number;
  sourceUrl: string;
  installedGlobal: boolean;
  installedProjects: string[]; // project paths where installed
}

function db() {
  return getDb(getDbPath());
}

const GLOBAL_COMMANDS_DIR = join(homedir(), '.claude', 'commands');

function projectCommandsDir(projectPath: string): string {
  return join(projectPath, '.claude', 'commands');
}

// ─── Sync from registry ──────────────────────────────────────

export async function syncSkills(): Promise<{ synced: number; error?: string }> {
  const settings = loadSettings();
  const baseUrl = settings.skillsRepoUrl || 'https://raw.githubusercontent.com/aiwatching/forge-skills/main';

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
    const skills = data.skills || [];

    const stmt = db().prepare(`
      INSERT OR REPLACE INTO skills (name, display_name, description, author, version, tags, score, source_url, synced_at,
        installed_global, installed_projects, skill_content)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'),
        COALESCE((SELECT installed_global FROM skills WHERE name = ?), 0),
        COALESCE((SELECT installed_projects FROM skills WHERE name = ?), '[]'),
        COALESCE((SELECT skill_content FROM skills WHERE name = ?), NULL))
    `);

    const tx = db().transaction(() => {
      for (const s of skills) {
        stmt.run(
          s.name, s.display_name, s.description || '',
          s.author?.name || '', s.version || '', JSON.stringify(s.tags || []),
          s.score || 0, s.source?.url || '',
          s.name, s.name, s.name
        );
      }
    });
    tx();

    return { synced: skills.length };
  } catch (e) {
    return { synced: 0, error: e instanceof Error ? e.message : String(e) };
  }
}

// ─── List skills ─────────────────────────────────────────────

export function listSkills(): Skill[] {
  const rows = db().prepare('SELECT * FROM skills ORDER BY score DESC, display_name ASC').all() as any[];
  return rows.map(r => ({
    name: r.name,
    displayName: r.display_name,
    description: r.description,
    author: r.author,
    version: r.version,
    tags: JSON.parse(r.tags || '[]'),
    score: r.score,
    sourceUrl: r.source_url,
    installedGlobal: !!r.installed_global,
    installedProjects: JSON.parse(r.installed_projects || '[]'),
  }));
}

// ─── Install ─────────────────────────────────────────────────

async function fetchSkillContent(name: string): Promise<string> {
  // Check if already cached in DB
  const row = db().prepare('SELECT skill_content FROM skills WHERE name = ?').get(name) as any;
  if (row?.skill_content) return row.skill_content;

  // Fetch from GitHub
  const settings = loadSettings();
  const baseUrl = settings.skillsRepoUrl || 'https://raw.githubusercontent.com/aiwatching/forge-skills/main';
  const res = await fetch(`${baseUrl}/skills/${name}/skill.md`, { headers: { 'Accept': 'text/plain' } });
  if (!res.ok) throw new Error(`Failed to fetch skill: ${res.status}`);
  const content = await res.text();

  // Cache in DB
  db().prepare('UPDATE skills SET skill_content = ? WHERE name = ?').run(content, name);
  return content;
}

export async function installGlobal(name: string): Promise<void> {
  const content = await fetchSkillContent(name);
  if (!existsSync(GLOBAL_COMMANDS_DIR)) mkdirSync(GLOBAL_COMMANDS_DIR, { recursive: true });
  writeFileSync(join(GLOBAL_COMMANDS_DIR, `${name}.md`), content, 'utf-8');
  db().prepare('UPDATE skills SET installed_global = 1 WHERE name = ?').run(name);
}

export async function installProject(name: string, projectPath: string): Promise<void> {
  const content = await fetchSkillContent(name);
  const dir = projectCommandsDir(projectPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.md`), content, 'utf-8');

  // Update installed_projects list
  const row = db().prepare('SELECT installed_projects FROM skills WHERE name = ?').get(name) as any;
  const projects: string[] = JSON.parse(row?.installed_projects || '[]');
  if (!projects.includes(projectPath)) {
    projects.push(projectPath);
    db().prepare('UPDATE skills SET installed_projects = ? WHERE name = ?').run(JSON.stringify(projects), name);
  }
}

// ─── Uninstall ───────────────────────────────────────────────

export function uninstallGlobal(name: string): void {
  const file = join(GLOBAL_COMMANDS_DIR, `${name}.md`);
  try { unlinkSync(file); } catch {}
  db().prepare('UPDATE skills SET installed_global = 0 WHERE name = ?').run(name);
}

export function uninstallProject(name: string, projectPath: string): void {
  const file = join(projectCommandsDir(projectPath), `${name}.md`);
  try { unlinkSync(file); } catch {}

  const row = db().prepare('SELECT installed_projects FROM skills WHERE name = ?').get(name) as any;
  const projects: string[] = JSON.parse(row?.installed_projects || '[]');
  const updated = projects.filter(p => p !== projectPath);
  db().prepare('UPDATE skills SET installed_projects = ? WHERE name = ?').run(JSON.stringify(updated), name);
}

// ─── Scan installed state from filesystem ────────────────────

export function refreshInstallState(projectPaths: string[]): void {
  const skills = db().prepare('SELECT name FROM skills').all() as { name: string }[];

  for (const { name } of skills) {
    // Check global
    const globalInstalled = existsSync(join(GLOBAL_COMMANDS_DIR, `${name}.md`));

    // Check projects
    const installedIn: string[] = [];
    for (const pp of projectPaths) {
      if (existsSync(join(projectCommandsDir(pp), `${name}.md`))) {
        installedIn.push(pp);
      }
    }

    db().prepare('UPDATE skills SET installed_global = ?, installed_projects = ? WHERE name = ?')
      .run(globalInstalled ? 1 : 0, JSON.stringify(installedIn), name);
  }
}
