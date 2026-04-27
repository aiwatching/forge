// OpenAPI 3.x loader + $ref resolver + per-(method, path) indexer.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface OpenApiOperation {
  method: string;                          // upper-case
  path: string;                            // raw OpenAPI path with {id} placeholders
  operationId?: string;
  tags?: string[];
  summary?: string;
  responses: Record<string, OpenApiResponse>;
  parameters?: OpenApiParameter[];
  requestBody?: any;
}

export interface OpenApiResponse {
  description?: string;
  content?: Record<string, { schema?: any }>;
}

export interface OpenApiParameter {
  name: string;
  in: 'query' | 'path' | 'header' | 'cookie';
  required?: boolean;
  schema?: any;
}

export interface OpenApiDoc {
  raw: any;
  operations: OpenApiOperation[];
  byKey: Map<string, OpenApiOperation>;     // key = "METHOD path"
  schemas: Record<string, any>;
}

const HTTP_METHODS = ['get', 'post', 'put', 'delete', 'patch', 'head', 'options'];

function operationKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}

export function loadOpenApi(projectPath: string, relativeFile: string): OpenApiDoc | null {
  const file = join(projectPath, relativeFile);
  if (!existsSync(file)) return null;
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  const operations: OpenApiOperation[] = [];
  const byKey = new Map<string, OpenApiOperation>();
  const paths = raw.paths || {};

  for (const [p, item] of Object.entries(paths) as [string, any][]) {
    for (const m of HTTP_METHODS) {
      const op = item[m];
      if (!op) continue;
      const operation: OpenApiOperation = {
        method: m.toUpperCase(),
        path: p,
        operationId: op.operationId,
        tags: op.tags,
        summary: op.summary,
        responses: op.responses || {},
        parameters: op.parameters,
        requestBody: op.requestBody,
      };
      operations.push(operation);
      byKey.set(operationKey(m, p), operation);
    }
  }

  return {
    raw,
    operations,
    byKey,
    schemas: raw.components?.schemas || {},
  };
}

// ── $ref resolution ─────────────────────────────────────
// "#/components/schemas/Foo" → schemas.Foo, recursively inlined.
// Tracks visited refs to break cycles (returns the partial node when re-entered).

export function resolveSchema(node: any, doc: OpenApiDoc, visited = new Set<string>()): any {
  if (node == null || typeof node !== 'object') return node;

  if (typeof node.$ref === 'string') {
    const ref = node.$ref;
    if (visited.has(ref)) return { __cycle: ref };
    visited.add(ref);
    const target = followRef(ref, doc.raw);
    if (!target) return { __unresolved: ref };
    return resolveSchema(target, doc, visited);
  }

  if (Array.isArray(node)) return node.map(x => resolveSchema(x, doc, visited));

  const out: any = {};
  for (const [k, v] of Object.entries(node)) {
    out[k] = resolveSchema(v, doc, visited);
  }
  return out;
}

function followRef(ref: string, root: any): any {
  if (!ref.startsWith('#/')) return null;
  const parts = ref.slice(2).split('/');
  let cur = root;
  for (const p of parts) {
    if (cur == null) return null;
    cur = cur[decodeURIComponent(p.replace(/~1/g, '/').replace(/~0/g, '~'))];
  }
  return cur;
}

// ── Response schema extraction ──────────────────────────
// Pick the "main" success response (default → 200 → first 2xx → first one).

export function pickSuccessResponse(op: OpenApiOperation): OpenApiResponse | null {
  const r = op.responses;
  if (!r) return null;
  if (r.default) return r.default;
  if (r['200']) return r['200'];
  for (const code of Object.keys(r)) {
    if (/^2\d\d$/.test(code)) return r[code];
  }
  return r[Object.keys(r)[0]] || null;
}

export function getResponseSchema(op: OpenApiOperation, doc: OpenApiDoc): any | null {
  const resp = pickSuccessResponse(op);
  if (!resp || !resp.content) return null;
  const json = resp.content['application/json'] || resp.content['*/*'];
  if (!json?.schema) return null;
  return resolveSchema(json.schema, doc);
}

export function lookup(doc: OpenApiDoc, method: string, path: string): OpenApiOperation | null {
  return doc.byKey.get(operationKey(method, path)) || null;
}
