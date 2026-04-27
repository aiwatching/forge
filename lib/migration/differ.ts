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

// ── OpenAPI schema validator (subset shape mode) ─────────
// Validates `value` against an inlined OpenAPI 3 schema.
// Subset semantics: extra fields in `value` are OK; missing required fields fail.

export interface SchemaViolation {
  jsonPath: string;
  expected: string;
  actual: string;
  reason: 'missing-required' | 'type-mismatch' | 'enum-mismatch' | 'unresolved';
  detail?: any;
}

export function validateAgainstSchema(value: any, schema: any, path = '$', out: SchemaViolation[] = [], ignore?: RegExp[]): SchemaViolation[] {
  if (!schema || typeof schema !== 'object') return out;
  if (schema.__cycle || schema.__unresolved) return out;
  if (ignore && ignore.some(re => re.test(path))) return out;

  // oneOf / anyOf — pass if any branch validates with no violations.
  if (Array.isArray(schema.oneOf) || Array.isArray(schema.anyOf)) {
    const branches = schema.oneOf || schema.anyOf;
    let bestErrors: SchemaViolation[] | null = null;
    for (const branch of branches) {
      const errs: SchemaViolation[] = [];
      validateAgainstSchema(value, branch, path, errs, ignore);
      if (errs.length === 0) return out;
      if (!bestErrors || errs.length < bestErrors.length) bestErrors = errs;
    }
    if (bestErrors) out.push(...bestErrors);
    return out;
  }
  if (Array.isArray(schema.allOf)) {
    for (const branch of schema.allOf) validateAgainstSchema(value, branch, path, out, ignore);
    return out;
  }

  const t = schema.type;
  const actualType = jsType(value);

  // Nullable check
  if (value === null) {
    if (schema.nullable === true) return out;
    if (Array.isArray(t) && t.includes('null')) return out;
    if (t === 'null') return out;
    out.push({ jsonPath: path, expected: String(t || 'non-null'), actual: 'null', reason: 'type-mismatch' });
    return out;
  }

  if (t === 'object' || (t === undefined && schema.properties)) {
    if (actualType !== 'object') {
      out.push({ jsonPath: path, expected: 'object', actual: actualType, reason: 'type-mismatch' });
      return out;
    }
    const required: string[] = schema.required || [];
    for (const r of required) {
      if (!(r in value)) {
        out.push({ jsonPath: `${path}.${r}`, expected: 'required', actual: 'missing', reason: 'missing-required' });
      }
    }
    const props = schema.properties || {};
    for (const [k, sub] of Object.entries(props)) {
      if (k in value) validateAgainstSchema(value[k], sub, `${path}.${k}`, out, ignore);
    }
    return out;
  }

  if (t === 'array') {
    if (actualType !== 'array') {
      out.push({ jsonPath: path, expected: 'array', actual: actualType, reason: 'type-mismatch' });
      return out;
    }
    const item = schema.items;
    if (item && value.length > 0) {
      // Validate first 10 items only — keeps reports tractable for large arrays.
      const sample = value.slice(0, 10);
      for (let i = 0; i < sample.length; i++) {
        validateAgainstSchema(sample[i], item, `${path}[${i}]`, out, ignore);
      }
    }
    return out;
  }

  if (t === 'integer' || t === 'number') {
    if (actualType !== 'number') {
      out.push({ jsonPath: path, expected: String(t), actual: actualType, reason: 'type-mismatch' });
    }
    return out;
  }

  if (t === 'string') {
    if (actualType !== 'string') {
      out.push({ jsonPath: path, expected: 'string', actual: actualType, reason: 'type-mismatch' });
      return out;
    }
    if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
      out.push({ jsonPath: path, expected: `enum ${JSON.stringify(schema.enum)}`, actual: JSON.stringify(value), reason: 'enum-mismatch' });
    }
    return out;
  }

  if (t === 'boolean') {
    if (actualType !== 'boolean') {
      out.push({ jsonPath: path, expected: 'boolean', actual: actualType, reason: 'type-mismatch' });
    }
    return out;
  }

  // No type constraint → pass.
  return out;
}

function jsType(v: any): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

