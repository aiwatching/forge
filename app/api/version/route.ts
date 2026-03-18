import { NextResponse } from 'next/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Read version once at module load (= server start), not on every request
const CURRENT_VERSION = (() => {
  try {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf-8'));
    return pkg.version as string;
  } catch {
    return '0.0.0';
  }
})();

// Cache npm version check for 1 hour
let cachedLatest: { version: string; checkedAt: number } | null = null;
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

async function getLatestVersion(force = false): Promise<string> {
  if (!force && cachedLatest && Date.now() - cachedLatest.checkedAt < CACHE_TTL) {
    return cachedLatest.version;
  }
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch('https://registry.npmjs.org/@aion0/forge/latest', {
      signal: controller.signal,
      headers: { 'Accept': 'application/json' },
    });
    clearTimeout(timeout);
    if (!res.ok) return cachedLatest?.version || '';
    const data = await res.json();
    cachedLatest = { version: data.version, checkedAt: Date.now() };
    return data.version;
  } catch {
    return cachedLatest?.version || '';
  }
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
  }
  return 0;
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const force = searchParams.has('force');
  const current = CURRENT_VERSION;
  const latest = await getLatestVersion(force);
  const hasUpdate = latest && compareVersions(current, latest) < 0;

  return NextResponse.json({
    current,
    latest: latest || current,
    hasUpdate,
  });
}
