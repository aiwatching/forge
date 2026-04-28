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

// ── Failure categorization ─────────────────────────────
// Pick the right "playbook" based on what actually went wrong.

export type FailureCategory =
  | 'no-result'                       // never been tested
  | 'pass'                            // shouldn't generate a fix prompt
  | 'new-unreachable'                 // server down / wrong baseUrl
  | 'legacy-unreachable'              // legacy down (only matters in exact mode)
  | 'http-5xx'                        // exception in handler
  | 'http-404'                        // route not registered
  | 'http-401-403'                    // auth blocked
  | 'http-other'                      // other 4xx
  | 'http-status-mismatch'            // exact mode: legacy vs new differ
  | 'stub-not-501'                    // stubbed endpoint returned non-501
  | 'schema-violation-types'          // mostly type-mismatch
  | 'schema-violation-missing'        // mostly missing-required
  | 'schema-violation-enum'           // mostly enum-mismatch
  | 'schema-violation-mixed'          // mix of reasons
  | 'json-diff-values'                // exact mode: deep-equal failed
  | 'unknown-fail';

export function categorizeFailure(ctx: DiagnosisContext): FailureCategory {
  const r = ctx.result;
  if (!r) return 'no-result';
  if (r.match === 'pass' || r.match === 'stub-ok') return 'pass';

  if (r.errorType === 'new-unreachable') return 'new-unreachable';
  if (r.errorType === 'legacy-unreachable') return 'legacy-unreachable';
  if (r.errorType === 'stub-not-501') return 'stub-not-501';
  if (r.errorType === 'http-status-mismatch') return 'http-status-mismatch';

  if (r.errorType === 'http-status') {
    const code = r.next.status;
    if (code >= 500) return 'http-5xx';
    if (code === 404) return 'http-404';
    if (code === 401 || code === 403) return 'http-401-403';
    return 'http-other';
  }

  if (r.errorType === 'schema-violation' && r.diff && r.diff.length > 0) {
    const reasons = r.diff.map(d => d.reason);
    const allMissing = reasons.every(x => x === 'missing-in-next');
    const allTypes = reasons.every(x => x === 'type-mismatch');
    // For schema-violation we encoded reasons via violationsToDiffs — but enum-mismatch maps to 'value' there
    const enumLike = r.diff.filter(d => /enum/i.test(String(d.legacy))).length;
    if (allMissing) return 'schema-violation-missing';
    if (allTypes) return 'schema-violation-types';
    if (enumLike > r.diff.length / 2) return 'schema-violation-enum';
    return 'schema-violation-mixed';
  }

  if (r.errorType === 'json-diff') return 'json-diff-values';
  return 'unknown-fail';
}

