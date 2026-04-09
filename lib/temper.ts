/**
 * Temper integration — optional persistent code memory via external MCP server.
 *
 * Temper is a standalone Rust binary (npm: @aion0/temper) that provides
 * AST code graph, knowledge store, causal chains, and experience records
 * as MCP tools. Claude Code connects to it as a stdio MCP server.
 *
 * Temper is fully optional — users enable it per-project via settings.
 * It is NOT a hard dependency of Forge.
 */

import { exec, execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import { loadSettings } from './settings';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

const NPM_PACKAGE = '@aion0/temper';

// ─── Binary detection ─────────────────────────────────────

let _cachedBin: string | null | undefined;

/** Reset cache (after install) */
export function resetBinCache() {
  _cachedBin = undefined;
}

/**
 * Find the temper binary (async). Checks:
 * 1. TEMPER_BIN env var
 * 2. PATH (which temper)
 * 3. npm global bin locations
 */
export async function findTemperBin(): Promise<string | null> {
  if (_cachedBin !== undefined) return _cachedBin;

  // Env override
  if (process.env.TEMPER_BIN && existsSync(process.env.TEMPER_BIN)) {
    _cachedBin = process.env.TEMPER_BIN;
    return _cachedBin;
  }

  // PATH lookup
  try {
    const { stdout } = await execAsync('which temper', { timeout: 3000 });
    const p = stdout.trim();
    if (p && existsSync(p)) {
      _cachedBin = p;
      return _cachedBin;
    }
  } catch {}

  // npm global bin, cargo bin
  const candidates = [
    join(homedir(), '.cargo', 'bin', 'temper'),
  ];
  // Add npm global prefix
  try {
    const { stdout } = await execAsync('npm prefix -g', { timeout: 3000 });
    const prefix = stdout.trim();
    if (prefix) candidates.push(join(prefix, 'bin', 'temper'));
  } catch {}

  for (const c of candidates) {
    if (existsSync(c)) {
      _cachedBin = c;
      return _cachedBin;
    }
  }

  _cachedBin = null;
  return null;
}

/**
 * Synchronous binary lookup — uses ONLY the cache or filesystem checks.
 * Never shells out. Safe to call from hot paths.
 */
export function findTemperBinSync(): string | null {
  if (_cachedBin !== undefined) return _cachedBin;

  // Env override
  if (process.env.TEMPER_BIN && existsSync(process.env.TEMPER_BIN)) {
    _cachedBin = process.env.TEMPER_BIN;
    return _cachedBin;
  }

  // Only check known filesystem paths, no exec
  const candidates = [
    join(homedir(), '.cargo', 'bin', 'temper'),
    '/usr/local/bin/temper',
    '/opt/homebrew/bin/temper',
  ];

  for (const c of candidates) {
    if (existsSync(c)) {
      _cachedBin = c;
      return _cachedBin;
    }
  }

  // Don't cache null here — let async version do a proper lookup
  return null;
}

export async function isTemperInstalled(): Promise<boolean> {
  return (await findTemperBin()) !== null;
}

/**
 * Check if temper is enabled for a project.
 * Uses per-project setting, defaults to false (opt-in).
 */
export function isTemperEnabled(projectPath: string): boolean {
  const settings = loadSettings();
  const perProject = (settings as any).temper;
  if (!perProject) return false;
  // Global enable or per-project list
  if (perProject === true) return true;
  if (Array.isArray(perProject)) return perProject.includes(projectPath);
  if (typeof perProject === 'object') {
    if (perProject.enabled === true) return true;
    if (Array.isArray(perProject.projects)) return perProject.projects.includes(projectPath);
  }
  return false;
}

// ─── Install ──────────────────────────────────────────────

export async function installTemper(): Promise<{ ok: boolean; error?: string }> {
  try {
    await execAsync(`npm install -g ${NPM_PACKAGE}`, { timeout: 120_000 });
    resetBinCache();
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e.stderr || e.message || 'install failed' };
  }
}

// ─── Project status ───────────────────────────────────────

export interface TemperStatus {
  installed: boolean;
  enabled: boolean;
  initialized: boolean;
  bin: string | null;
  version?: string;
  stats?: {
    files: number;
    functions: number;
    classes: number;
    nodes: number;
    edges: number;
    knowledgeEntries: number;
    modules: number;
  };
}

