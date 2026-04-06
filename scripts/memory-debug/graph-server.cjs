#!/usr/bin/env node
/**
 * Code Graph Debug Server
 * Scans project via AST → serves graph data + debug UI
 *
 * Usage: node scripts/memory-debug/graph-server.cjs [project-path]
 * Default: scans current project (my-workflow)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const ts = require('typescript');

let currentProject = process.argv[2] || process.cwd();
const PORT = 8111;
const graphCache = new Map(); // project path → { graph, scannedAt }

// ─── AST-based Code Graph ────────────────────────────────

function parseFile(filePath, relPath, module) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const nodes = [];
  const edges = [];
  const fileId = relPath;

  nodes.push({ id: fileId, type: 'file', name: path.basename(relPath), filePath: relPath, exported: false, module });

  let sf;
  try {
    sf = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true,
      filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : filePath.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS);
  } catch { return { nodes, edges }; }

  const localDecls = new Map();
  const importedNames = new Map();
  const getLine = (node) => sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;

  function resolveImport(from, imp) {
    const dir = from.includes('/') ? from.replace(/\/[^/]+$/, '') : '.';
    return path.join(dir, imp).replace(/^\.\//, '');
  }

  function visit(node) {
    // Imports
    if (ts.isImportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const src = node.moduleSpecifier.text;
      if (src.startsWith('.') || src.startsWith('/')) {
        const names = [];
        if (node.importClause) {
          if (node.importClause.name) { names.push(node.importClause.name.text); importedNames.set(node.importClause.name.text, src); }
          const bindings = node.importClause.namedBindings;
          if (bindings && ts.isNamedImports(bindings)) {
            for (const el of bindings.elements) { names.push(el.name.text); importedNames.set(el.name.text, src); }
          }
          if (bindings && ts.isNamespaceImport(bindings)) { names.push(bindings.name.text); importedNames.set(bindings.name.text, src); }
        }
        edges.push({ from: fileId, to: resolveImport(relPath, src), type: 'imports', detail: names.join(', ') });
      }
    }

    // Functions
    if (ts.isFunctionDeclaration(node) && node.name) {
      const name = node.name.text;
      const funcId = `${fileId}::${name}`;
      const exp = !!(node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword));
      nodes.push({ id: funcId, type: 'function', name, filePath: relPath, line: getLine(node), exported: exp, module });
      localDecls.set(name, funcId);
      if (exp) edges.push({ from: fileId, to: funcId, type: 'exports', detail: name });
    }

    // Arrow/const functions
    if (ts.isVariableStatement(node)) {
      const exp = !!(node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword));
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.initializer &&
          (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))) {
          const name = decl.name.text;
          const funcId = `${fileId}::${name}`;
          nodes.push({ id: funcId, type: 'function', name, filePath: relPath, line: getLine(decl), exported: exp, module });
          localDecls.set(name, funcId);
          if (exp) edges.push({ from: fileId, to: funcId, type: 'exports', detail: name });
        }
      }
    }

    // Classes
    if (ts.isClassDeclaration(node) && node.name) {
      const name = node.name.text;
      const classId = `${fileId}::${name}`;
      const exp = !!(node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword));
      nodes.push({ id: classId, type: 'class', name, filePath: relPath, line: getLine(node), exported: exp, module });
      localDecls.set(name, classId);
      if (exp) edges.push({ from: fileId, to: classId, type: 'exports', detail: name });
    }

    // Calls
    if (ts.isCallExpression(node)) {
      let callName;
      if (ts.isIdentifier(node.expression)) callName = node.expression.text;
      else if (ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression))
        callName = `${node.expression.expression.text}.${node.expression.name.text}`;
      if (callName) {
        const base = callName.split('.')[0];
        if (localDecls.has(base)) edges.push({ from: fileId, to: localDecls.get(base), type: 'calls', detail: callName });
        else if (importedNames.has(base)) {
          const sf2 = resolveImport(relPath, importedNames.get(base));
          edges.push({ from: fileId, to: `${sf2}::${base}`, type: 'calls', detail: callName });
        }
      }
    }

    ts.forEachChild(node, visit);
  }
  visit(sf);
  return { nodes, edges };
}

function scanProject(projectPath) {
  const files = [];
  function walk(dir, rel) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.') || ['node_modules', 'dist', '.next'].includes(e.name)) continue;
      const full = path.join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(full, r);
      else if (/\.(js|mjs|ts|tsx)$/.test(e.name) && !/\.(test|spec|d)\.(js|ts)$/.test(e.name)) files.push(r);
    }
  }
  walk(projectPath, '');

  const allNodes = [], allEdges = [];
  for (const relPath of files) {
    const mod = relPath.includes('/') ? relPath.split('/')[0] : '_root';
    const { nodes, edges } = parseFile(path.join(projectPath, relPath), relPath, mod);
    allNodes.push(...nodes);
    allEdges.push(...edges);
  }

  // Resolve import targets: add file extensions (.ts, .tsx, /index.ts)
  const nodeIds = new Set(allNodes.map(n => n.id));
  for (const edge of allEdges) {
    if (!nodeIds.has(edge.to) && edge.type === 'imports') {
      // Try common extensions
      for (const ext of ['.ts', '.tsx', '.js', '.mjs', '/index.ts', '/index.js']) {
        if (nodeIds.has(edge.to + ext)) { edge.to = edge.to + ext; break; }
      }
    }
    // Also resolve call targets to existing nodes
    if (!nodeIds.has(edge.to) && edge.type === 'calls') {
      for (const ext of ['.ts', '.tsx', '.js', '.mjs']) {
        const parts = edge.to.split('::');
        if (parts.length === 2) {
          const resolved = parts[0] + ext + '::' + parts[1];
          if (nodeIds.has(resolved)) { edge.to = resolved; break; }
        }
      }
    }
  }

  // Dedup edges
  const seen = new Set();
  const uniqueEdges = allEdges.filter(e => {
    const k = `${e.from}→${e.to}→${e.type}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  return { nodes: allNodes, edges: uniqueEdges, files };
}

function queryGraph(graph, query) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const matchNode = (n, mode) => {
    const h = `${n.id} ${n.name} ${n.filePath} ${n.module || ''}`.toLowerCase();
    return mode === 'and' ? terms.every(t => h.includes(t)) : terms.some(t => h.includes(t));
  };
  let direct = graph.nodes.filter(n => matchNode(n, 'and'));
  if (direct.length === 0) direct = graph.nodes.filter(n => matchNode(n, 'or'));

  const visited = new Set();
  const impact = [];
  const queue = direct.map(n => ({ id: n.id, depth: 0, path: [n.id] }));
  while (queue.length > 0) {
    const { id, depth, path: p } = queue.shift();
    if (visited.has(id) || depth > 3) continue;
    visited.add(id);
    const node = graph.nodes.find(n => n.id === id);
    if (node && depth > 0) impact.push({ node, path: p, depth });
    for (const e of graph.edges) {
      if (e.from === id && !visited.has(e.to)) queue.push({ id: e.to, depth: depth + 1, path: [...p, `→[${e.type}]→`, e.to] });
      if (e.to === id && !visited.has(e.from)) queue.push({ id: e.from, depth: depth + 1, path: [...p, `←[${e.type}]←`, e.from] });
    }
  }
  return { direct, impact };
}

// ─── Build/cache graph ───────────────────────────────────

function getGraph(projectPath) {
  if (graphCache.has(projectPath)) return graphCache.get(projectPath);
  console.log(`Scanning ${projectPath}...`);
  const t0 = Date.now();
  const graph = scanProject(projectPath);
  console.log(`Done in ${Date.now() - t0}ms: ${graph.nodes.length} nodes, ${graph.edges.length} edges`);
  graphCache.set(projectPath, graph);
  return graph;
}

// Validate project path
if (!fs.existsSync(currentProject)) {
  console.error(`Error: Project path not found: ${currentProject}`);
  console.error(`\nUsage: node scripts/memory-debug/graph-server.cjs /path/to/your/project`);
  console.error(`Example: node scripts/memory-debug/graph-server.cjs /Users/zliu/IdeaProjects/forge-skills-manager`);
  process.exit(1);
}

// Initial scan
let graph = getGraph(currentProject);

// ─── HTTP Server ─────────────────────────────────────────

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/api/switch') {
    const p = url.searchParams.get('project');
    if (!p || !fs.existsSync(p)) { res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid project path' })); return; }
    currentProject = p;
    graphCache.delete(p); // force rescan
    graph = getGraph(p);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ project: currentProject, nodes: graph.nodes.length, edges: graph.edges.length }));
    return;
  }

  if (url.pathname === '/api/rescan') {
    graphCache.delete(currentProject);
    graph = getGraph(currentProject);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ project: currentProject, nodes: graph.nodes.length, edges: graph.edges.length }));
    return;
  }

  if (url.pathname === '/api/project') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ project: currentProject }));
    return;
  }

  if (url.pathname === '/api/stats') {
    const fileCount = graph.nodes.filter(n => n.type === 'file').length;
    const funcCount = graph.nodes.filter(n => n.type === 'function').length;
    const classCount = graph.nodes.filter(n => n.type === 'class').length;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ files: fileCount, functions: funcCount, classes: classCount, totalNodes: graph.nodes.length, totalEdges: graph.edges.length }));
    return;
  }

  if (url.pathname === '/api/query') {
    const q = url.searchParams.get('q') || '';
    const result = queryGraph(graph, q);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }

  if (url.pathname === '/api/graph') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(graph));
    return;
  }

  if (url.pathname === '/api/file') {
    const fp = url.searchParams.get('path');
    if (!fp) { res.writeHead(400); res.end('path required'); return; }
    const fullPath = path.join(currentProject, fp);
    if (!fs.existsSync(fullPath)) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(fs.readFileSync(fullPath, 'utf-8'));
    return;
  }

  // Serve HTML
  if (url.pathname === '/' || url.pathname === '/index.html') {
    const htmlPath = path.join(__dirname, 'graph.html');
    if (fs.existsSync(htmlPath)) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(fs.readFileSync(htmlPath, 'utf-8'));
      return;
    }
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`\nCode Graph Debug: http://localhost:${PORT}`);
  console.log(`  Project: ${currentProject}`);
  console.log(`  API: /api/stats, /api/query?q=..., /api/graph, /api/file?path=...`);
});