// Per-category targeted instructions. Each returns a "What to investigate / try" block.
function targetedPlaybook(cat: FailureCategory, ctx: DiagnosisContext): string[] {
  const r = ctx.result;
  const ep = ctx.endpoint;
  const lines: string[] = [];

  switch (cat) {
    case 'new-unreachable':
      lines.push('### Likely cause: the new server is not running or wrong baseUrl');
      lines.push(`The fetch failed before any HTTP exchange happened. Forge tried \`${r?.next.url}\`.`);
      lines.push('');
      lines.push('Investigate in this order:');
      lines.push(`1. Is the new web-server actually running? \`curl -i ${r?.next.url}\` from a shell — same error?`);
      lines.push('2. Is the configured `next.baseUrl` pointing at the right port/host?');
      lines.push('3. If the server is running but this specific port isn\'t listening, check the server boot logs.');
      lines.push('4. If only this controller fails: maybe the controller isn\'t mounted (no `@RestController` / wrong package scan).');
      lines.push('');
      lines.push('No need to read source code yet — fix the connectivity first, then re-run the cockpit.');
      break;

    case 'legacy-unreachable':
      lines.push('### Likely cause: legacy server is down');
      lines.push('You\'re running in `exact` or `both` mode which requires hitting the legacy side. Either:');
      lines.push('- Start the legacy server, OR');
      lines.push('- Switch the cockpit to `shape` diff mode (Config → Diff mode) so legacy isn\'t needed.');
      break;

    case 'http-404':
      lines.push('### Likely cause: route not registered in the new module');
      lines.push(`The new server is up (received the request), but \`${ep.method} ${ep.path}\` returned 404.`);
      lines.push('');
      lines.push('Investigate:');
      lines.push('1. Has this controller been migrated yet? Check this project\'s migration tracker (e.g. `docs/lead/migration-history.md`).');
      lines.push('2. If it should be migrated: is it in the component scan? Is the `@RequestMapping` / `@GetMapping` path correct? Does it have a leading slash?');
      lines.push('3. Compare against the OpenAPI path above — Spring path templates use `{id}` (same as OpenAPI) but watch for `:id` vs `{id}` confusion.');
      lines.push('');
      lines.push('If the controller hasn\'t been migrated, say so and stop — don\'t invent code.');
      break;

    case 'http-5xx': {
      const body = r?.next.bodyExcerpt || '';
      lines.push('### Likely cause: handler threw an exception');
      lines.push(`The new server returned HTTP \`${r?.next.status}\`. The response body usually contains the stack trace or error message — read it carefully (it\'s in the "Run result" section above).`);
      lines.push('');
      lines.push('Investigate:');
      lines.push('1. Find the exception class and message in the response body.');
      lines.push('2. Open the controller for this endpoint — what does the failing line do?');
      lines.push('3. Common causes after migration: missing `@Service` bean, NPE because a DAO returned `null`, JPA query mismatch, type cast failure.');
      if (/NullPointerException|NPE/.test(body)) lines.push('4. **NPE detected in body** — trace which collaborator returned null; usually a service that wasn\'t wired up.');
      if (/NoSuchBeanDefinition|UnsatisfiedDependency/.test(body)) lines.push('4. **Spring DI failure** — a bean isn\'t available; check `@Autowired`/`@Service` or component scan.');
      if (/SQLException|JpaSystemException|QueryException/.test(body)) lines.push('4. **JPA/SQL error** — the migrated DAO query probably needs adjusting; check entity/column names.');
      break;
    }

    case 'http-401-403':
      lines.push('### Likely cause: security blocking the request');
      lines.push(`The endpoint requires auth that\'s either misconfigured in the new module or not being supplied. Forge sent: ${r?.next.requestHeaders?.Authorization ? 'Authorization header' : 'no Authorization header'}.`);
      lines.push('');
      lines.push('Investigate:');
      lines.push('1. Cockpit auth mode in Config — for parity testing in dev, you usually want to set the new module\'s security to `permitAll` for these paths.');
      lines.push('2. If auth IS required: set `auth.mode = bearer` in cockpit Config and provide `tokenEnv`.');
      lines.push('3. Check if a security filter in the new module rejects unauthenticated requests differently than legacy.');
      break;

    case 'http-other':
      lines.push(`### HTTP \`${r?.next.status}\` — read the response body for the error envelope.`);
      lines.push('Look for an error message / code in the body, then trace where in the controller/service that error originates.');
      break;

    case 'http-status-mismatch':
      lines.push('### Likely cause: status code logic differs from legacy');
      lines.push(`Legacy returned \`${r?.legacy.status}\`, new returned \`${r?.next.status}\`.`);
      lines.push('');
      lines.push('Investigate:');
      lines.push('1. Compare both response bodies above — the new side is probably throwing on a condition that legacy gracefully handles (or vice versa).');
      lines.push('2. Check error/exception mapping. Legacy likely has a different `ExceptionMapper` / `@ControllerAdvice` shape.');
      lines.push('3. Empty results: legacy returns 200 with empty `results: []`, new might 404. Or 400 vs 200 for invalid filter.');
      break;

    case 'stub-not-501':
      lines.push('### A "stubbed" endpoint actually returned a real response');
      lines.push(`The migration doc / OpenAPI marks \`${ep.method} ${ep.path}\` as stubbed (should return 501), but it returned \`${r?.next.status}\`.`);
      lines.push('');
      lines.push('Two valid outcomes:');
      lines.push('- The endpoint really IS migrated now → update the migration doc to move it from "Stubbed" to "Migrated", then re-run.');
      lines.push('- It shouldn\'t be — find what removed the 501 stub and revert (or restore the explicit `ResponseEntity.status(NOT_IMPLEMENTED)`).');
      break;

    case 'schema-violation-types': {
      const examples = (r?.diff || []).slice(0, 5).map(d => `\`${d.jsonPath}\` (expected ${d.legacy}, got ${d.next})`).join(', ');
      lines.push('### Likely cause: DTO field types don\'t match the spec');
      lines.push(`All ${r?.diff?.length} mismatches are type errors. Examples: ${examples}.`);
      lines.push('');
      lines.push('Investigate:');
      lines.push('1. Find the response DTO class. Compare each Java field type against the OpenAPI schema above.');
      lines.push('2. Common culprits: `Integer` vs `String` for IDs, `Long` vs `String` for timestamps, `Boolean` vs `String` (`"true"`).');
      lines.push('3. If the spec is wrong (e.g. legacy actually returns `Integer` and the spec says `string`), DON\'T change the spec — add the path to `ignorePaths` in the cockpit Config.');
      break;
    }

    case 'schema-violation-missing': {
      const fields = (r?.diff || []).slice(0, 8).map(d => `\`${d.jsonPath}\``).join(', ');
      lines.push('### Likely cause: required fields not populated in the response');
      lines.push(`Missing required fields: ${fields}${(r?.diff?.length ?? 0) > 8 ? ' …' : ''}.`);
      lines.push('');
      lines.push('Investigate:');
      lines.push('1. Look at the new module\'s mapper / DTO assembler for this endpoint.');
      lines.push('2. Compare to the legacy mapper — which fields are dropped?');
      lines.push('3. Likely causes: an Entity → DTO mapping that lost a field; a `@JsonInclude(NON_NULL)` swallowing legitimate nulls; a service returning a partial DTO.');
      break;
    }

    case 'schema-violation-enum': {
      lines.push('### Likely cause: enum values out of spec');
      lines.push('Some response field returned a value not declared in the OpenAPI enum.');
      lines.push('');
      lines.push('Investigate:');
      lines.push('1. Find the enum class (Java) for the violating field. Check whether the migration changed any constant names/values.');
      lines.push('2. If new module returns `"PENDING"` but legacy returns `"pending"` — case sensitivity.');
      lines.push('3. If the spec\'s enum is incomplete (legacy returns more values than spec lists), the spec is wrong; consider widening it OR adding to `ignorePaths`.');
      break;
    }

    case 'schema-violation-mixed':
      lines.push('### Multiple shape problems — likely a wholesale DTO mismatch');
      lines.push('Mix of missing fields, type mismatches and/or enum violations. The DTO and the spec disagree on multiple axes.');
      lines.push('');
      lines.push('Investigate:');
      lines.push('1. Compare the actual response body (above) against the schema (above) side by side — easier than reading individual violations.');
      lines.push('2. Often the new module is using a different DTO class (or no DTO, returning the entity directly).');
      lines.push('3. Verify Jackson/serialization annotations on the DTO match what legacy uses (`@JsonProperty`, `@JsonIgnore`, naming strategy).');
      break;

    case 'json-diff-values':
      lines.push('### Likely cause: same shape, different values');
      lines.push('HTTP status and structure match between legacy and new, but specific field values differ. The diff table above shows exactly which paths differ.');
      lines.push('');
      lines.push('Investigate:');
      lines.push('1. Are the diffs in fields that should be deterministic (IDs, names) or should they be ignored (timestamps, request IDs)?');
      lines.push('2. For ignorable fields, add jsonpath to `ignorePaths`.');
      lines.push('3. For real differences: look at the DAO query / service logic — is the new module pulling from a different source, applying different sorting/filtering, or using stale data?');
      break;

    case 'no-result':
      lines.push('### No run result yet — run the endpoint first and re-open this drawer.');
      break;

    case 'pass':
      lines.push('### This endpoint already passes — no fix needed.');
      break;

    default:
      lines.push('### Generic guidance');
      lines.push('The failure category isn\'t recognized. Read the run result above, then consult the project\'s migration playbook.');
  }

  return lines;
}

