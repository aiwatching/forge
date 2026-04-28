// HTTP runner — fires the same path against legacy + new and compares.
// diffMode controls how comparison happens:
//   exact = fire both, deep-equal JSON
//   shape = fire only `next`, validate response against OpenAPI schema (legacy not needed)
//   both  = fire both + schema validation

import type { Endpoint, MigrationConfig, RunResult, SideResult } from './types';
import { diff, validateAgainstSchema, type SchemaViolation } from './differ';

function compileIgnore(patterns: string[]): RegExp[] {
  return patterns.map(p => {
    const body = p.startsWith('$') ? p.slice(1) : p;
    const escaped = body
      .replace(/\./g, '\\.')
      .replace(/\[\*\]/g, '\\[\\d+\\]')
      .replace(/\[(\d+)\]/g, '\\[$1\\]');
    return new RegExp(`^\\$${escaped}$`);
  });
}
import { loadOpenApi, lookup, getResponseSchema, type OpenApiDoc } from './openapi';

function substitutePath(path: string, subs: Record<string, string> = {}): string {
  return path.replace(/\{([^}]+)\}/g, (_, name) => subs[name] ?? subs.id ?? '1');
}

function buildHeaders(config: MigrationConfig): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (config.auth.mode === 'bearer' && config.auth.tokenEnv) {
    const tok = process.env[config.auth.tokenEnv];
    if (tok) headers['Authorization'] = `Bearer ${tok}`;
  } else if (config.auth.mode === 'basic' && config.auth.username && config.auth.passwordEnv) {
    const pw = process.env[config.auth.passwordEnv];
    if (pw) {
      const b64 = Buffer.from(`${config.auth.username}:${pw}`).toString('base64');
      headers['Authorization'] = `Basic ${b64}`;
    }
  }
  return headers;
}

async function fetchOne(baseUrl: string, ep: Endpoint, config: MigrationConfig, timeout: number): Promise<SideResult> {
  const path = substitutePath(ep.path, config.pathSubstitutions);
  const url = baseUrl.replace(/\/+$/, '') + path;
  const start = Date.now();
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  const requestHeaders = buildHeaders(config);
  try {
    const resp = await fetch(url, {
      method: ep.method,
      headers: requestHeaders,
      signal: ctrl.signal,
    });
    const text = await resp.text();
    let bodyJson: any = undefined;
    try { bodyJson = text ? JSON.parse(text) : undefined; } catch {}
    const responseHeaders: Record<string, string> = {};
    resp.headers.forEach((v, k) => { responseHeaders[k] = v; });
    return {
      url, method: ep.method, status: resp.status, statusText: resp.statusText, ok: resp.ok,
      requestHeaders, responseHeaders,
      bodyExcerpt: text.slice(0, 8192),
      bodyJson,
      durationMs: Date.now() - start,
    };
  } catch (e: any) {
    return {
      url, method: ep.method, status: 0, ok: false,
      requestHeaders,
      error: e?.name === 'AbortError' ? `timeout after ${timeout}ms` : (e?.message || String(e)),
      durationMs: Date.now() - start,
    };
  } finally {
    clearTimeout(t);
  }
}

// Convert SchemaViolation[] → DiffEntry[] so the UI can show them uniformly.
function violationsToDiffs(vios: SchemaViolation[]): RunResult['diff'] {
  return vios.slice(0, 50).map(v => ({
    jsonPath: v.jsonPath,
    legacy: v.expected,
    next: v.actual,
    reason: v.reason === 'missing-required' ? 'missing-in-next' :
            v.reason === 'type-mismatch' ? 'type-mismatch' : 'value',
  }));
}

