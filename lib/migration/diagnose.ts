// Build a rich diagnosis prompt for one (or more) failing endpoints.
// Forge's role: hand the project's Claude session ALL the test-side context
// (request, actual response, expected schema, OpenAPI metadata).
// The project's own CLAUDE.md drives where source lives and how to fix.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Endpoint, RunResult, MigrationConfig } from './types';
import { loadOpenApi, lookup, getResponseSchema, type OpenApiDoc } from './openapi';
import { loadEndpoints, loadConfig, listRuns, loadRun } from './store';

export interface DiagnosisContext {
  endpoint: Endpoint;
  result?: RunResult;
  schema?: any;
  operationId?: string;
  tag?: string;
  parameters?: any[];
  docContent?: string;
  docPath?: string;
  curlCommand: string;
}

function substitutePath(path: string, subs: Record<string, string> = {}): string {
  return path.replace(/\{([^}]+)\}/g, (_, name) => subs[name] ?? subs.id ?? '1');
}

function buildCurl(baseUrl: string, ep: Endpoint, config: MigrationConfig): string {
  const path = substitutePath(ep.path, config.pathSubstitutions);
  const url = baseUrl.replace(/\/+$/, '') + path;
  const parts = ['curl', '-i', '-X', ep.method, JSON.stringify(url), '-H', '"Accept: application/json"'];
  if (config.auth.mode === 'bearer' && config.auth.tokenEnv) {
    parts.push('-H', `"Authorization: Bearer $${config.auth.tokenEnv}"`);
  }
  return parts.join(' ');
}

function findLatestResultForEndpoint(projectPath: string, endpointId: string): RunResult | undefined {
  const runs = listRuns(projectPath);
  // Newest first by name (timestamps in filenames)
  const sorted = [...runs].sort((a, b) => b.name.localeCompare(a.name));
  for (const r of sorted) {
    const results = loadRun(r.path);
    const found = results.find(x => x.endpointId === endpointId);
    if (found) return found;
  }
  return undefined;
}

export function buildDiagnosisContext(projectPath: string, endpointId: string): DiagnosisContext | null {
  const config = loadConfig(projectPath);
  const eps = loadEndpoints(projectPath);
  const ep = eps.find(e => e.id === endpointId);
  if (!ep) return null;

  const result = findLatestResultForEndpoint(projectPath, endpointId);
  let openApi: OpenApiDoc | null = null;
  if (config.endpointSource.openApiSpec) {
    openApi = loadOpenApi(projectPath, config.endpointSource.openApiSpec);
  }
  let schema: any = undefined;
  let operationId: string | undefined;
  let tag: string | undefined;
  let parameters: any[] | undefined;
  if (openApi) {
    const op = lookup(openApi, ep.method, ep.path);
    if (op) {
      schema = getResponseSchema(op, openApi);
      operationId = op.operationId;
      tag = op.tags?.[0];
      parameters = op.parameters;
    }
  }

  let docContent: string | undefined;
  let docPath: string | undefined;
  if (ep.docFile) {
    docPath = join(config.endpointSource.primary, ep.docFile);
    const full = join(projectPath, docPath);
    if (existsSync(full)) {
      const c = readFileSync(full, 'utf8');
      // Cap at 8KB to avoid blowing the prompt budget
      docContent = c.length > 8192 ? c.slice(0, 8192) + '\n\n…(truncated)' : c;
    }
  }

  const curlCommand = buildCurl(config.next.baseUrl, ep, config);

  return {
    endpoint: ep,
    result,
    schema,
    operationId,
    tag,
    parameters,
    docContent,
    docPath,
    curlCommand,
  };
}

// ── Prompt rendering ────────────────────────────────────

function fence(lang: string, body: string): string {
  return '```' + lang + '\n' + body + '\n```';
}

