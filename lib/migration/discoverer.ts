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

// Match `METHOD /path` or `METHOD` `/path` or bare `METHOD /path` in any line.
const METHOD_PATH_RE = /\b(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\b\s+(\/[^\s`|<>]+)/i;

// Extract @Path("/prefix") annotation if mentioned in the doc body.
const PATH_ANNOTATION_RE = /@Path\(\s*"([^"]+)"\s*\)/;

type SectionKind = 'migrated' | 'stubbed' | 'parity-only' | 'unknown';

function classifyHeading(line: string): SectionKind | null {
  const lower = line.toLowerCase();
  if (lower.includes('url parity') || lower.includes('url-parity')) return 'parity-only';
  if (lower.includes('stub') || lower.includes('🚫') || lower.includes('501') || lower.includes('not implemented')) return 'stubbed';
  if (lower.includes('migrated') || lower.includes('✅') || lower.includes('implemented')) return 'migrated';
  return null;
}

function expandPath(rawPath: string, prefix: string | undefined): string | null {
  // Drop rows with only "..." / placeholder.
  if (/^\/?\.\.\.?$/.test(rawPath)) return null;

  // "/..." or starts with "/..." → substitute with @Path prefix.
  if (rawPath.startsWith('/...')) {
    if (!prefix) return null;
    return prefix.replace(/\/$/, '') + rawPath.slice(4);  // drop "/..."
  }
  // ".../foo" → also try prefix substitution
  if (rawPath.startsWith('.../')) {
    if (!prefix) return null;
    return prefix.replace(/\/$/, '') + '/' + rawPath.slice(4);
  }
  return rawPath;
}

interface ParseDocResult {
  controller: string;
  endpoints: { method: HttpMethod; path: string; isStubbed: boolean; notes?: string }[];
  pathAnnotation?: string;
  warnings: string[];
}

function parsePerControllerDoc(content: string, sourceFile: string): ParseDocResult {
  const titleMatch = content.match(/^#\s+([A-Za-z0-9_$]+)(?:\.java)?\b/m);
  const controller = titleMatch?.[1]
    || sourceFile.replace(/\.java\.md$/i, '').split('/').pop()
    || 'Unknown';

  // Find @Path annotation anywhere in doc as prefix for "/..." paths.
  const pathAnno = content.match(PATH_ANNOTATION_RE)?.[1];

  const endpoints: ParseDocResult['endpoints'] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();

  let currentKind: SectionKind = 'unknown';
  let inTable = false;
  let tableHeaderHasMethodCol = false;

  const lines = content.split('\n');

  for (const raw of lines) {
    const line = raw.trimEnd();

    // Heading detection
    if (/^#{2,6}\s/.test(line)) {
      const k = classifyHeading(line);
      if (k) currentKind = k;
      else {
        // Reset only if this is a clearly non-endpoint section
        const lower = line.toLowerCase();
        if (lower.includes('what it does') || lower.includes('files added') || lower.includes('test') || lower.includes('changelog')) {
          currentKind = 'unknown';
        }
      }
      inTable = false;
      tableHeaderHasMethodCol = false;
      continue;
    }

    // Skip doc-mode banner like "URL-parity-only" hint at top of doc.
    if (currentKind === 'unknown' && /url[- ]parity[- ]only/i.test(line)) {
      currentKind = 'parity-only';
    }

    // Table row
    if (line.startsWith('|')) {
      const cells = line.split('|').slice(1, -1).map(c => c.trim()).filter(c => c.length > 0 || true);
      if (cells.length === 0) continue;

      // Separator row: |---|---|---|
      if (cells.every(c => /^:?-+:?$/.test(c))) continue;

      // Header detection: first row of a table that contains a known column word.
      if (!inTable) {
        const lower = cells.map(c => c.toLowerCase()).join(' | ');
        if (/\bhttp\b|\bpath\b|\bmethod\b|\bendpoint\b|\bverb\b/.test(lower)) {
          inTable = true;
          tableHeaderHasMethodCol = /\bmethod\b|\bverb\b/.test(lower);
          continue;
        }
        // Not a recognized header — but maybe a data row that still contains METHOD+path? try anyway
      }

      // Data row — search whole row for METHOD + path
      const m = line.match(METHOD_PATH_RE);
      if (m) {
        const method = m[1].toUpperCase() as HttpMethod;
        const expanded = expandPath(m[2].trim(), pathAnno);
        if (expanded) {
          const isStubbed = currentKind === 'stubbed' || currentKind === 'parity-only';
          const key = `${method} ${expanded}`;
          if (!seen.has(key)) {
            seen.add(key);
            const notes = cells.slice(1).join(' | ').replace(/`/g, '').trim() || undefined;
            endpoints.push({ method, path: expanded, isStubbed, notes });
          }
        }
      }
      continue;
    }

    // Bullet / inline mention outside tables (some docs list endpoints in lists)
    if (line.startsWith('-') || line.startsWith('*')) {
      const m = line.match(METHOD_PATH_RE);
      if (m) {
        const method = m[1].toUpperCase() as HttpMethod;
        const expanded = expandPath(m[2].trim(), pathAnno);
        if (expanded) {
          const isStubbed = currentKind === 'stubbed' || currentKind === 'parity-only';
          const key = `${method} ${expanded}`;
          if (!seen.has(key)) {
            seen.add(key);
            endpoints.push({ method, path: expanded, isStubbed });
          }
        }
      }
    }

    // Empty line ends the table block
    if (line.trim() === '') {
      inTable = false;
      tableHeaderHasMethodCol = false;
    }
  }

  if (endpoints.length === 0) {
    if (pathAnno) {
      // URL-parity-only or undocumented — emit a single GET placeholder using @Path.
      endpoints.push({ method: 'GET', path: pathAnno, isStubbed: true, notes: 'URL parity only — no per-endpoint table' });
      warnings.push(`${controller}: no per-endpoint table; emitted GET ${pathAnno} placeholder from @Path annotation`);
    } else {
      warnings.push(`${controller}: no endpoints parsed and no @Path annotation found`);
    }
  }

  return { controller, endpoints, pathAnnotation: pathAnno, warnings };
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

