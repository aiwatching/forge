/**
 * Plugin Executor — runs plugin actions (http, poll, shell, script).
 *
 * Resolves templates ({{config.x}}, {{params.x}}) and executes the action.
 */

import { execSync } from 'node:child_process';
import type { PluginAction, PluginActionResult, InstalledPlugin } from './types';

// ─── Template Resolution ─────────────────────────────────

function resolveTemplate(template: string, ctx: Record<string, any>): string {
  return template.replace(/\{\{(\w+)\.(\w+)\}\}/g, (_, scope, key) => {
    return ctx[scope]?.[key] ?? '';
  }).replace(/\{\{(\w+)\s*\|\s*json\}\}/g, (_, scope) => {
    return JSON.stringify(ctx[scope] || {});
  });
}

function resolveObject(obj: Record<string, string> | undefined, ctx: Record<string, any>): Record<string, string> {
  if (!obj) return {};
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    result[k] = resolveTemplate(v, ctx);
  }
  return result;
}

// ─── JSONPath-like extraction ────────────────────────────

function extractValue(data: any, path: string): any {
  if (path === '$body' || path === '$stdout') return typeof data === 'string' ? data : JSON.stringify(data);
  if (path.startsWith('$.')) {
    const keys = path.slice(2).split('.');
    let current = data;
    for (const key of keys) {
      if (current == null) return undefined;
      current = current[key];
    }
    return current;
  }
  return data;
}

function extractOutputs(data: any, outputSpec: Record<string, string> | undefined): Record<string, any> {
  if (!outputSpec) return { result: data };
  const result: Record<string, any> = {};
  for (const [name, path] of Object.entries(outputSpec)) {
    result[name] = extractValue(data, path);
  }
  return result;
}

// ─── Executors ───────────────────────────────────────────

async function executeHttp(action: PluginAction, ctx: Record<string, any>): Promise<PluginActionResult> {
  const url = resolveTemplate(action.url || '', ctx);
  const method = (action.method || 'GET').toUpperCase();
  const headers = resolveObject(action.headers, ctx);
  const body = action.body ? resolveTemplate(action.body, ctx) : undefined;

  const startTime = Date.now();
  try {
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: method !== 'GET' ? body : undefined,
    });

    let data: any;
    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('json')) {
      data = await res.json();
    } else {
      data = await res.text();
    }

    return {
      ok: res.ok,
      output: extractOutputs(data, action.output),
      rawResponse: typeof data === 'string' ? data : JSON.stringify(data),
      duration: Date.now() - startTime,
    };
  } catch (err: any) {
    return { ok: false, output: {}, error: err.message, duration: Date.now() - startTime };
  }
}

async function executePoll(action: PluginAction, ctx: Record<string, any>): Promise<PluginActionResult> {
  const url = resolveTemplate(action.url || '', ctx);
  const headers = resolveObject(action.headers, ctx);
  const interval = (action.interval || 30) * 1000;
  const timeout = (action.timeout || 1800) * 1000;
  const untilExpr = action.until || '$.result != null';

  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    try {
      const res = await fetch(url, { headers });
      const data = await res.json();

      // Evaluate condition
      const conditionMet = evaluateCondition(data, untilExpr);
      if (conditionMet) {
        return {
          ok: true,
          output: extractOutputs(data, action.output),
          rawResponse: JSON.stringify(data),
          duration: Date.now() - startTime,
        };
      }
    } catch {}

    // Wait before next poll
    await new Promise(r => setTimeout(r, interval));
  }

  return { ok: false, output: {}, error: 'Poll timeout', duration: Date.now() - startTime };
}

function evaluateCondition(data: any, expr: string): boolean {
  // Simple condition parser: "$.field != null", "$.field == value"
  const match = expr.match(/^(\$\.[.\w]+)\s*(==|!=|>|<)\s*(.+)$/);
  if (!match) return false;
  const [, path, op, expected] = match;
  const actual = extractValue(data, path);
  const exp = expected === 'null' ? null : expected === 'true' ? true : expected === 'false' ? false : expected;

  switch (op) {
    case '==': return actual == exp;
    case '!=': return actual != exp;
    case '>': return Number(actual) > Number(exp);
    case '<': return Number(actual) < Number(exp);
    default: return false;
  }
}

function executeShell(action: PluginAction, ctx: Record<string, any>): PluginActionResult {
  const command = resolveTemplate(action.command || '', ctx);
  const rawCwd = action.cwd ? resolveTemplate(action.cwd, ctx) : '';
  const cwd = rawCwd || undefined;  // empty string → undefined (use process cwd)

  const startTime = Date.now();
  try {
    const stdout = execSync(command, {
      cwd,
      encoding: 'utf-8',
      timeout: (action.timeout || 300) * 1000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    return {
      ok: true,
      output: extractOutputs(stdout, action.output),
      rawResponse: stdout,
      duration: Date.now() - startTime,
    };
  } catch (err: any) {
    return {
      ok: false,
      output: {},
      error: err.message,
      rawResponse: err.stderr?.toString() || err.stdout?.toString() || '',
      duration: Date.now() - startTime,
    };
  }
}

// ─── Public API ──────────────────────────────────────────

/**
 * Execute a plugin action.
 * @param plugin - Installed plugin instance
 * @param actionName - Action to execute (e.g., 'trigger', 'wait')
 * @param params - Per-use parameters
 */
export async function executePluginAction(
  plugin: InstalledPlugin,
  actionName: string,
  params: Record<string, any> = {},
): Promise<PluginActionResult> {
  const action = plugin.definition.actions[actionName];
  if (!action) {
    return { ok: false, output: {}, error: `Action "${actionName}" not found in plugin "${plugin.id}"` };
  }

  const ctx = {
    config: plugin.config,
    params,
  };

  console.log(`[plugin] ${plugin.id}.${actionName}: executing (${action.run})`);

  switch (action.run) {
    case 'http':
      return executeHttp(action, ctx);
    case 'poll':
      return executePoll(action, ctx);
    case 'shell':
      return executeShell(action, ctx);
    case 'script':
      // TODO: implement script execution
      return { ok: false, output: {}, error: 'Script execution not yet implemented' };
    default:
      return { ok: false, output: {}, error: `Unknown action type: ${action.run}` };
  }
}

/**
 * Execute a plugin with auto-wait.
 * Runs the specified action, then if wait=true, runs the 'wait' action.
 */
export async function executePluginWithWait(
  plugin: InstalledPlugin,
  actionName: string,
  params: Record<string, any> = {},
  wait: boolean = false,
): Promise<PluginActionResult> {
  const result = await executePluginAction(plugin, actionName, params);
  if (!result.ok || !wait) return result;

  // Auto-wait: if plugin has a 'wait' action, run it
  if (plugin.definition.actions['wait']) {
    const waitResult = await executePluginAction(plugin, 'wait', params);
    return {
      ok: waitResult.ok,
      output: { ...result.output, ...waitResult.output },
      rawResponse: waitResult.rawResponse,
      duration: (result.duration || 0) + (waitResult.duration || 0),
      error: waitResult.error,
    };
  }

  return result;
}