function summarizeResult(r: RunResult | undefined): string {
  if (!r) return '_(no run result yet — endpoint has not been tested)_';
  const lines: string[] = [];
  lines.push(`**Last run**: ${r.startedAt} (${r.durationMs}ms) — match=\`${r.match}\`${r.errorType ? ` · ${r.errorType}` : ''}`);
  if (r.errorMessage) lines.push(`**Error**: ${r.errorMessage}`);
  lines.push('');
  lines.push(`**New side**: ${r.next.url}`);
  lines.push(`HTTP \`${r.next.status}\` · ${r.next.durationMs}ms${r.next.error ? ` · ${r.next.error}` : ''}`);
  if (r.next.bodyExcerpt) {
    lines.push('Response body:');
    lines.push(fence('json', r.next.bodyExcerpt.slice(0, 4000)));
  }
  if (r.legacy.url && !r.legacy.url.startsWith('(skipped')) {
    lines.push(`**Legacy side**: ${r.legacy.url}`);
    lines.push(`HTTP \`${r.legacy.status}\` · ${r.legacy.durationMs}ms${r.legacy.error ? ` · ${r.legacy.error}` : ''}`);
    if (r.legacy.bodyExcerpt) {
      lines.push('Response body:');
      lines.push(fence('json', r.legacy.bodyExcerpt.slice(0, 4000)));
    }
  }
  if (r.diff && r.diff.length > 0) {
    lines.push('');
    lines.push(`**Diffs / violations** (${r.diff.length} total, showing up to 30):`);
    for (const d of r.diff.slice(0, 30)) {
      lines.push(`- \`${d.jsonPath}\`: ${d.reason} — expected \`${JSON.stringify(d.legacy)}\`, got \`${JSON.stringify(d.next)}\``);
    }
  }
  return lines.join('\n');
}

export function renderDiagnosisMarkdown(ctx: DiagnosisContext): string {
  const ep = ctx.endpoint;
  const lines: string[] = [];

  lines.push(`# Migration parity failure: \`${ep.method} ${ep.path}\``);
  lines.push('');
  lines.push('> Sent by the Forge Migration Cockpit. Forge ran the parity test and captured what you see below. **Use this project\'s own CLAUDE.md, migration playbook, and source-layout conventions to locate the relevant code and apply the fix.** Forge intentionally does not assume your file paths.');
  lines.push('');
  lines.push(`- **Controller / tag**: \`${ep.controller}\``);
  if (ctx.operationId) lines.push(`- **OpenAPI operationId**: \`${ctx.operationId}\``);
  lines.push(`- **Status**: \`${ep.status}\`${ep.isStubbed ? ' · stubbed (expects 501)' : ''}`);
  if (ep.summary) lines.push(`- **Summary**: ${ep.summary}`);
  if (ctx.docPath) lines.push(`- **Migration doc** (already in this project): \`${ctx.docPath}\``);
  lines.push('');

  lines.push('## Reproduce manually');
  lines.push(fence('bash', ctx.curlCommand));
  lines.push('');

  lines.push('## Run result (captured by Forge)');
  lines.push(summarizeResult(ctx.result));
  lines.push('');

  if (ctx.schema) {
    lines.push('## Expected response schema (from OpenAPI)');
    lines.push(fence('json', JSON.stringify(ctx.schema, null, 2).slice(0, 4000)));
    lines.push('');
  }

  if (ctx.parameters && ctx.parameters.length > 0) {
    lines.push('## OpenAPI parameters');
    lines.push(fence('json', JSON.stringify(ctx.parameters, null, 2)));
    lines.push('');
  }

  if (ctx.docContent) {
    lines.push('## Migration doc content (snippet)');
    lines.push(fence('markdown', ctx.docContent));
    lines.push('');
  }

  lines.push('## What to do');
  lines.push('1. Consult this project\'s CLAUDE.md and migration playbook (the docs/ folder) to locate the legacy and new-side source for this controller.');
  lines.push('2. Compare the actual response body to the expected schema above. Identify which fields mismatch.');
  lines.push('3. Apply a minimal fix in the new module per the project\'s migration rules. Legacy is the contract — do not modify it.');
  lines.push('4. Re-run the parity test from the Forge Migration Cockpit to confirm.');
  lines.push('');
  lines.push('Report back with: files edited, the specific fix in 1-2 sentences, and any assumption you had to make.');

  return lines.join('\n');
}

export function renderBatchDiagnosis(ctxs: DiagnosisContext[]): string {
  const lines: string[] = [];
  lines.push(`# Migration parity batch fix — ${ctxs.length} failing endpoints`);
  lines.push('');
  lines.push('Each section below contains one failing endpoint with its actual response, expected schema, source paths, and migration doc. Fix them one at a time; legacy code MUST NOT be modified.');
  lines.push('');
  for (const ctx of ctxs) {
    lines.push('---');
    lines.push('');
    lines.push(renderDiagnosisMarkdown(ctx));
    lines.push('');
  }
  return lines.join('\n');
}
