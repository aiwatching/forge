/**
 * CLAUDE.md template management.
 *
 * Templates are reusable markdown snippets that can be appended to project CLAUDE.md files.
 * Stored in <dataDir>/claude-templates/*.md with frontmatter metadata.
 * Injection is idempotent — marked with <!-- forge:template:<id> --> comments.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join, basename } from 'node:path';
import { getDataDir } from './dirs';
import YAML from 'yaml';

const TEMPLATES_DIR = join(getDataDir(), 'claude-templates');

export interface ClaudeTemplate {
  id: string;           // filename without .md
  name: string;
  description: string;
  tags: string[];
  builtin: boolean;
  isDefault: boolean;   // auto-inject into new projects
  content: string;      // markdown body (without frontmatter)
}

function ensureDir() {
  if (!existsSync(TEMPLATES_DIR)) mkdirSync(TEMPLATES_DIR, { recursive: true });
}

// ─── Built-in templates ──────────────────────────────────────

const BUILTINS: Record<string, { name: string; description: string; tags: string[]; content: string }> = {
  'typescript-rules': {
    name: 'TypeScript Rules',
    description: 'TypeScript coding conventions and best practices',
    tags: ['typescript', 'code-style'],
    content: `## TypeScript Rules
- Use \`const\` by default, \`let\` only when needed
- Prefer explicit return types on exported functions
- Use \`interface\` for object shapes, \`type\` for unions/intersections
- Avoid \`any\` — use \`unknown\` + type guards
- Prefer early returns over nested if/else`,
  },
  'git-workflow': {
    name: 'Git Workflow',
    description: 'Git commit and branch conventions',
    tags: ['git', 'workflow'],
    content: `## Git Workflow
- Commit messages: imperative mood, concise (e.g. "add feature X", "fix bug in Y")
- Branch naming: \`feature/<name>\`, \`fix/<name>\`, \`chore/<name>\`
- Always create a new branch for changes, never commit directly to main
- Run tests before committing`,
  },
  'obsidian-vault': {
    name: 'Obsidian Vault',
    description: 'Obsidian vault integration for note search and management',
    tags: ['obsidian', 'docs'],
    content: `## Obsidian Vault
When I ask about my notes, use bash to search and read files from the vault directory.
Example: find <vault_path> -name "*.md" | head -20`,
  },
  'security': {
    name: 'Security Rules',
    description: 'Security best practices for code generation',
    tags: ['security'],
    content: `## Security Rules
- Never hardcode secrets, API keys, or passwords
- Validate all user inputs at system boundaries
- Use parameterized queries for database operations
- Sanitize outputs to prevent XSS
- Follow OWASP top 10 guidelines`,
  },
};

/** Ensure built-in templates exist on disk */
export function ensureBuiltins() {
  ensureDir();
  for (const [id, tmpl] of Object.entries(BUILTINS)) {
    const file = join(TEMPLATES_DIR, `${id}.md`);
    if (!existsSync(file)) {
      const frontmatter = YAML.stringify({ name: tmpl.name, description: tmpl.description, tags: tmpl.tags, builtin: true });
      writeFileSync(file, `---\n${frontmatter}---\n\n${tmpl.content}\n`, 'utf-8');
    }
  }
}

// ─── CRUD ────────────────────────────────────────────────────

function parseTemplate(filePath: string): ClaudeTemplate | null {
  try {
    const raw = readFileSync(filePath, 'utf-8');
    const id = basename(filePath, '.md');
    // Parse frontmatter
    const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!fmMatch) return { id, name: id, description: '', tags: [], builtin: false, isDefault: false, content: raw.trim() };
    const meta = YAML.parse(fmMatch[1]) || {};
    return {
      id,
      name: meta.name || id,
      description: meta.description || '',
      tags: meta.tags || [],
      builtin: !!meta.builtin,
      isDefault: !!meta.isDefault,
      content: fmMatch[2].trim(),
    };
  } catch { return null; }
}

export function listTemplates(): ClaudeTemplate[] {
  ensureDir();
  ensureBuiltins();
  const files = readdirSync(TEMPLATES_DIR).filter(f => f.endsWith('.md')).sort();
  return files.map(f => parseTemplate(join(TEMPLATES_DIR, f))).filter(Boolean) as ClaudeTemplate[];
}

export function getTemplate(id: string): ClaudeTemplate | null {
  const file = join(TEMPLATES_DIR, `${id}.md`);
  if (!existsSync(file)) return null;
  return parseTemplate(file);
}

