// Strict JSON deep-equal with a JSONPath-style ignore list.
// Supported ignore syntax: $.field, $.nested.field, $.array[*].field

import type { DiffEntry } from './types';

function compileIgnore(patterns: string[]): RegExp[] {
  return patterns.map(p => {
    const body = p.startsWith('$') ? p.slice(1) : p;
    const escaped = body
      .replace(/\./g, '\\.')
      .replace(/\[\*\]/g, '\\[\\d+\\]')
      .replace(/\[(\d+)\]/g, '\\[$1\\]');
    return new RegExp(`^${escaped}$`);
  });
}

function isIgnored(path: string, compiled: RegExp[]): boolean {
  return compiled.some(re => re.test(path));
}

function normalizeArray(arr: any[]): any[] {
  // Sort by stable-stringify so order doesn't matter for top-level array results.
  return [...arr].sort((a, b) => stableStringify(a).localeCompare(stableStringify(b)));
}

function stableStringify(v: any): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  const keys = Object.keys(v).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}

export function diff(legacy: any, next: any, ignorePaths: string[] = [], opts: { sortArrays?: boolean } = {}): DiffEntry[] {
  const compiled = compileIgnore(ignorePaths);
  const out: DiffEntry[] = [];
  walk(legacy, next, '$', compiled, out, !!opts.sortArrays);
  return out;
}

function walk(a: any, b: any, path: string, compiled: RegExp[], out: DiffEntry[], sortArrays: boolean) {
  if (isIgnored(path, compiled)) return;

  const ta = a === null ? 'null' : Array.isArray(a) ? 'array' : typeof a;
  const tb = b === null ? 'null' : Array.isArray(b) ? 'array' : typeof b;

  if (ta !== tb) {
    out.push({ jsonPath: path, legacy: a, next: b, reason: 'type-mismatch' });
    return;
  }

  if (ta === 'array') {
    let aa = a, bb = b;
    if (sortArrays) { aa = normalizeArray(a); bb = normalizeArray(b); }
    const len = Math.max(aa.length, bb.length);
    for (let i = 0; i < len; i++) {
      const cp = `${path}[${i}]`;
      if (i >= aa.length) out.push({ jsonPath: cp, legacy: undefined, next: bb[i], reason: 'missing-in-legacy' });
      else if (i >= bb.length) out.push({ jsonPath: cp, legacy: aa[i], next: undefined, reason: 'missing-in-next' });
      else walk(aa[i], bb[i], cp, compiled, out, sortArrays);
    }
    return;
  }

  if (ta === 'object') {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      const cp = `${path}.${k}`;
      if (!(k in a)) out.push({ jsonPath: cp, legacy: undefined, next: b[k], reason: 'missing-in-legacy' });
      else if (!(k in b)) out.push({ jsonPath: cp, legacy: a[k], next: undefined, reason: 'missing-in-next' });
      else walk(a[k], b[k], cp, compiled, out, sortArrays);
    }
    return;
  }

  if (a !== b) out.push({ jsonPath: path, legacy: a, next: b, reason: 'value' });
}
