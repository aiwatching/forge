// Discovers crafts in a project's .forge/crafts/ + builtins shipped with Forge.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as YAML from 'yaml';
import type { CraftDescriptor, CraftManifest } from './types';

const BUILTIN_DIR = resolve(process.cwd(), 'lib/builtin-crafts');

function readManifest(dir: string): CraftManifest | null {
  const yml = join(dir, 'craft.yaml');
  if (!existsSync(yml)) return null;
  try {
    const parsed = YAML.parse(readFileSync(yml, 'utf8')) as CraftManifest;
    if (!parsed?.name) return null;
    return parsed;
  } catch {
    return null;
  }
}

function describe(dir: string, scope: 'builtin' | 'project'): CraftDescriptor | null {
  const m = readManifest(dir);
  if (!m) return null;
  const uiFile = m.ui?.tab || 'ui.tsx';
  const serverFile = m.server?.entry || 'server.ts';
  return {
    ...m,
    __dir: dir,
    __scope: scope,
    hasUi: existsSync(join(dir, uiFile)),
    hasServer: existsSync(join(dir, serverFile)),
  };
}

function listChildren(dir: string): string[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  return readdirSync(dir)
    .filter(n => !n.startsWith('.') && !n.startsWith('_'))
    .map(n => join(dir, n))
    .filter(p => statSync(p).isDirectory());
}

export function listProjectCrafts(projectPath: string): CraftDescriptor[] {
  const out: CraftDescriptor[] = [];
  // Builtins first (open-source samples shipped with Forge)
  for (const dir of listChildren(BUILTIN_DIR)) {
    const d = describe(dir, 'builtin');
    if (d) out.push(d);
  }
  // Project-local crafts override / extend builtins by name
  const projDir = join(projectPath, '.forge', 'crafts');
  for (const dir of listChildren(projDir)) {
    const d = describe(dir, 'project');
    if (!d) continue;
    const idx = out.findIndex(x => x.name === d.name);
    if (idx >= 0) out[idx] = d; else out.push(d);
  }
  return out;
}

export function getCraft(projectPath: string, name: string): CraftDescriptor | null {
  return listProjectCrafts(projectPath).find(c => c.name === name) || null;
}

// Best-effort condition evaluator for showWhen expressions. Tiny DSL only.
//   hasFile("path/relative/to/project")
//   always
export function shouldShow(craft: CraftDescriptor, projectPath: string): boolean {
  // First gate: requirements (project-type compatibility). If any are declared,
  // at least one matcher must match. This is the same gate the marketplace uses.
  if (craft.requires) {
    if (!matchesRequirements(craft.requires, projectPath)) return false;
  }
  // Second gate: explicit ui.showWhen expression
  const expr = craft.ui?.showWhen;
  if (!expr || expr.trim() === 'always') return true;
  const m = expr.match(/^hasFile\(\s*["']([^"']+)["']\s*\)$/);
  if (m) return existsSync(join(projectPath, m[1]));
  return true;
}

// Evaluate craft's requires field against a project path. Returns true when
// the project satisfies at least one of the declared requirements (OR logic).
// An empty requires object means "no constraint" → true.
export function matchesRequirements(req: NonNullable<CraftDescriptor['requires']>, projectPath: string): boolean {
  const files = req.hasFile || [];
  const globs = req.hasGlob || [];
  if (files.length === 0 && globs.length === 0) return true;

  for (const f of files) {
    if (existsSync(join(projectPath, f))) return true;
  }

  // Cheap glob match via shell. Bounded; runs once per craft, not per file.
  for (const g of globs) {
    try {
      const r = require('node:child_process').execSync(
        `find "${projectPath}" -path "${projectPath}/node_modules" -prune -o -path "${projectPath}/.git" -prune -o -name '*' -print 2>/dev/null | head -200 | grep -q -E "${globToRegex(g)}"`,
        { timeout: 3000, stdio: 'pipe' }
      );
      if (r) return true;
    } catch {
      // grep -q returns 1 when no match, but execSync throws — ignore
    }
  }
  return false;
}

function globToRegex(glob: string): string {
  // Tiny glob → regex: ** → .*, * → [^/]*, . escaped
  return glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '§§')
    .replace(/\*/g, '[^/]*')
    .replace(/§§/g, '.*');
}