export function saveTemplate(id: string, name: string, description: string, tags: string[], content: string, isDefault?: boolean): void {
  ensureDir();
  // Preserve builtin flag if editing an existing built-in template
  const existing = getTemplate(id);
  const builtin = existing?.builtin || false;
  const frontmatter = YAML.stringify({ name, description, tags, builtin, isDefault: !!isDefault });
  writeFileSync(join(TEMPLATES_DIR, `${id}.md`), `---\n${frontmatter}---\n\n${content}\n`, 'utf-8');
}

/** Toggle default flag on a template */
export function setTemplateDefault(id: string, isDefault: boolean): boolean {
  const tmpl = getTemplate(id);
  if (!tmpl) return false;
  const file = join(TEMPLATES_DIR, `${id}.md`);
  const raw = readFileSync(file, 'utf-8');
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!fmMatch) return false;
  const meta = YAML.parse(fmMatch[1]) || {};
  meta.isDefault = isDefault;
  writeFileSync(file, `---\n${YAML.stringify(meta)}---\n${fmMatch[2]}`, 'utf-8');
  return true;
}

/** Auto-inject all default templates into a project if not already present */
export function applyDefaultTemplates(projectPath: string): string[] {
  const claudeMdPath = join(projectPath, 'CLAUDE.md');
  const templates = listTemplates();
  const injected: string[] = [];
  for (const tmpl of templates) {
    if (tmpl.isDefault && !isInjected(claudeMdPath, tmpl.id)) {
      if (injectTemplate(claudeMdPath, tmpl.id)) {
        injected.push(tmpl.id);
      }
    }
  }
  return injected;
}

export function deleteTemplate(id: string): boolean {
  const tmpl = getTemplate(id);
  if (!tmpl || tmpl.builtin) return false; // can't delete builtins
  const file = join(TEMPLATES_DIR, `${id}.md`);
  try { unlinkSync(file); return true; } catch { return false; }
}

// ─── Injection ───────────────────────────────────────────────

const MARKER_START = (id: string) => `<!-- forge:template:${id} -->`;
const MARKER_END = (id: string) => `<!-- /forge:template:${id} -->`;

/** Check if a template is already injected in a CLAUDE.md */
export function isInjected(claudeMdPath: string, templateId: string): boolean {
  if (!existsSync(claudeMdPath)) return false;
  const content = readFileSync(claudeMdPath, 'utf-8');
  return content.includes(MARKER_START(templateId));
}

/** Get list of template IDs injected in a CLAUDE.md */
export function getInjectedTemplates(claudeMdPath: string): string[] {
  if (!existsSync(claudeMdPath)) return [];
  const content = readFileSync(claudeMdPath, 'utf-8');
  const ids: string[] = [];
  const regex = /<!-- forge:template:(\S+) -->/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    ids.push(match[1]);
  }
  return ids;
}

/** Append a template to a CLAUDE.md file. Returns false if already injected. */
export function injectTemplate(claudeMdPath: string, templateId: string): boolean {
  const tmpl = getTemplate(templateId);
  if (!tmpl) return false;
  if (isInjected(claudeMdPath, templateId)) return false;

  const block = `\n${MARKER_START(templateId)}\n${tmpl.content}\n${MARKER_END(templateId)}\n`;

  if (existsSync(claudeMdPath)) {
    const existing = readFileSync(claudeMdPath, 'utf-8');
    writeFileSync(claudeMdPath, existing.trimEnd() + '\n' + block, 'utf-8');
  } else {
    // Create new CLAUDE.md
    const dir = join(claudeMdPath, '..');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(claudeMdPath, block.trimStart(), 'utf-8');
  }
  return true;
}

/** Remove a template from a CLAUDE.md file */
export function removeTemplate(claudeMdPath: string, templateId: string): boolean {
  if (!existsSync(claudeMdPath)) return false;
  const content = readFileSync(claudeMdPath, 'utf-8');
  const start = MARKER_START(templateId);
  const end = MARKER_END(templateId);
  const startIdx = content.indexOf(start);
  const endIdx = content.indexOf(end);
  if (startIdx === -1 || endIdx === -1) return false;

  const before = content.slice(0, startIdx).trimEnd();
  const after = content.slice(endIdx + end.length).trimStart();
  const newContent = before + (after ? '\n\n' + after : '') + '\n';
  writeFileSync(claudeMdPath, newContent, 'utf-8');
  return true;
}
