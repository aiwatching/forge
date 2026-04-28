// Runtime: load + cache craft server modules; build the ForgeServerApi per request.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import * as esbuild from 'esbuild';
import { pathToFileURL } from 'node:url';
import { createTask } from '@/lib/task-manager';
import type { CraftDescriptor, CraftServerDef, CraftRouteHandler, ForgeServerApi } from './types';

// Module cache: dir → { mtimeMs, mod }
interface CachedMod { mtimeMs: number; def: CraftServerDef; }
const cache = new Map<string, CachedMod>();

// Function-wrapped dynamic import so Turbopack doesn't try to statically resolve the URL.
const dynamicImport = new Function('u', 'return import(u)') as (u: string) => Promise<any>;

async function transpileToFile(src: string, resolveDir: string): Promise<string> {
  // Compile TS → JS, bundling the @forge/craft/server SDK inline (node_modules stays external).
  // Cache key includes a salt so older transpile outputs are skipped after format changes.
  const hash = require('node:crypto').createHash('md5').update('v2:' + src).digest('hex').slice(0, 16);
  const out = join(tmpdir(), `forge-craft-${hash}.mjs`);
  if (existsSync(out)) return out;
  const sdkServerEntry = require('node:path').resolve(process.cwd(), 'lib/craft-sdk/server.ts');
  const result = await esbuild.build({
    stdin: { contents: src, loader: 'ts', resolveDir },
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    packages: 'external',
    alias: {
      '@forge/craft/server': sdkServerEntry,
    },
    write: false,
  });
  writeFileSync(out, result.outputFiles[0].text, 'utf8');
  return out;
}

export async function loadServer(craft: CraftDescriptor): Promise<CraftServerDef | null> {
  if (!craft.hasServer) return null;
  const file = join(craft.__dir, craft.server?.entry || 'server.ts');
  const stat = statSync(file);
  const cached = cache.get(craft.__dir);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.def;

  const src = readFileSync(file, 'utf8');
  const compiled = await transpileToFile(src, craft.__dir);
  // Bust ESM cache by adding a query string (Node ESM caches by URL).
  // Use Function() so Turbopack doesn't try to statically analyze the import.
  const url = pathToFileURL(compiled).href + `?t=${stat.mtimeMs}`;
  const mod = await dynamicImport(url);
  const def: CraftServerDef = mod.default ?? mod.craft ?? mod;
  if (!def || typeof def !== 'object' || !def.routes) {
    throw new Error(`Craft "${craft.name}" server.ts must export default defineCraftServer({...})`);
  }
  cache.set(craft.__dir, { mtimeMs: stat.mtimeMs, def });
  return def;
}

// Match a route key like "GET /items/:id" against a request method + path.
function matchRoute(routeKey: string, method: string, path: string): Record<string, string> | null {
  const [m, pat] = routeKey.split(/\s+/, 2);
  if (m.toUpperCase() !== method.toUpperCase()) return null;
  // Normalize: ensure leading slash on both
  const cleanPath = path.startsWith('/') ? path : '/' + path;
  const cleanPat = pat.startsWith('/') ? pat : '/' + pat;
  const pSegs = cleanPath.split('/').filter(Boolean);
  const tSegs = cleanPat.split('/').filter(Boolean);
  if (pSegs.length !== tSegs.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < tSegs.length; i++) {
    const t = tSegs[i];
    const p = pSegs[i];
    if (t.startsWith(':')) params[t.slice(1)] = decodeURIComponent(p);
    else if (t !== p) return null;
  }
  return params;
}

export function findHandler(def: CraftServerDef, method: string, path: string): { handler: CraftRouteHandler; params: Record<string, string> } | null {
  for (const [key, handler] of Object.entries(def.routes)) {
    const params = matchRoute(key, method, path);
    if (params) return { handler, params };
  }
  return null;
}

// ── Forge server-side API ────────────────────────────────