export function renderDiagnosisMarkdown(ctx: DiagnosisContext, opts: { generic?: boolean } = {}): string {
  const ep = ctx.endpoint;
  const cat = categorizeFailure(ctx);
  const lines: string[] = [];

  lines.push(`# Migration parity failure: \`${ep.method} ${ep.path}\``);
  if (!opts.generic) lines.push(`> Auto-tailored prompt — failure category: \`${cat}\``);
  lines.push('');
  lines.push('> Sent by the Forge Migration Cockpit. Use this project\'s CLAUDE.md and migration playbook to locate source files. Forge does not assume paths.');
  lines.push('');
  lines.push(`- **Controller / tag**: \`${ep.controller}\``);
  if (ctx.operationId) lines.push(`- **OpenAPI operationId**: \`${ctx.operationId}\``);
  lines.push(`- **Status**: \`${ep.status}\`${ep.isStubbed ? ' · stubbed (expects 501)' : ''}`);
  if (ep.summary) lines.push(`- **Summary**: ${ep.summary}`);
  if (ctx.docPath) lines.push(`- **Migration doc** (this project): \`${ctx.docPath}\``);
  lines.push('');

  lines.push('## Reproduce manually');
  lines.push(fence('bash', ctx.curlCommand));
  lines.push('');

  lines.push('## Run result (captured by Forge)');
  lines.push(summarizeResult(ctx.result));
  lines.push('');

  // Schema is only relevant for shape-mode failures + value diffs
  const schemaRelevant = !opts.generic ? (
    cat.startsWith('schema-violation') ||
    cat === 'json-diff-values' ||
    cat === 'http-status-mismatch'
  ) : true;
  if (ctx.schema && schemaRelevant) {
    lines.push('## Expected response schema (from OpenAPI)');
    lines.push(fence('json', JSON.stringify(ctx.schema, null, 2).slice(0, 4000)));
    lines.push('');
  }

  // Parameters + doc snippet only for cases where source code is involved
  const sourceRelevant = !opts.generic ? (
    cat === 'http-5xx' || cat === 'http-404' ||
    cat.startsWith('schema-violation') ||
    cat === 'json-diff-values' || cat === 'http-status-mismatch' ||
    cat === 'stub-not-501'
  ) : true;
  if (sourceRelevant) {
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
  }

  lines.push('## What to do');
  if (opts.generic) {
    lines.push('1. Consult this project\'s CLAUDE.md and migration playbook to locate the legacy and new-side source.');
    lines.push('2. Compare the actual response body to the expected schema. Identify which fields mismatch.');
    lines.push('3. Apply a minimal fix in the new module per the project\'s migration rules. Legacy is the contract — do not modify it.');
    lines.push('4. Re-run the parity test from the Forge Migration Cockpit to confirm.');
  } else {
    lines.push(...targetedPlaybook(cat, ctx));
  }
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