export async function runEndpoint(ep: Endpoint, config: MigrationConfig, openApi?: OpenApiDoc | null): Promise<RunResult> {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const mode = config.diffMode || 'exact';

  let legacy: SideResult;
  let next: SideResult;

  if (mode === 'shape') {
    // Skip legacy entirely — use a synthesized "n/a" SideResult
    legacy = { url: '(skipped — shape mode)', status: 0, ok: true, durationMs: 0 };
    next = await fetchOne(config.next.baseUrl, ep, config, config.healthCheck.newTimeout);
  } else {
    [legacy, next] = await Promise.all([
      fetchOne(config.legacy.baseUrl, ep, config, config.healthCheck.legacyTimeout),
      fetchOne(config.next.baseUrl, ep, config, config.healthCheck.newTimeout),
    ]);
  }

  let match: RunResult['match'] = 'pass';
  let errorType: string | undefined;
  let errorMessage: string | undefined;
  let diffEntries: RunResult['diff'];

  // ── Stubbed: only the new side matters; expect 501 ──
  if (ep.isStubbed) {
    if (next.error) {
      match = 'error'; errorType = 'new-unreachable'; errorMessage = next.error;
    } else if (next.status === 501) {
      match = 'stub-ok';
    } else {
      match = 'fail'; errorType = 'stub-not-501'; errorMessage = `Expected 501, got ${next.status}`;
    }
  }
  // ── Shape mode: validate new against OpenAPI schema ──
  else if (mode === 'shape') {
    if (next.error) {
      match = 'error'; errorType = 'new-unreachable'; errorMessage = next.error;
    } else if (!(next.status >= 200 && next.status < 300)) {
      match = 'fail'; errorType = 'http-status'; errorMessage = `HTTP ${next.status}`;
    } else {
      const schema = openApi ? getOpResponseSchema(openApi, ep) : null;
      if (!schema) {
        // No schema — treat as smoke pass (endpoint responded 2xx with no body check)
        match = 'pass';
      } else {
        const vios = validateAgainstSchema(next.bodyJson, schema, '$', [], compileIgnore(config.ignorePaths));
        if (vios.length > 0) {
          match = 'fail';
          errorType = 'schema-violation';
          errorMessage = `${vios.length} schema violations`;
          diffEntries = violationsToDiffs(vios);
        }
      }
    }
  }
  // ── Exact / both: deep-equal both sides + optional schema validation ──
  else {
    if (legacy.error || next.error) {
      match = 'error';
      errorType = legacy.error ? 'legacy-unreachable' : 'new-unreachable';
      errorMessage = legacy.error || next.error;
    } else if (legacy.status !== next.status) {
      match = 'fail';
      errorType = 'http-status-mismatch';
      errorMessage = `legacy=${legacy.status} new=${next.status}`;
    } else {
      const d = diff(legacy.bodyJson, next.bodyJson, config.ignorePaths, { sortArrays: true });
      if (d.length > 0) {
        match = 'fail';
        errorType = 'json-diff';
        errorMessage = `${d.length} differences`;
        diffEntries = d.slice(0, 50);
      }
      // In `both` mode also run schema validation on the new side
      if (mode === 'both' && openApi) {
        const schema = getOpResponseSchema(openApi, ep);
        if (schema) {
          const vios = validateAgainstSchema(next.bodyJson, schema, '$', [], compileIgnore(config.ignorePaths));
          if (vios.length > 0 && match === 'pass') {
            match = 'fail';
            errorType = 'schema-violation';
            errorMessage = `${vios.length} schema violations`;
            diffEntries = violationsToDiffs(vios);
          }
        }
      }
    }
  }

  return {
    endpointId: ep.id,
    startedAt,
    durationMs: Date.now() - t0,
    legacy, next, match,
    diff: diffEntries,
    errorType,
    errorMessage,
  };
}

function getOpResponseSchema(openApi: OpenApiDoc, ep: Endpoint): any | null {
  const op = lookup(openApi, ep.method, ep.path);
  if (!op) return null;
  return getResponseSchema(op, openApi);
}

export async function runEndpoints(eps: Endpoint[], config: MigrationConfig, opts: {
  concurrency?: number;
  onProgress?: (done: number, total: number, last: RunResult) => void;
  projectPath?: string;
} = {}): Promise<RunResult[]> {
  const concurrency = Math.max(1, opts.concurrency ?? 4);
  const results: RunResult[] = [];
  let done = 0;
  let i = 0;

  // Load OpenAPI once for the whole batch (shape/both modes)
  let openApi: OpenApiDoc | null = null;
  if ((config.diffMode === 'shape' || config.diffMode === 'both') && config.endpointSource.openApiSpec && opts.projectPath) {
    openApi = loadOpenApi(opts.projectPath, config.endpointSource.openApiSpec);
  }

  async function worker() {
    while (true) {
      const idx = i++;
      if (idx >= eps.length) return;
      const r = await runEndpoint(eps[idx], config, openApi);
      results[idx] = r;
      done++;
      opts.onProgress?.(done, eps.length, r);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, eps.length) }, worker));
  return results;
}
