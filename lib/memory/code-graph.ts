/**
 * Code Graph — AST-based code relationship analysis.
 *
 * Parses JS/TS/MJS files to extract:
 *   - Function/class declarations
 *   - Import/export relationships
 *   - Function call sites
 *   - Module dependencies
 *
 * Builds a graph: nodes = functions/files, edges = calls/imports/exports
 * Stores in FalkorDB for traversal queries.
 *
 * NO vectors, NO embeddings, NO LLM. Pure static analysis.
 */

import ts from 'typescript';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, relative, extname, basename } from 'node:path';

// ─── Types ───────────────────────────────────────────────

export interface CodeNode {
  id: string;              // e.g. "admin.mjs" or "admin.mjs::startServer"
  type: 'file' | 'function' | 'class' | 'variable';
  name: string;
  filePath: string;        // relative to project root
  line?: number;
  exported: boolean;
  module: string;          // directory-based module name
}

export interface CodeEdge {
  from: string;            // node id
  to: string;              // node id
  type: 'imports' | 'calls' | 'exports' | 'depends_on';
  detail?: string;         // e.g. import name
}

export interface CodeGraph {
  nodes: CodeNode[];
  edges: CodeEdge[];
  files: string[];
  scannedAt: number;
}

// ─── AST Parsing ─────────────────────────────────────────

function parseFile(filePath: string, relPath: string, module: string): { nodes: CodeNode[]; edges: CodeEdge[] } {
  const content = readFileSync(filePath, 'utf-8');
  const nodes: CodeNode[] = [];
  const edges: CodeEdge[] = [];
  const fileId = relPath;

  // File node
  nodes.push({
    id: fileId,
    type: 'file',
    name: basename(relPath),
    filePath: relPath,
    exported: false,
    module,
  });

  // Parse with TypeScript compiler (handles .ts, .tsx, .js, .mjs)
  const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true,
    filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : filePath.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS);

  const localDecls = new Map<string, string>();
  const importedNames = new Map<string, string>();

  function getLine(node: ts.Node): number {
    return sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
  }

  function visit(node: ts.Node) {
    // Import declarations
    if (ts.isImportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const source = node.moduleSpecifier.text;
      if (source.startsWith('.') || source.startsWith('/')) {
        const importedSymbols: string[] = [];
        if (node.importClause) {
          if (node.importClause.name) importedSymbols.push(node.importClause.name.text);
          const bindings = node.importClause.namedBindings;
          if (bindings && ts.isNamedImports(bindings)) {
            for (const el of bindings.elements) {
              importedSymbols.push(el.name.text);
              importedNames.set(el.name.text, source);
            }
          }
          if (bindings && ts.isNamespaceImport(bindings)) {
            importedSymbols.push(bindings.name.text);
            importedNames.set(bindings.name.text, source);
          }
        }
        edges.push({
          from: fileId,
          to: resolveImportPath(relPath, source),
          type: 'imports',
          detail: importedSymbols.join(', '),
        });
      }
    }

    // Function declarations (including async)
    if (ts.isFunctionDeclaration(node) && node.name) {
      const name = node.name.text;
      const funcId = `${fileId}::${name}`;
      const isExported = !!(node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword));
      nodes.push({ id: funcId, type: 'function', name, filePath: relPath, line: getLine(node), exported: isExported, module });
      localDecls.set(name, funcId);
      if (isExported) edges.push({ from: fileId, to: funcId, type: 'exports', detail: name });
    }

    // Variable declarations (arrow functions / const func = ...)
    if (ts.isVariableStatement(node)) {
      const isExported = !!(node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword));
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.initializer &&
          (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))) {
          const name = decl.name.text;
          const funcId = `${fileId}::${name}`;
          nodes.push({ id: funcId, type: 'function', name, filePath: relPath, line: getLine(decl), exported: isExported, module });
          localDecls.set(name, funcId);
          if (isExported) edges.push({ from: fileId, to: funcId, type: 'exports', detail: name });
        }
      }
    }

    // Class declarations
    if (ts.isClassDeclaration(node) && node.name) {
      const name = node.name.text;
      const classId = `${fileId}::${name}`;
      const isExported = !!(node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword));
      nodes.push({ id: classId, type: 'class', name, filePath: relPath, line: getLine(node), exported: isExported, module });
      localDecls.set(name, classId);
      if (isExported) edges.push({ from: fileId, to: classId, type: 'exports', detail: name });
    }

    // Export default
    if (ts.isExportAssignment(node)) {
      if (ts.isIdentifier(node.expression)) {
        edges.push({ from: fileId, to: `${fileId}::${node.expression.text}`, type: 'exports', detail: 'default' });
      }
    }

    // Named exports (export { foo, bar })
    if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
      for (const el of node.exportClause.elements) {
        const name = el.name.text;
        edges.push({ from: fileId, to: `${fileId}::${name}`, type: 'exports', detail: name });
      }
    }

    // Call expressions
    if (ts.isCallExpression(node)) {
      let callName: string | undefined;
      if (ts.isIdentifier(node.expression)) {
        callName = node.expression.text;
      } else if (ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression)) {
        callName = `${node.expression.expression.text}.${node.expression.name.text}`;
      }
      if (callName) {
        const baseName = callName.split('.')[0];
        if (localDecls.has(baseName)) {
          edges.push({ from: fileId, to: localDecls.get(baseName)!, type: 'calls', detail: callName });
        } else if (importedNames.has(baseName)) {
          const sourceFile = resolveImportPath(relPath, importedNames.get(baseName)!);
          edges.push({ from: fileId, to: `${sourceFile}::${baseName}`, type: 'calls', detail: callName });
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return { nodes, edges };
}

function resolveImportPath(fromFile: string, importPath: string): string {
  // Resolve relative import to a file path
  const dir = fromFile.includes('/') ? fromFile.replace(/\/[^/]+$/, '') : '.';
  let resolved = join(dir, importPath).replace(/^\.\//, '');
  // Remove leading ./
  if (resolved.startsWith('./')) resolved = resolved.slice(2);
  return resolved;
}

// ─── Project Scanner ─────────────────────────────────────

function findSourceFiles(dir: string, relDir: string = ''): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.next') continue;
    const full = join(dir, entry.name);
    const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      results.push(...findSourceFiles(full, rel));
    } else if (/\.(js|mjs|ts|tsx)$/.test(entry.name) && !/\.(test|spec|d)\.(js|ts)$/.test(entry.name)) {
      results.push(rel);
    }
  }
  return results;
}

