/**
 * Plugin Executor — runs plugin actions (http, poll, shell, script).
 *
 * Resolves templates ({{config.x}}, {{params.x}}) and executes the action.
 */

import { spawn } from 'node:child_process';
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

async function executeShell(action: PluginAction, ctx: Record<string, any>): Promise<PluginActionResult> {
  const command = resolveTemplate(action.command || '', ctx);
  const rawCwd = action.cwd ? resolveTemplate(action.cwd, ctx) : '';
  const cwd = rawCwd || undefined;

  const startTime = Date.now();
  const timeout = (action.timeout || 300) * 1000;

  return new Promise((resolve) => {
    let resolved = false;
    const done = (result: PluginActionResult) => {
      if (resolved) return;
      resolved = true;
      resolve(result);
    };

    try {
      // Use spawn with detached: true so the child gets its own process group.
      // This prevents crashes/signals in the child (e.g., Playwright browser crash)
      // from propagating to Forge's process group and killing sibling services.
      const child = spawn('/bin/sh', ['-c', command], {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, FORCE_COLOR: '0' },
        detached: true,
      });

      let stdout = '';
      let stderr = '';

      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf-8');
        // Cap buffer to prevent memory issues
        if (stdout.length > 10 * 1024 * 1024) {
          stdout = stdout.slice(-5 * 1024 * 1024);
        }
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf-8');
        if (stderr.length > 10 * 1024 * 1024) {
          stderr = stderr.slice(-5 * 1024 * 1024);
        }
      });

      console.log(`[plugin-shell] pid=${child.pid} pgid=new command=${command.slice(0, 80)}`);

      child.on('error', (e) => {
        console.log(`[plugin-shell] pid=${child.pid} error: ${e.message}`);
        done({
          ok: false,
          output: {},
          error: `Process error: ${e.message}`,
          duration: Date.now() - startTime,
        });
      });

      // Use 'close' instead of 'exit' to ensure all stdout/stderr data is collected
      child.on('close', (code, signal) => {
        child.unref();
        console.log(`[plugin-shell] pid=${child.pid} closed code=${code} signal=${signal} stdout=${stdout.length}b stderr=${stderr.length}b`);
        const combined = (stdout || stderr || '').trim();
        // Treat SIGTERM (143) with output as a normal completion — many test runners
        // and complex commands send SIGTERM to their process group during cleanup,
        // which kills the shell wrapper but doesn't indicate a real failure.
        const killedBySignal = code === null || code === 143 || code === 130;
        const hasOutput = combined.length > 0;
        const effectiveOk = code === 0 || (killedBySignal && hasOutput);

        done({
          ok: effectiveOk,
          output: extractOutputs(combined, action.output),
          error: effectiveOk ? undefined : (signal ? `Killed by ${signal}` : `Exit code ${code}`),
          rawResponse: combined.slice(0, 5000),
          duration: Date.now() - startTime,
        });
      });

      // Timeout: kill the child's process group
      const timer = setTimeout(() => {
        try { process.kill(-child.pid!, 'SIGTERM'); } catch {}
        setTimeout(() => {
          try { process.kill(-child.pid!, 'SIGKILL'); } catch {}
        }, 3000);
        done({
          ok: false,
          output: {},
          error: `Command timed out after ${timeout / 1000}s`,
          rawResponse: (stderr || stdout || '').slice(0, 5000),
          duration: Date.now() - startTime,
        });
      }, timeout);
      // Don't let the timer keep the process alive
      timer.unref();

      child.on('exit', () => clearTimeout(timer));
    } catch (e: any) {
      done({
        ok: false,
        output: {},
        error: `Failed to spawn: ${e.message}`,
        duration: Date.now() - startTime,
      });
    }
  });
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
  // Auto-resolve action by config.mode prefix: "test" → "docker_test" if mode=docker
  let action = plugin.definition.actions[actionName];
  if (!action && plugin.config.mode) {
    const modeAction = `${plugin.config.mode}_${actionName}`;
    action = plugin.definition.actions[modeAction];
  }
  if (!action) {
    return { ok: false, output: {}, error: `Action "${actionName}" not found in plugin "${plugin.id}"` };
  }

  // params can override config values — supports multi-instance scenarios
  // e.g., different Jenkins URLs per pipeline node via params.jenkins_url
  const mergedConfig = { ...plugin.config };
  const remainingParams = { ...params };
  for (const k of Object.keys(params)) {
    if (k in plugin.definition.config && params[k] != null) {
      mergedConfig[k] = params[k];
      delete remainingParams[k];
    }
  }

  // Config fields named "default_xxx" provide fallback for params.xxx
  for (const [k, v] of Object.entries(mergedConfig)) {
    if (k.startsWith('default_')) {
      const paramKey = k.slice(8); // "default_job" → "job"
      if (remainingParams[paramKey] == null && v != null) {
        remainingParams[paramKey] = v;
      }
    }
  }

  const ctx = {
    config: mergedConfig,
    params: remainingParams,
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
