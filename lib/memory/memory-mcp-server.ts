#!/usr/bin/env tsx
/**
 * Forge Memory MCP Server
 *
 * Gives Claude Code persistent memory + code understanding.
 * Runs as standalone MCP server (stdio transport).
 *
 * Tools:
 *   search_code    — find related files/functions via AST graph
 *   get_file_context — get dependencies + knowledge for a file
 *   remember       — store a piece of knowledge
 *   recall         — retrieve relevant knowledge
 *   forget         — delete a knowledge entry
 *
 * Storage: <project>/.forge/memory/
 *   graph.json     — AST code relationship graph (auto-generated)
 *   knowledge.json — persistent knowledge entries
 *   meta.json      — scan metadata
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { buildCodeGraph, incrementalUpdate, findAffectedBy, printGraphStats } from './code-graph.js';
import type { CodeGraph } from './code-graph.js';

// ─── Config ──────────────────────────────────────────────

const PROJECT_PATH = process.env.FORGE_MEMORY_PROJECT || process.argv[2] || process.cwd();
const MEMORY_DIR = join(PROJECT_PATH, '.forge', 'memory');
const GRAPH_FILE = join(MEMORY_DIR, 'graph.json');
const KNOWLEDGE_FILE = join(MEMORY_DIR, 'knowledge.json');
const META_FILE = join(MEMORY_DIR, 'meta.json');

// ─── Knowledge Types ─────────────────────────────────────

interface KnowledgeEntry {
  id: string;
  type: 'decision' | 'bug' | 'constraint' | 'experience' | 'note';
  title: string;
  content: string;
  file?: string;       // anchored to file path
  function?: string;   // anchored to function name
  tags: string[];
  gitCommit?: string;
  status: 'active' | 'stale';
  createdAt: number;
  updatedAt: number;
}

interface Meta {
  projectPath: string;
  lastScanCommit?: string;
  lastScanAt?: number;
  nodeCount?: number;
  edgeCount?: number;
}

// ─── Storage ─────────────────────────────────────────────

function ensureDir() {
  if (!existsSync(MEMORY_DIR)) mkdirSync(MEMORY_DIR, { recursive: true });
}

function loadGraph(): CodeGraph | null {
  if (!existsSync(GRAPH_FILE)) return null;
  try { return JSON.parse(readFileSync(GRAPH_FILE, 'utf-8')); } catch { return null; }
}

function saveGraph(graph: CodeGraph) {
  ensureDir();
  writeFileSync(GRAPH_FILE, JSON.stringify(graph));
}

function loadKnowledge(): KnowledgeEntry[] {
  if (!existsSync(KNOWLEDGE_FILE)) return [];
  try { return JSON.parse(readFileSync(KNOWLEDGE_FILE, 'utf-8')); } catch { return []; }
}

function saveKnowledge(entries: KnowledgeEntry[]) {
  ensureDir();
  writeFileSync(KNOWLEDGE_FILE, JSON.stringify(entries, null, 2));
}

function loadMeta(): Meta {
  if (!existsSync(META_FILE)) return { projectPath: PROJECT_PATH };
  try { return JSON.parse(readFileSync(META_FILE, 'utf-8')); } catch { return { projectPath: PROJECT_PATH }; }
}

function saveMeta(meta: Meta) {
  ensureDir();
  writeFileSync(META_FILE, JSON.stringify(meta, null, 2));
}

function getHeadCommit(): string | undefined {
  try {
    return execSync('git rev-parse HEAD', { cwd: PROJECT_PATH, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim().slice(0, 12);
  } catch { return undefined; }
}

function getChangedFiles(sinceCommit: string): string[] {
  try {
    return execSync(`git diff --name-only ${sinceCommit}..HEAD`, { cwd: PROJECT_PATH, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] })
      .trim().split('\n').filter(Boolean);
  } catch { return []; }
}

// ─── Graph Management ────────────────────────────────────

let graph: CodeGraph | null = null;

function ensureGraph(): CodeGraph {
  if (graph) return graph;

  const meta = loadMeta();
  const currentCommit = getHeadCommit();

  // Try load cached graph
  const cached = loadGraph();
  if (cached && meta.lastScanCommit === currentCommit) {
    graph = cached;
    return graph;
  }

  // Incremental scan if few files changed, otherwise full rescan
  if (cached && meta.lastScanCommit) {
    const changed = getChangedFiles(meta.lastScanCommit);
    if (changed.length > 0 && changed.length < 50) {
      console.error(`[forge-memory] Incremental update: ${changed.length} files changed`);
      graph = incrementalUpdate(cached, PROJECT_PATH, changed);
      saveGraph(graph);
      saveMeta({
        projectPath: PROJECT_PATH,
        lastScanCommit: currentCommit,
        lastScanAt: Date.now(),
        nodeCount: graph.nodes.length,
        edgeCount: graph.edges.length,
      });
      if (meta.lastScanCommit && currentCommit !== meta.lastScanCommit) {
        markStaleKnowledge(meta.lastScanCommit);
      }
      return graph;
    }
  }

  // Full scan (first time or too many changes)
  graph = buildCodeGraph(PROJECT_PATH);
  saveGraph(graph);
  saveMeta({
    projectPath: PROJECT_PATH,
    lastScanCommit: currentCommit,
    lastScanAt: Date.now(),
    nodeCount: graph.nodes.length,
    edgeCount: graph.edges.length,
  });

  // Mark stale knowledge
  if (cached && meta.lastScanCommit && currentCommit !== meta.lastScanCommit) {
    markStaleKnowledge(meta.lastScanCommit);
  }

  return graph;
}

function markStaleKnowledge(sinceCommit: string) {
  const changed = getChangedFiles(sinceCommit);
  if (changed.length === 0) return;

  const entries = loadKnowledge();
  let staleCount = 0;
  for (const entry of entries) {
    if (entry.status !== 'active' || !entry.file) continue;
    if (changed.some(f => entry.file!.includes(f) || f.includes(entry.file!))) {
      entry.status = 'stale';
      entry.updatedAt = Date.now();
      staleCount++;
    }
  }
  if (staleCount > 0) {
    saveKnowledge(entries);
  }
}

function genId(): string {
  return `k-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`;
}

// ─── MCP Server ──────────────────────────────────────────

const server = new McpServer({
  name: 'forge-memory',
  version: '0.1.0',
});

// Tool: search_code
server.tool(
  'search_code',
  'Find related files, functions, and dependencies via AST code graph. Returns direct matches + impact chain (what else is affected). Use this before modifying code to understand the blast radius.',
  {
    query: z.string().describe('Search query — function name, file name, module name, or concept (use English code identifiers)'),
  },
  async ({ query }) => {
    const g = ensureGraph();
    const result = findAffectedBy(g, query);

    const lines: string[] = [];
    if (result.directMatches.length > 0) {
      lines.push(`## Direct matches (${result.directMatches.length})`);
      for (const n of result.directMatches.slice(0, 15)) {
        const exp = n.exported ? ' (exported)' : '';
        lines.push(`- [${n.type}] **${n.name}**${exp} — ${n.filePath}${n.line ? ':' + n.line : ''}`);
      }
    }

    if (result.impactChain.length > 0) {
      lines.push(`\n## Impact chain (${result.impactChain.length} connected nodes)`);
      for (const c of result.impactChain.slice(0, 20)) {
        lines.push(`- depth=${c.depth} [${c.node.type}] ${c.node.name} — ${c.node.filePath}${c.node.line ? ':' + c.node.line : ''}`);
      }
    }

    if (result.directMatches.length === 0) {
      lines.push('No matches found. Try different keywords (use English code identifiers like function/class/file names).');
    }

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }
);

// Tool: get_file_context
server.tool(
  'get_file_context',
  'Get full context for a file: who imports it, what it imports, exported symbols, and any attached knowledge. Call this before modifying a file to understand its role and dependencies.',
  {
    file_path: z.string().describe('Relative file path (e.g. "lib/workspace/orchestrator.ts")'),
  },
  async ({ file_path }) => {
    const g = ensureGraph();
    const entries = loadKnowledge();

    // Find file node
    const fileNode = g.nodes.find(n => n.type === 'file' && (n.filePath === file_path || n.filePath.endsWith(file_path)));
    if (!fileNode) {
      return { content: [{ type: 'text', text: `File "${file_path}" not found in code graph. Run rescan if file was recently added.` }] };
    }

    const lines: string[] = [`## ${fileNode.filePath} (module: ${fileNode.module})`];

    // Imports (what this file depends on)
    const imports = g.edges.filter(e => e.from === fileNode.id && e.type === 'imports');
    if (imports.length > 0) {
      lines.push(`\n### Imports (${imports.length})`);
      for (const e of imports) lines.push(`- ${e.to}${e.detail ? ' — ' + e.detail : ''}`);
    }

    // Imported by (who depends on this file)
    const importedBy = g.edges.filter(e => e.to === fileNode.id && e.type === 'imports');
    if (importedBy.length > 0) {
      lines.push(`\n### Imported by (${importedBy.length})`);
      for (const e of importedBy) lines.push(`- ${e.from}${e.detail ? ' — ' + e.detail : ''}`);
    }

    // Exported symbols
    const exports = g.edges.filter(e => e.from === fileNode.id && e.type === 'exports');
    if (exports.length > 0) {
      lines.push(`\n### Exports (${exports.length})`);
      for (const e of exports) lines.push(`- ${e.detail || e.to}`);
    }

    // Attached knowledge — this file + imported files
    const ICONS: Record<string, string> = { decision: '🎯', bug: '🐛', constraint: '⚠️', experience: '💡', note: '📝' };
    const thisFileKnowledge = entries.filter(k => k.file && (fileNode.filePath.includes(k.file) || k.file.includes(fileNode.filePath)));
    if (thisFileKnowledge.length > 0) {
      lines.push(`\n### Knowledge — this file (${thisFileKnowledge.length})`);
      for (const k of thisFileKnowledge) {
        const stale = k.status === 'stale' ? ' [STALE]' : '';
        lines.push(`- ${ICONS[k.type] || '📝'} **${k.title}**${stale}`);
        lines.push(`  ${k.content.slice(0, 200)}`);
      }
    }

    // Knowledge from imported files (causal chain awareness)
    const importedFiles = imports.map(e => e.to);
    const relatedKnowledge = entries.filter(k => {
      if (!k.file || thisFileKnowledge.includes(k)) return false;
      return importedFiles.some(f => k.file!.includes(f) || f.includes(k.file!));
    });
    if (relatedKnowledge.length > 0) {
      lines.push(`\n### Knowledge — imported files (${relatedKnowledge.length})`);
      for (const k of relatedKnowledge.slice(0, 10)) {
        const stale = k.status === 'stale' ? ' [STALE]' : '';
        lines.push(`- ${ICONS[k.type] || '📝'} **${k.title}** (${k.file})${stale}`);
        lines.push(`  ${k.content.slice(0, 150)}`);
      }
    }

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }
);

// Tool: remember
server.tool(
  'remember',
  'Store a piece of knowledge about the project. Use this to record design decisions, known bugs, constraints, and lessons learned. Knowledge persists across sessions and is automatically shown when working on related code.',
  {
    title: z.string().describe('One-line summary'),
    content: z.string().describe('Full description — why it matters, what to watch out for'),
    type: z.enum(['decision', 'bug', 'constraint', 'experience', 'note']).describe(
      'decision = why this design choice; bug = known issue + root cause; constraint = must not do X because Y; experience = lesson learned; note = general knowledge'
    ),
    file: z.string().optional().describe('Anchor to a specific file (e.g. "lib/auth.ts")'),
    function_name: z.string().optional().describe('Anchor to a specific function'),
    tags: z.array(z.string()).optional().describe('Searchable tags'),
  },
  async ({ title, content, type, file, function_name, tags }) => {
    const entries = loadKnowledge();

    // Dedup: same title + file → update
    const existing = entries.find(e => e.title === title && e.file === file && e.status === 'active');
    if (existing) {
      existing.content = content;
      existing.type = type;
      existing.tags = tags || existing.tags;
      existing.updatedAt = Date.now();
      existing.gitCommit = getHeadCommit();
      saveKnowledge(entries);
      return { content: [{ type: 'text', text: `Updated: "${title}" (id: ${existing.id})` }] };
    }

    const entry: KnowledgeEntry = {
      id: genId(),
      type,
      title,
      content,
      file,
      function: function_name,
      tags: tags || [],
      gitCommit: getHeadCommit(),
      status: 'active',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    entries.push(entry);
    saveKnowledge(entries);
    return { content: [{ type: 'text', text: `Remembered: "${title}" [${type}]${file ? ' → ' + file : ''} (id: ${entry.id})` }] };
  }
);

// Tool: recall
server.tool(
  'recall',
  'Retrieve stored project knowledge. Search by keyword, filter by file or type. Use this before starting work to check what is already known.',
  {
    query: z.string().optional().describe('Keyword search across titles, content, and tags'),
    file: z.string().optional().describe('Filter by anchored file path'),
    type: z.enum(['decision', 'bug', 'constraint', 'experience', 'note']).optional(),
    include_stale: z.boolean().optional().describe('Include stale entries (code changed since)'),
  },
  async ({ query, file, type, include_stale }) => {
    let entries = loadKnowledge();

    // Filter
    if (!include_stale) entries = entries.filter(e => e.status === 'active');
    if (type) entries = entries.filter(e => e.type === type);
    if (file) entries = entries.filter(e => e.file && (e.file.includes(file) || file.includes(e.file)));
    if (query) {
      const terms = query.toLowerCase().split(/\s+/);
      entries = entries.filter(e => {
        const hay = `${e.title} ${e.content} ${e.tags.join(' ')} ${e.file || ''}`.toLowerCase();
        return terms.every(t => hay.includes(t));
      });
    }

    entries.sort((a, b) => b.updatedAt - a.updatedAt);
    entries = entries.slice(0, 20);

    if (entries.length === 0) {
      return { content: [{ type: 'text', text: 'No knowledge found.' + (query ? ' Try broader keywords.' : '') }] };
    }

    const ICONS: Record<string, string> = { decision: '🎯', bug: '🐛', constraint: '⚠️', experience: '💡', note: '📝' };
    const lines = entries.map(e => {
      const stale = e.status === 'stale' ? ' ⚠️STALE' : '';
      return `${ICONS[e.type] || '📝'} **${e.title}**${stale}\n  ${e.content.slice(0, 300)}\n  ${e.file ? 'file: ' + e.file : ''}${e.tags.length ? ' tags: ' + e.tags.join(', ') : ''} | id: ${e.id}`;
    });

    return { content: [{ type: 'text', text: `Found ${entries.length} entries:\n\n${lines.join('\n\n')}` }] };
  }
);

// Tool: forget
server.tool(
  'forget',
  'Delete a knowledge entry by ID.',
  { id: z.string().describe('Knowledge entry ID to delete') },
  async ({ id }) => {
    const entries = loadKnowledge();
    const idx = entries.findIndex(e => e.id === id);
    if (idx < 0) return { content: [{ type: 'text', text: `Not found: ${id}` }] };
    const removed = entries.splice(idx, 1)[0];
    saveKnowledge(entries);
    return { content: [{ type: 'text', text: `Deleted: "${removed.title}" (${removed.id})` }] };
  }
);

// Tool: rescan
server.tool(
  'rescan_code',
  'Force rescan the project code graph. Use after creating new files or making significant structural changes (new modules, renamed files).',
  {},
  async () => {
    const t0 = Date.now();
    graph = null; // force full rescan
    const meta = loadMeta();
    meta.lastScanCommit = undefined; // clear cache
    saveMeta(meta);
    const g = ensureGraph();
    return { content: [{ type: 'text', text: `Rescanned in ${Date.now() - t0}ms: ${g.nodes.length} nodes, ${g.edges.length} edges, ${g.files.length} files` }] };
  }
);

// ─── Start ───────────────────────────────────────────────

async function main() {
  if (!existsSync(PROJECT_PATH)) {
    console.error(`[forge-memory] Error: Project not found: ${PROJECT_PATH}`);
    console.error(`[forge-memory] Usage: pnpm tsx lib/memory/memory-mcp-server.ts /path/to/project`);
    process.exit(1);
  }
  console.error(`[forge-memory] Project: ${PROJECT_PATH}`);
  const t0 = Date.now();
  ensureGraph();
  console.error(`[forge-memory] Graph ready: ${graph!.nodes.length} nodes, ${graph!.edges.length} edges (${Date.now() - t0}ms)`);

  const knowledge = loadKnowledge();
  console.error(`[forge-memory] Knowledge: ${knowledge.filter(k => k.status === 'active').length} active, ${knowledge.filter(k => k.status === 'stale').length} stale`);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[forge-memory] MCP server running (stdio)');
}

main().catch(err => { console.error('[forge-memory] Fatal:', err); process.exit(1); });