export function buildCodeGraph(projectPath: string): CodeGraph {
  const files = findSourceFiles(projectPath);
  const allNodes: CodeNode[] = [];
  const allEdges: CodeEdge[] = [];

  for (const relPath of files) {
    const fullPath = join(projectPath, relPath);
    const parts = relPath.split('/');
    const module = parts.length > 1 ? parts[0] : '_root';

    const { nodes, edges } = parseFile(fullPath, relPath, module);
    allNodes.push(...nodes);
    allEdges.push(...edges);
  }

  // Deduplicate edges
  const edgeSet = new Set<string>();
  const uniqueEdges = allEdges.filter(e => {
    const key = `${e.from}→${e.to}→${e.type}`;
    if (edgeSet.has(key)) return false;
    edgeSet.add(key);
    return true;
  });

  return {
    nodes: allNodes,
    edges: uniqueEdges,
    files,
    scannedAt: Date.now(),
  };
}

// ─── Graph Queries (in-memory, no DB needed for small projects) ──

export function findAffectedBy(graph: CodeGraph, query: string): {
  directMatches: CodeNode[];
  impactChain: { node: CodeNode; path: string[]; depth: number }[];
} {
  const q = query.toLowerCase();

  // Find direct matches — AND first, fallback to OR if no AND results
  const terms = q.split(/\s+/).filter(Boolean);
  const matchNode = (n: CodeNode, mode: 'and' | 'or') => {
    const haystack = `${n.id} ${n.name} ${n.filePath} ${n.module}`.toLowerCase();
    return mode === 'and'
      ? terms.every(t => haystack.includes(t))
      : terms.some(t => haystack.includes(t));
  };
  let directMatches = graph.nodes.filter(n => matchNode(n, 'and'));
  if (directMatches.length === 0) {
    // Fallback: OR matching
    directMatches = graph.nodes.filter(n => matchNode(n, 'or'));
  }

  // BFS: find everything connected to direct matches (2 hops)
  const visited = new Set<string>();
  const impactChain: { node: CodeNode; path: string[]; depth: number }[] = [];

  function bfs(startIds: string[], maxDepth: number) {
    const queue: { id: string; depth: number; path: string[] }[] =
      startIds.map(id => ({ id, depth: 0, path: [id] }));

    while (queue.length > 0) {
      const { id, depth, path } = queue.shift()!;
      if (visited.has(id) || depth > maxDepth) continue;
      visited.add(id);

      const node = graph.nodes.find(n => n.id === id);
      if (node && depth > 0) {
        impactChain.push({ node, path, depth });
      }

      // Find all edges from/to this node
      for (const edge of graph.edges) {
        if (edge.from === id && !visited.has(edge.to)) {
          queue.push({ id: edge.to, depth: depth + 1, path: [...path, `→[${edge.type}]→`, edge.to] });
        }
        if (edge.to === id && !visited.has(edge.from)) {
          queue.push({ id: edge.from, depth: depth + 1, path: [...path, `←[${edge.type}]←`, edge.from] });
        }
      }
    }
  }

  bfs(directMatches.map(n => n.id), 3);

  return { directMatches, impactChain };
}

