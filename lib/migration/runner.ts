// HTTP runner — fires the same path against legacy + new and compares.

import type { Endpoint, MigrationConfig, RunResult, SideResult } from './types';
import { diff } from './differ';

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
  try {
    const resp = await fetch(url, {
      method: ep.method,
      headers: buildHeaders(config),
      signal: ctrl.signal,
    });
    const text = await resp.text();
    let bodyJson: any = undefined;
    try { bodyJson = text ? JSON.parse(text) : undefined; } catch {}
    return {
      url, status: resp.status, ok: resp.ok,
      bodyExcerpt: text.slice(0, 4096),
      bodyJson,
      durationMs: Date.now() - start,
    };
  } catch (e: any) {
    return {
      url, status: 0, ok: false,
      error: e?.name === 'AbortError' ? `timeout after ${timeout}ms` : (e?.message || String(e)),
      durationMs: Date.now() - start,
    };
  } finally {
    clearTimeout(t);
  }
}

export async function runEndpoint(ep: Endpoint, config: MigrationConfig): Promise<RunResult> {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const [legacy, next] = await Promise.all([
    fetchOne(config.legacy.baseUrl, ep, config, config.healthCheck.legacyTimeout),
    fetchOne(config.next.baseUrl, ep, config, config.healthCheck.newTimeout),
  ]);

  let match: RunResult['match'] = 'pass';
  let errorType: string | undefined;
  let errorMessage: string | undefined;
  let diffEntries: any[] | undefined;

  if (legacy.error || next.error) {
    match = 'error';
    errorType = legacy.error ? 'legacy-unreachable' : 'new-unreachable';
    errorMessage = legacy.error || next.error;
  } else if (ep.isStubbed) {
    // Stubbed endpoints are expected to return 501 on the new side.
    if (next.status === 501) match = 'stub-ok';
    else { match = 'fail'; errorType = 'stub-not-501'; errorMessage = `Expected 501, got ${next.status}`; }
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

export async function runEndpoints(eps: Endpoint[], config: MigrationConfig, opts: {
  concurrency?: number;
  onProgress?: (done: number, total: number, last: RunResult) => void;
} = {}): Promise<RunResult[]> {
  const concurrency = Math.max(1, opts.concurrency ?? 4);
  const results: RunResult[] = [];
  let done = 0;
  let i = 0;

  async function worker() {
    while (true) {
      const idx = i++;
      if (idx >= eps.length) return;
      const r = await runEndpoint(eps[idx], config);
      results[idx] = r;
      done++;
      opts.onProgress?.(done, eps.length, r);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, eps.length) }, worker));
  return results;
}