export async function getTemperStatus(projectPath: string): Promise<TemperStatus> {
  const bin = await findTemperBin();
  const enabled = isTemperEnabled(projectPath);

  if (!bin) {
    return { installed: false, enabled, initialized: false, bin: null };
  }

  // Get version
  let version: string | undefined;
  try {
    const { stdout } = await execFileAsync(bin, ['--version'], { timeout: 3000 });
    version = stdout.trim();
  } catch {}

  // Check initialized by reading files directly (no exec)
  const temperDir = join(projectPath, '.temper');
  const graphPath = join(temperDir, 'graph.json');
  const initialized = existsSync(graphPath) || existsSync(join(temperDir, 'knowledge.db'));

  if (!initialized) {
    return { installed: true, enabled, initialized: false, bin, version };
  }

  // Read stats directly from graph.json instead of exec
  const graphData = readTemperGraph(projectPath);
  if (graphData) {
    return {
      installed: true, enabled, initialized: true, bin, version,
      stats: { ...graphData.stats, knowledgeEntries: 0, modules: 0 },
    };
  }

  return { installed: true, enabled, initialized: true, bin, version };
}

// ─── Init (scan + suggest modules) ──────────────────────

export async function initTemper(projectPath: string): Promise<{ ok: boolean; error?: string }> {
  const bin = await findTemperBin();
  if (!bin) return { ok: false, error: 'temper not installed' };

  try {
    mkdirSync(join(projectPath, '.temper'), { recursive: true });
    // Use `temper init` which does scan + suggest modules (more complete than scan alone)
    await execFileAsync(bin, ['init', projectPath], { timeout: 180_000, cwd: projectPath });
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e.message || 'init failed' };
  }
}

// ─── MCP config generation ────────────────────────────────

/**
 * Generate MCP server entry for temper (stdio).
 * Returns null if temper is not installed, not enabled, or project not initialized.
 * Uses sync-only checks (cache + filesystem) to avoid blocking orchestrator.
 */
export function getTemperMcpConfig(projectPath: string): Record<string, any> | null {
  if (!isTemperEnabled(projectPath)) return null;

  const bin = findTemperBinSync();
  if (!bin) return null;

  const temperDir = join(projectPath, '.temper');
  if (!existsSync(temperDir)) return null;

  return {
    type: 'stdio',
    command: bin,
    args: ['serve', projectPath],
  };
}

// ─── Data reading (direct file access) ──────────────────

/** Read graph.json + meta.json → overview stats */
export function readTemperGraph(projectPath: string): {
  meta: any;
  stats: { files: number; functions: number; classes: number; nodes: number; edges: number };
  nodeTypes: Record<string, number>;
  edgeTypes: Record<string, number>;
} | null {
  const temperDir = join(projectPath, '.temper');
  const graphPath = join(temperDir, 'graph.json');
  if (!existsSync(graphPath)) return null;

  try {
    const graph = JSON.parse(readFileSync(graphPath, 'utf-8'));
    const nodes: any[] = graph.nodes || [];
    const edges: any[] = graph.edges || [];

    const nodeTypes: Record<string, number> = {};
    for (const n of nodes) {
      const t = n.node_type || 'unknown';
      nodeTypes[t] = (nodeTypes[t] || 0) + 1;
    }
    const edgeTypes: Record<string, number> = {};
    for (const e of edges) {
      const t = e.edge_type || 'unknown';
      edgeTypes[t] = (edgeTypes[t] || 0) + 1;
    }

    let meta: any = {};
    const metaPath = join(temperDir, 'meta.json');
    if (existsSync(metaPath)) {
      try { meta = JSON.parse(readFileSync(metaPath, 'utf-8')); } catch {}
    }

    return {
      meta,
      stats: {
        files: nodeTypes['file'] || 0,
        functions: nodeTypes['function'] || 0,
        classes: nodeTypes['class'] || 0,
        nodes: nodes.length,
        edges: edges.length,
      },
      nodeTypes,
      edgeTypes,
    };
  } catch { return null; }
}

/** Build file-level dependency graph for visualization.
 *  Only includes files that have at least one edge (connected files).
 *  Returns file nodes with module info + import/call edges between them. */
