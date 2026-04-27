// Discover endpoints from the project's existing migration docs.
// Primary parser: docs/migration/<File>.java.md tables (rich)
// Fallback parser: docs/lead/migration-history.md inline status

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { Endpoint, EndpointStatus, HttpMethod, MigrationConfig } from './types';

function endpointId(method: string, path: string): string {
  return createHash('sha1').update(`${method.toUpperCase()} ${path}`).digest('hex').slice(0, 12);
}

const HTTP_METHODS: HttpMethod[] = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];

// Match cells like  `GET /control/{id}`  or  `GET` `/control`
const METHOD_PATH_CELL = /`?(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)`?\s+`([^`]+)`/i;

interface ParsedSection {
  isStubbed: boolean;
  endpoints: { method: HttpMethod; path: string; notes?: string }[];
}

function parsePerControllerDoc(content: string, sourceFile: string): {
  controller: string;
  sections: ParsedSection[];
} {
  // Title: "# ControlService.java — partial migration record"
  const titleMatch = content.match(/^#\s+([A-Za-z0-9_$]+)(?:\.java)?\b/m);
  const controller = titleMatch?.[1] || sourceFile.replace(/\.java\.md$/i, '').split('/').pop() || 'Unknown';

  const sections: ParsedSection[] = [];
  const lines = content.split('\n');

  let currentStubbed = false;
  let inSection = false;
  let inTable = false;
  let headerCells: string[] = [];

  const startSection = (stubbed: boolean) => {
    inSection = true;
    inTable = false;
    currentStubbed = stubbed;
    sections.push({ isStubbed: stubbed, endpoints: [] });
  };

  for (const line of lines) {
    // Section markers: "### ✅ Migrated" / "### 🚫 Stubbed" / "### URL Parity Only"
    if (/^#{2,4}\s/.test(line)) {
      const lower = line.toLowerCase();
      if (lower.includes('migrated') || lower.includes('implemented') || lower.includes('✅')) {
        startSection(false);
        continue;
      }
      if (lower.includes('stub') || lower.includes('501') || lower.includes('url parity') || lower.includes('🚫')) {
        startSection(true);
        continue;
      }
      // Other heading — leave section as is unless it's clearly a non-endpoint section
      if (lower.includes('what it does') || lower.includes('approach') || lower.includes('test')) {
        inSection = false;
        inTable = false;
      }
      continue;
    }

    if (!inSection) continue;

    // Table detection
    if (line.startsWith('|')) {
      const cells = line.split('|').map(c => c.trim()).filter((_, i, a) => i > 0 && i < a.length - 1);
      if (!inTable) {
        // Header row — must contain http path/method indicator
        const headerLower = cells.map(c => c.toLowerCase()).join(' ');
        if (headerLower.includes('http') || headerLower.includes('path') || headerLower.includes('method') || headerLower.includes('endpoint')) {
          headerCells = cells.map(c => c.toLowerCase());
          inTable = true;
        }
        continue;
      }
      // Skip separator row "| --- |"
      if (cells.every(c => /^:?-+:?$/.test(c))) continue;
      // Data row — find method+path
      const joined = cells.join(' | ');
      const m = METHOD_PATH_CELL.exec(joined);
      if (!m) continue;
      const method = m[1].toUpperCase() as HttpMethod;
      const path = m[2].trim();
      // Notes column heuristic
      const notesIdx = headerCells.findIndex(h => h.includes('note') || h.includes('runtime') || h.includes('depend'));
      const notes = notesIdx >= 0 && cells[notesIdx] ? cells[notesIdx] : undefined;
      const last = sections[sections.length - 1];
      last.endpoints.push({ method, path, notes });
    } else if (line.trim() === '' && inTable) {
      inTable = false;
      headerCells = [];
    }
  }

  return { controller, sections };
}

function classifyHistoryStatus(line: string): EndpointStatus {
  const lower = line.toLowerCase();
  if (lower.includes('**skip')) return 'skip';
  if (lower.includes('**defer')) return 'defer';
  if (lower.includes('**migrated') || lower.includes('**done')) return 'migrated';
  if (lower.includes('**tested')) return 'tested';
  if (lower.includes('**in-progress') || lower.includes('**in progress')) return 'in-progress';
  return 'pending';
}

function parseMigrationHistory(content: string, sourceFile: string): Endpoint[] {
  const endpoints: Endpoint[] = [];
  const lines = content.split('\n');
  for (const line of lines) {
    const m = line.match(/^- \[[ xX]\]\s+`([^`]+\.java)`\s*[—-]\s*(.+)$/);
    if (!m) continue;
    const file = m[1];
    const status = classifyHistoryStatus(m[2]);
    if (status === 'skip' || status === 'defer') continue;

    const controllerMatch = file.match(/([A-Za-z0-9_$]+)(Service|Controller|Servlet)?\.java$/);
    const controller = controllerMatch ? controllerMatch[0].replace(/\.java$/, '') : file;

    // Try to find inline endpoint mentions like `GET /foo` in the description
    const desc = m[2];
    const inlineRe = /`(GET|POST|PUT|DELETE|PATCH)\s+(\/[^\s`]+)`/gi;
    let im;
    let found = false;
    while ((im = inlineRe.exec(desc)) !== null) {
      found = true;
      const method = im[1].toUpperCase() as HttpMethod;
      const path = im[2];
      endpoints.push({
        id: endpointId(method, path),
        controller, file, method, path,
        status,
        expectedHttpStatus: 200,
        isStubbed: false,
        source: sourceFile,
      });
    }
    if (!found) {
      // Fallback marker so the user sees the controller even without endpoint inline
      endpoints.push({
        id: endpointId('UNKNOWN', file),
        controller, file,
        method: 'GET',
        path: `/${controller}`,
        status,
        expectedHttpStatus: 200,
        isStubbed: false,
        source: sourceFile,
        notes: 'Path inferred — no inline endpoint in history; please refine.',
      });
    }
  }
  return endpoints;
}

export interface DiscoveryResult {
  endpoints: Endpoint[];
  warnings: string[];
  sources: { file: string; count: number }[];
}

export function discoverEndpoints(projectPath: string, config: MigrationConfig): DiscoveryResult {
  const warnings: string[] = [];
  const sources: { file: string; count: number }[] = [];
  const all: Endpoint[] = [];
  const seen = new Set<string>();

  const push = (e: Endpoint) => {
    if (seen.has(e.id)) return;
    seen.add(e.id);
    all.push(e);
  };

  // 1) Per-controller docs (primary)
  const primaryDir = join(projectPath, config.endpointSource.primary);
  if (existsSync(primaryDir) && statSync(primaryDir).isDirectory()) {
    const files = readdirSync(primaryDir).filter(f => f.endsWith('.md'));
    for (const f of files) {
      const filePath = join(primaryDir, f);
      const content = readFileSync(filePath, 'utf8');
      const { controller, sections } = parsePerControllerDoc(content, filePath);
      let count = 0;
      for (const sec of sections) {
        for (const ep of sec.endpoints) {
          push({
            id: endpointId(ep.method, ep.path),
            controller,
            file: f,
            method: ep.method,
            path: ep.path,
            status: 'migrated',
            expectedHttpStatus: sec.isStubbed ? 501 : 200,
            isStubbed: sec.isStubbed,
            source: `${config.endpointSource.primary}/${f}`,
            notes: ep.notes,
          });
          count++;
        }
      }
      if (count > 0) sources.push({ file: f, count });
      else warnings.push(`No endpoints parsed from ${f}`);
    }
  } else {
    warnings.push(`Primary docs dir not found: ${primaryDir}`);
  }

  // 2) Fallback: migration-history.md (only adds entries we don't already have)
  if (config.endpointSource.fallback) {
    const fallbackPath = join(projectPath, config.endpointSource.fallback);
    if (existsSync(fallbackPath)) {
      const content = readFileSync(fallbackPath, 'utf8');
      const fromHistory = parseMigrationHistory(content, config.endpointSource.fallback);
      let added = 0;
      for (const e of fromHistory) {
        if (!seen.has(e.id)) { push(e); added++; }
      }
      if (added > 0) sources.push({ file: config.endpointSource.fallback, count: added });
    } else {
      warnings.push(`Fallback file not found: ${fallbackPath}`);
    }
  }

  return { endpoints: all, warnings, sources };
}
