// Discover endpoints. Strategy:
// - If openApiSpec is configured → OpenAPI is the PRIMARY source (full surface).
//   Per-controller docs + history file are then used to ANNOTATE migration status.
// - Otherwise → fall back to per-controller doc parsing (legacy behavior).

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { Endpoint, EndpointStatus, HttpMethod, MigrationConfig } from './types';
import { loadOpenApi, getResponseSchema, type OpenApiDoc } from './openapi';

function endpointId(method: string, path: string): string {
  return createHash('sha1').update(`${method.toUpperCase()} ${path}`).digest('hex').slice(0, 12);
}

const METHOD_PATH_RE = /\b(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\b\s+(\/[^\s`|<>]+)/i;
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
  if (/^\/?\.\.\.?$/.test(rawPath)) return null;
  if (rawPath.startsWith('/...')) {
    if (!prefix) return null;
    return prefix.replace(/\/$/, '') + rawPath.slice(4);
  }
  if (rawPath.startsWith('.../')) {
    if (!prefix) return null;
    return prefix.replace(/\/$/, '') + '/' + rawPath.slice(4);
  }
  return rawPath;
}

// ── Per-controller doc parser → annotation map ──────────
// Returns Map<"METHOD path", { kind, controller, file }>

interface DocAnnotation {
  kind: SectionKind;
  controller: string;
  file: string;          // relative doc file
  notes?: string;
}

function parsePerControllerDocs(projectPath: string, dirRel: string): {
  byKey: Map<string, DocAnnotation>;
  warnings: string[];
} {
  const byKey = new Map<string, DocAnnotation>();
  const warnings: string[] = [];
  const dir = join(projectPath, dirRel);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    warnings.push(`Per-controller docs dir not found: ${dir}`);
    return { byKey, warnings };
  }

  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.md') || f.startsWith('_')) continue;
    const filePath = join(dir, f);
    const content = readFileSync(filePath, 'utf8');

    const titleMatch = content.match(/^#\s+([A-Za-z0-9_$]+)(?:\.java)?\b/m);
    const controller = titleMatch?.[1] || f.replace(/\.java\.md$/i, '');
    const pathAnno = content.match(PATH_ANNOTATION_RE)?.[1];

    let currentKind: SectionKind = 'unknown';
    let inTable = false;
    let count = 0;

    for (const raw of content.split('\n')) {
      const line = raw.trimEnd();
      if (/^#{2,6}\s/.test(line)) {
        const k = classifyHeading(line);
        if (k) currentKind = k;
        else {
          const lower = line.toLowerCase();
          if (lower.includes('what it does') || lower.includes('files added') || lower.includes('changelog')) {
            currentKind = 'unknown';
          }
        }
        inTable = false;
        continue;
      }
      if (currentKind === 'unknown' && /url[- ]parity[- ]only/i.test(line)) currentKind = 'parity-only';

      if (line.startsWith('|')) {
        const cells = line.split('|').slice(1, -1).map(c => c.trim());
        if (cells.length === 0) continue;
        if (cells.every(c => /^:?-+:?$/.test(c))) continue;
        if (!inTable) {
          const lower = cells.map(c => c.toLowerCase()).join(' | ');
          if (/\bhttp\b|\bpath\b|\bmethod\b|\bendpoint\b|\bverb\b/.test(lower)) {
            inTable = true; continue;
          }
        }
        const m = line.match(METHOD_PATH_RE);
        if (m) {
          const expanded = expandPath(m[2].trim(), pathAnno);
          if (expanded) {
            const key = `${m[1].toUpperCase()} ${expanded}`;
            const notes = cells.slice(1).join(' | ').replace(/`/g, '').trim() || undefined;
            byKey.set(key, { kind: currentKind === 'unknown' ? 'migrated' : currentKind, controller, file: f, notes });
            count++;
          }
        }
        continue;
      }

      if ((line.startsWith('-') || line.startsWith('*'))) {
        const m = line.match(METHOD_PATH_RE);
        if (m) {
          const expanded = expandPath(m[2].trim(), pathAnno);
          if (expanded) {
            const key = `${m[1].toUpperCase()} ${expanded}`;
            byKey.set(key, { kind: currentKind === 'unknown' ? 'migrated' : currentKind, controller, file: f });
            count++;
          }
        }
      }
      if (line.trim() === '') inTable = false;
    }

    if (count === 0 && pathAnno) {
      // URL-parity-only doc with no per-endpoint table — annotate by prefix later.
      // We'll store with a sentinel so the OpenAPI walk can apply it as a fallback.
      byKey.set(`__PREFIX__ ${pathAnno}`, { kind: 'parity-only', controller, file: f });
    }
  }

  return { byKey, warnings };
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