function parseMigrationHistory(content: string, sourceFile: string, alreadyHaveControllers: Set<string>): Endpoint[] {
  const endpoints: Endpoint[] = [];
  const lines = content.split('\n');
  for (const line of lines) {
    const m = line.match(/^- \[[ xX]\]\s+`([^`]+\.java)`\s*[—-]\s*(.+)$/);
    if (!m) continue;
    const file = m[1];
    const status = classifyHistoryStatus(m[2]);
    if (status === 'skip' || status === 'defer') continue;

    const controllerMatch = file.match(/([A-Za-z0-9_$]+)\.java$/);
    const controller = controllerMatch ? controllerMatch[1] : file;

    // Skip if we already have endpoints for this controller from the per-controller doc
    if (alreadyHaveControllers.has(controller)) continue;

    const desc = m[2];
    const inlineRe = new RegExp(METHOD_PATH_RE.source, 'gi');
    let im;
    let added = 0;
    while ((im = inlineRe.exec(desc)) !== null) {
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
      added++;
    }
    // No placeholder if no inline endpoints — better to omit than to pollute.
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
  const controllersWithEndpoints = new Set<string>();

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
      // Skip aggregated/grouping docs
      if (f.startsWith('_')) continue;

      const filePath = join(primaryDir, f);
      const content = readFileSync(filePath, 'utf8');
      const parsed = parsePerControllerDoc(content, filePath);
      let count = 0;
      for (const ep of parsed.endpoints) {
        push({
          id: endpointId(ep.method, ep.path),
          controller: parsed.controller,
          file: f,
          method: ep.method,
          path: ep.path,
          status: 'migrated',
          expectedHttpStatus: ep.isStubbed ? 501 : 200,
          isStubbed: ep.isStubbed,
          source: `${config.endpointSource.primary}/${f}`,
          notes: ep.notes,
        });
        count++;
      }
      if (count > 0) {
        sources.push({ file: f, count });
        controllersWithEndpoints.add(parsed.controller);
      }
      warnings.push(...parsed.warnings);
    }
  } else {
    warnings.push(`Primary docs dir not found: ${primaryDir}`);
  }

  // 2) Fallback: migration-history.md (only adds entries we don't already have)
  if (config.endpointSource.fallback) {
    const fallbackPath = join(projectPath, config.endpointSource.fallback);
    if (existsSync(fallbackPath)) {
      const content = readFileSync(fallbackPath, 'utf8');
      const fromHistory = parseMigrationHistory(content, config.endpointSource.fallback, controllersWithEndpoints);
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