export function readTemperModuleGraph(projectPath: string): {
  nodes: { id: string; label: string; module: string; functions: number; exported: boolean }[];
  edges: { source: string; target: string; type: string; detail?: string }[];
  modules: { id: string; files: number; color: string }[];
  symbols: { name: string; type: string; file: string; line?: number; module: string }[];
  totalConnected?: number;
} | null {
  const temperDir = join(projectPath, '.temper');
  const graphPath = join(temperDir, 'graph.json');
  if (!existsSync(graphPath)) return null;

  try {
    const graph = JSON.parse(readFileSync(graphPath, 'utf-8'));
    const rawNodes: any[] = graph.nodes || [];
    const rawEdges: any[] = graph.edges || [];

    // File-level: resolve edge endpoints to file paths
    const fileNodes = rawNodes.filter(n => n.node_type === 'file');
    const fileToModule: Record<string, string> = {};
    for (const n of fileNodes) {
      fileToModule[n.file_path || n.id] = n.module || '_root';
    }

    // Count functions per file
    const fileFnCount: Record<string, number> = {};
    for (const n of rawNodes) {
      if (n.node_type === 'function') {
        const fp = n.file_path || n.id.split('::')[0];
        fileFnCount[fp] = (fileFnCount[fp] || 0) + 1;
      }
    }

    // Collect connected file IDs
    const connectedFiles = new Set<string>();
    const dedupEdges: { source: string; target: string; type: string; detail?: string }[] = [];
    const edgeSeen = new Set<string>();

    for (const e of rawEdges) {
      const from = e.from.split('::')[0];
      const to = e.to.split('::')[0];
      if (from === to) continue;
      const key = `${from}→${to}`;
      if (edgeSeen.has(key)) continue;
      edgeSeen.add(key);
      connectedFiles.add(from);
      connectedFiles.add(to);
      dedupEdges.push({ source: from, target: to, type: e.edge_type || 'imports', detail: e.detail });
    }

    // Build module summary + assign colors
    const MODULE_COLORS = [
      '#6366f1', '#f59e0b', '#10b981', '#ef4444', '#8b5cf6',
      '#ec4899', '#14b8a6', '#f97316', '#06b6d4', '#84cc16',
    ];
    const moduleSet = new Set<string>();
    for (const fp of connectedFiles) moduleSet.add(fileToModule[fp] || '_root');
    const moduleList = [...moduleSet];
    const moduleColors: Record<string, string> = {};
    moduleList.forEach((m, i) => { moduleColors[m] = MODULE_COLORS[i % MODULE_COLORS.length]; });

    // Module stats
    const modFileCount: Record<string, number> = {};
    for (const n of fileNodes) {
      const mod = n.module || '_root';
      modFileCount[mod] = (modFileCount[mod] || 0) + 1;
    }

    // Build connectivity count per file
    const conn: Record<string, number> = {};
    for (const fp of connectedFiles) conn[fp] = 0;
    for (const e of dedupEdges) {
      conn[e.source] = (conn[e.source] || 0) + 1;
      conn[e.target] = (conn[e.target] || 0) + 1;
    }

    // Cap at 150 nodes — keep the most connected files
    const MAX_NODES = 150;
    let finalFiles = [...connectedFiles];
    if (finalFiles.length > MAX_NODES) {
      finalFiles.sort((a, b) => (conn[b] || 0) - (conn[a] || 0));
      finalFiles = finalFiles.slice(0, MAX_NODES);
    }
    const finalSet = new Set(finalFiles);
    const finalEdges = dedupEdges.filter(e => finalSet.has(e.source) && finalSet.has(e.target));

    // Collect function/class symbols for search
    const symbols = rawNodes
      .filter(n => n.node_type === 'function' || n.node_type === 'class')
      .map(n => ({
        name: n.name || n.id.split('::').pop() || n.id,
        type: n.node_type,
        file: n.file_path || n.id.split('::')[0],
        line: n.line,
        module: n.module || '_root',
      }));

    // Smart label: for generic names (route.ts, page.tsx, index.ts) show parent dir
    const smartLabel = (fp: string) => {
      const parts = fp.split('/');
      const name = parts.pop() || fp;
      const generic = [
        'route.ts', 'route.tsx', 'page.tsx', 'page.ts',
        'index.ts', 'index.tsx', 'index.js', 'index.mjs',
        'mod.rs', 'lib.rs',
        // Java: package-info, module-info, and common patterns
        'package-info.java', 'module-info.java',
      ];
      // Java: class name == file name, show parent package for context
      if (name.endsWith('.java') && parts.length > 0) {
        const cls = name.replace('.java', '');
        const pkg = parts.slice(-1)[0];
        return `${pkg}/${cls}`;
      }
      if (generic.includes(name) && parts.length > 0) {
        // Show last 2 segments: "api/settings/route.ts" → "settings/route"
        const ctx = parts.slice(-1)[0];
        return `${ctx}/${name.replace(/\.[^.]+$/, '')}`;
      }
      return name.replace(/\.[^.]+$/, ''); // strip extension
    };

    return {
      nodes: finalFiles.map(fp => ({
        id: fp,
        label: smartLabel(fp),
        module: fileToModule[fp] || '_root',
        functions: fileFnCount[fp] || 0,
        exported: rawNodes.some(n => n.file_path === fp && n.exported),
      })),
      edges: finalEdges,
      modules: moduleList.map(id => ({
        id,
        files: modFileCount[id] || 0,
        color: moduleColors[id],
      })),
      symbols,
      totalConnected: connectedFiles.size,
    };
  } catch { return null; }
}