// ─── Incremental update ──────────────────────────────────

/**
 * Incrementally update graph by re-parsing only changed files.
 * Removes old nodes/edges for changed files, re-parses them, merges back.
 */
export function incrementalUpdate(
  existing: CodeGraph,
  projectPath: string,
  changedFiles: string[],
): CodeGraph {
  // Filter to source files only
  const sourceExts = /\.(js|mjs|ts|tsx)$/;
  const sourceFiles = changedFiles.filter(f => sourceExts.test(f) && !/\.(test|spec|d)\.(js|ts)$/.test(f));

  if (sourceFiles.length === 0) return existing;

  // Remove old nodes/edges for changed files
  const changedSet = new Set(sourceFiles);
  const nodes = existing.nodes.filter(n => !changedSet.has(n.filePath));
  const edges = existing.edges.filter(e => {
    const fromFile = e.from.split('::')[0];
    return !changedSet.has(fromFile);
  });

  // Re-parse changed files
  for (const relPath of sourceFiles) {
    const fullPath = join(projectPath, relPath);
    if (!existsSync(fullPath)) continue; // file deleted
    const parts = relPath.split('/');
    const module = parts.length > 1 ? parts[0] : '_root';
    const result = parseFile(fullPath, relPath, module);
    nodes.push(...result.nodes);
    edges.push(...result.edges);
  }

  // Resolve import targets (same as full scan)
  const nodeIds = new Set(nodes.map(n => n.id));
  for (const edge of edges) {
    if (!nodeIds.has(edge.to)) {
      for (const ext of ['.ts', '.tsx', '.js', '.mjs', '/index.ts', '/index.js']) {
        if (nodeIds.has(edge.to + ext)) { edge.to = edge.to + ext; break; }
      }
      if (edge.type === 'calls') {
        const parts = edge.to.split('::');
        if (parts.length === 2) {
          for (const ext of ['.ts', '.tsx', '.js', '.mjs']) {
            if (nodeIds.has(parts[0] + ext + '::' + parts[1])) { edge.to = parts[0] + ext + '::' + parts[1]; break; }
          }
        }
      }
    }
  }

  // Dedup edges
  const seen = new Set<string>();
  const uniqueEdges = edges.filter(e => {
    const k = `${e.from}→${e.to}→${e.type}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  return {
    nodes,
    edges: uniqueEdges,
    files: [...new Set([...existing.files.filter(f => !changedSet.has(f)), ...sourceFiles.filter(f => existsSync(join(projectPath, f)))])],
    scannedAt: Date.now(),
  };
}

// ─── Pretty print ────────────────────────────────────────

export function printGraphStats(graph: CodeGraph): string {
  const fileCount = graph.nodes.filter(n => n.type === 'file').length;
  const funcCount = graph.nodes.filter(n => n.type === 'function').length;
  const classCount = graph.nodes.filter(n => n.type === 'class').length;
  const importEdges = graph.edges.filter(e => e.type === 'imports').length;
  const callEdges = graph.edges.filter(e => e.type === 'calls').length;
  const exportEdges = graph.edges.filter(e => e.type === 'exports').length;

  return [
    `Files: ${fileCount}, Functions: ${funcCount}, Classes: ${classCount}`,
    `Edges: ${importEdges} imports, ${callEdges} calls, ${exportEdges} exports`,
    `Total: ${graph.nodes.length} nodes, ${graph.edges.length} edges`,
  ].join('\n');
}