export function buildForgeApi(craft: CraftDescriptor, projectPath: string, projectName?: string): ForgeServerApi {
  const dataDir = join(craft.__dir, 'data');
  // For builtin crafts, redirect storage to the project so writes don't go into the install
  const writableDataDir = craft.__scope === 'builtin'
    ? join(projectPath, '.forge', 'crafts', craft.name, 'data')
    : dataDir;

  return {
    project: { path: projectPath, name: projectName },

    storage: {
      read<T>(file: string): T | null {
        const f = join(writableDataDir, file);
        if (!existsSync(f)) return null;
        try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; }
      },
      write(file: string, data: any): void {
        if (!existsSync(writableDataDir)) mkdirSync(writableDataDir, { recursive: true });
        writeFileSync(join(writableDataDir, file), JSON.stringify(data, null, 2), 'utf8');
      },
      listFiles(): string[] {
        if (!existsSync(writableDataDir)) return [];
        return readdirSync(writableDataDir);
      },
    },

    exec(cmd, opts = {}) {
      try {
        const stdout = execSync(cmd, {
          cwd: projectPath,
          timeout: opts.timeout ?? 30000,
          input: opts.input,
          encoding: 'utf8',
          maxBuffer: 10 * 1024 * 1024,
        }).toString();
        return { stdout, stderr: '', code: 0 };
      } catch (e: any) {
        return { stdout: (e?.stdout || '').toString(), stderr: (e?.stderr || e?.message || '').toString(), code: e?.status ?? 1 };
      }
    },

    task(opts) {
      const task = createTask({
        projectName: projectName || projectPath.split('/').filter(Boolean).pop() || 'project',
        projectPath,
        prompt: opts.prompt,
        agent: opts.agent,
      });
      return { id: task.id };
    },

    inject(text, opts = {}) {
      // Reuse migration session-resolver logic inline
      try {
        const sessionName = opts.sessionName || resolveBoundSession(projectPath);
        if (!sessionName) return { ok: false };
        const buf = join(tmpdir(), `forge-craft-inject-${Date.now()}.txt`);
        writeFileSync(buf, text);
        execSync(`tmux load-buffer -t "${sessionName}" "${buf}" && tmux paste-buffer -t "${sessionName}" && sleep 0.2 && tmux send-keys -t "${sessionName}" Enter`, { timeout: 5000 });
        try { require('node:fs').unlinkSync(buf); } catch {}
        return { ok: true, sessionName };
      } catch (e) {
        return { ok: false };
      }
    },

    openapi(specPath) {
      try {
        const file = join(projectPath, specPath);
        if (!existsSync(file)) return null;
        return JSON.parse(readFileSync(file, 'utf8'));
      } catch { return null; }
    },

    log: (...args) => console.log(`[craft:${craft.name}]`, ...args),
  };
}

function resolveBoundSession(projectPath: string): string | null {
  try {
    const sessions = execSync(`tmux list-sessions -F '#{session_name}'`, { encoding: 'utf8', timeout: 2000 })
      .trim().split('\n').filter(Boolean).filter(n => /^mw[a-z0-9]*-/.test(n));
    for (const s of sessions) {
      try {
        const cwd = execSync(`tmux display-message -p -t '${s}' '#{pane_current_path}'`, { encoding: 'utf8', timeout: 2000 }).trim();
        if (cwd === projectPath || cwd.startsWith(projectPath + '/')) return s;
      } catch {}
    }
  } catch {}
  return null;
}

// ── UI transpile (TSX → JS) for browser dynamic import ──

export async function transpileUi(craft: CraftDescriptor): Promise<string> {
  const file = join(craft.__dir, craft.ui?.tab || 'ui.tsx');
  if (!existsSync(file)) throw new Error('No UI file');
  const src = readFileSync(file, 'utf8');
  const result = await esbuild.build({
    stdin: { contents: src, loader: 'tsx', resolveDir: craft.__dir },
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    jsx: 'automatic',
    write: false,
    // Mark React + SDK as externals so they share the host page's instances
    external: ['react', 'react/jsx-runtime', 'react-dom', '@forge/craft'],
  });
  // Rewrite SDK + react bare imports → absolute URLs that Forge serves.
  let code = result.outputFiles[0].text;
  code = code.replace(/from\s*["']react["']/g, 'from "/api/craft-system/runtime/react"');
  code = code.replace(/from\s*["']react\/jsx-runtime["']/g, 'from "/api/craft-system/runtime/react-jsx"');
  code = code.replace(/from\s*["']@forge\/craft["']/g, 'from "/api/craft-system/runtime/sdk"');
  return code;
}