/** Read modules from .temper/modules/*.yaml */
export function readTemperModules(projectPath: string): any[] {
  const modulesDir = join(projectPath, '.temper', 'modules');
  if (!existsSync(modulesDir)) return [];

  try {
    const yaml = require('yaml');
    const files = readdirSync(modulesDir).filter(f => f.endsWith('.yaml') && f !== '_index.yaml');
    return files.map(f => {
      try {
        const content = readFileSync(join(modulesDir, f), 'utf-8');
        return yaml.parse(content);
      } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

/** Read module index with dimensions */
export function readTemperModuleIndex(projectPath: string): any {
  const indexPath = join(projectPath, '.temper', 'modules', '_index.yaml');
  if (!existsSync(indexPath)) return null;
  try {
    const yaml = require('yaml');
    return yaml.parse(readFileSync(indexPath, 'utf-8'));
  } catch { return null; }
}

/** Read knowledge entries from knowledge.db (SQLite) */
export function readTemperKnowledge(projectPath: string, opts?: {
  module?: string; type?: string; limit?: number;
}): any[] {
  const dbPath = join(projectPath, '.temper', 'knowledge.db');
  if (!existsSync(dbPath)) return [];

  try {
    const Database = require('better-sqlite3');
    const db = new Database(dbPath, { readonly: true });

    let sql = 'SELECT * FROM knowledge WHERE status = ?';
    const params: any[] = ['active'];

    if (opts?.module) {
      sql += ' AND module = ?';
      params.push(opts.module);
    }
    if (opts?.type) {
      sql += ' AND type = ?';
      params.push(opts.type);
    }
    sql += ' ORDER BY updated_at DESC';
    if (opts?.limit) {
      sql += ' LIMIT ?';
      params.push(opts.limit);
    }

    const rows = db.prepare(sql).all(...params);
    db.close();

    return rows.map((r: any) => ({
      ...r,
      tags: r.tags ? JSON.parse(r.tags) : [],
    }));
  } catch { return []; }
}

/** Read causal relations from knowledge.db */
export function readTemperCausalRelations(projectPath: string): any[] {
  const dbPath = join(projectPath, '.temper', 'knowledge.db');
  if (!existsSync(dbPath)) return [];

  try {
    const Database = require('better-sqlite3');
    const db = new Database(dbPath, { readonly: true });
    const rows = db.prepare('SELECT * FROM causal_relations ORDER BY created_at DESC').all();
    db.close();
    return rows;
  } catch { return []; }
}

/** Read experiences from knowledge.db */
export function readTemperExperiences(projectPath: string): any[] {
  const dbPath = join(projectPath, '.temper', 'knowledge.db');
  if (!existsSync(dbPath)) return [];

  try {
    const Database = require('better-sqlite3');
    const db = new Database(dbPath, { readonly: true });
    const rows = db.prepare("SELECT * FROM experiences WHERE status = 'active' ORDER BY created_at DESC").all();
    db.close();
    return rows.map((r: any) => ({
      ...r,
      tags: r.tags ? JSON.parse(r.tags) : [],
    }));
  } catch { return []; }
}

/** Read module interface JSON */
export function readTemperInterface(projectPath: string, moduleName: string): any | null {
  const ifacePath = join(projectPath, '.temper', 'interfaces', `${moduleName}.json`);
  if (!existsSync(ifacePath)) return null;
  try {
    return JSON.parse(readFileSync(ifacePath, 'utf-8'));
  } catch { return null; }
}