interface HistoryAnnotation {
  status: EndpointStatus;
  file: string;
}

// Map controller name → history annotation
function parseMigrationHistory(projectPath: string, fileRel: string): Map<string, HistoryAnnotation> {
  const m = new Map<string, HistoryAnnotation>();
  const file = join(projectPath, fileRel);
  if (!existsSync(file)) return m;
  const content = readFileSync(file, 'utf8');
  for (const line of content.split('\n')) {
    const match = line.match(/^- \[[ xX]\]\s+`([^`]+\.java)`\s*[—-]\s*(.+)$/);
    if (!match) continue;
    const javaFile = match[1];
    const status = classifyHistoryStatus(match[2]);
    const ctrlMatch = javaFile.match(/([A-Za-z0-9_$]+)\.java$/);
    const ctrl = ctrlMatch ? ctrlMatch[1] : javaFile;
    m.set(ctrl, { status, file: javaFile });
  }
  return m;
}

// ── Main ────────────────────────────────────────────────

export interface DiscoveryResult {
  endpoints: Endpoint[];
  warnings: string[];
  sources: { file: string; count: number }[];
  stats: {
    fromOpenApi: number;
    annotatedByDoc: number;
    annotatedByHistory: number;
    stubbed: number;
    pending: number;
  };
}

export function discoverEndpoints(projectPath: string, config: MigrationConfig): DiscoveryResult {
  const warnings: string[] = [];
  const sources: { file: string; count: number }[] = [];

  // 1) Try OpenAPI as primary source
  const openApiPath = config.endpointSource.openApiSpec;
  let openApi: OpenApiDoc | null = null;
  if (openApiPath) {
    openApi = loadOpenApi(projectPath, openApiPath);
    if (!openApi) warnings.push(`OpenAPI spec not found: ${openApiPath}`);
  }

  if (!openApi) {
    // Fall back to legacy doc-only discovery
    return legacyDocDiscovery(projectPath, config);
  }

  // 2) Build annotation maps from docs
  const docAnno = parsePerControllerDocs(projectPath, config.endpointSource.primary);
  warnings.push(...docAnno.warnings);
  const historyAnno = config.endpointSource.fallback
    ? parseMigrationHistory(projectPath, config.endpointSource.fallback)
    : new Map();

  // Pre-compute prefix-based annotations from URL-parity-only docs
  const prefixAnnos: { prefix: string; anno: DocAnnotation }[] = [];
  for (const [key, anno] of docAnno.byKey) {
    if (key.startsWith('__PREFIX__ ')) {
      prefixAnnos.push({ prefix: key.slice('__PREFIX__ '.length), anno });
    }
  }

  // 3) Walk OpenAPI ops, annotate
  const endpoints: Endpoint[] = [];
  let annotatedByDoc = 0;
  let annotatedByHistory = 0;
  let stubbed = 0;
  let pending = 0;

  for (const op of openApi.operations) {
    const key = `${op.method} ${op.path}`;
    const directAnno = docAnno.byKey.get(key);

    let docNotes: string | undefined;
    let docFile: string | undefined;
    let docKind: SectionKind | undefined;

    if (directAnno) {
      docKind = directAnno.kind;
      docFile = directAnno.file;
      docNotes = directAnno.notes;
      annotatedByDoc++;
    } else {
      // Try prefix match (URL-parity-only docs)
      for (const { prefix, anno } of prefixAnnos) {
        if (op.path === prefix || op.path.startsWith(prefix + '/') || op.path.startsWith(prefix + '?')) {
          docKind = anno.kind;
          docFile = anno.file;
          break;
        }
      }
    }

    // Tag from OpenAPI = controller for grouping
    const tag = (op.tags && op.tags[0]) || 'untagged';

    // Status: stubbed/parity → migrated stubbed; migrated → migrated; else look at history;
    // else "pending" (in OpenAPI but no doc covers it).
    let status: EndpointStatus = 'pending';
    let isStubbed = false;
    let expectedHttpStatus = 200;

    if (docKind === 'migrated') status = 'migrated';
    else if (docKind === 'stubbed' || docKind === 'parity-only') {
      status = 'migrated';
      isStubbed = true;
      expectedHttpStatus = 501;
    } else {
      // Try history annotation by tag
      const hist = historyAnno.get(tag) || historyAnno.get(tag + 'Service') || historyAnno.get(tag + 'Controller');
      if (hist) {
        status = hist.status;
        if (hist.status === 'skip' || hist.status === 'defer') continue; // skip these
        annotatedByHistory++;
      }
    }

    if (isStubbed) stubbed++;
    if (status === 'pending') pending++;

    const responseSchema = getResponseSchema(op, openApi);

    endpoints.push({
      id: endpointId(op.method, op.path),
      controller: tag,
      file: docFile,
      docFile,
      method: op.method as HttpMethod,
      path: op.path,
      status,
      expectedHttpStatus,
      isStubbed,
      source: openApiPath || 'openapi',
      notes: docNotes || op.summary,
      operationId: op.operationId,
      tag,
      summary: op.summary,
      hasResponseSchema: !!responseSchema,
    });
  }

  sources.push({ file: openApiPath!, count: endpoints.length });
  if (annotatedByDoc > 0) sources.push({ file: config.endpointSource.primary, count: annotatedByDoc });
  if (annotatedByHistory > 0 && config.endpointSource.fallback) {
    sources.push({ file: config.endpointSource.fallback, count: annotatedByHistory });
  }

  return {
    endpoints,
    warnings,
    sources,
    stats: {
      fromOpenApi: openApi.operations.length,
      annotatedByDoc,
      annotatedByHistory,
      stubbed,
      pending,
    },
  };
}

// ── Legacy doc-only discovery (when no OpenAPI is configured) ──

function legacyDocDiscovery(projectPath: string, config: MigrationConfig): DiscoveryResult {
  const warnings: string[] = [];
  const sources: { file: string; count: number }[] = [];
  const all: Endpoint[] = [];
  const seen = new Set<string>();
  const stubbed = { n: 0 };

  const docAnno = parsePerControllerDocs(projectPath, config.endpointSource.primary);
  warnings.push(...docAnno.warnings);

  for (const [key, anno] of docAnno.byKey) {
    if (key.startsWith('__PREFIX__ ')) continue;
    const [method, path] = key.split(' ');
    const id = endpointId(method, path);
    if (seen.has(id)) continue;
    seen.add(id);
    const isStubbed = anno.kind === 'stubbed' || anno.kind === 'parity-only';
    if (isStubbed) stubbed.n++;
    all.push({
      id, controller: anno.controller, file: anno.file, docFile: anno.file,
      method: method as HttpMethod, path,
      status: 'migrated',
      expectedHttpStatus: isStubbed ? 501 : 200,
      isStubbed,
      source: anno.file,
      notes: anno.notes,
    });
  }
  if (all.length > 0) sources.push({ file: config.endpointSource.primary, count: all.length });

  return {
    endpoints: all,
    warnings,
    sources,
    stats: {
      fromOpenApi: 0,
      annotatedByDoc: all.length,
      annotatedByHistory: 0,
      stubbed: stubbed.n,
      pending: 0,
    },
  };
}
