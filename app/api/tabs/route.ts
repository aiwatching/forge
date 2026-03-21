import { NextRequest, NextResponse } from 'next/server';
import { join } from 'node:path';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { getDataDir } from '@/lib/dirs';

function getTabsFile(type: string): string {
  return join(getDataDir(), `tabs-${type}.json`);
}

export async function GET(req: NextRequest) {
  const type = req.nextUrl.searchParams.get('type') || 'projects';
  const file = getTabsFile(type);
  try {
    if (existsSync(file)) {
      const data = JSON.parse(readFileSync(file, 'utf-8'));
      return NextResponse.json(data);
    }
  } catch {}
  return NextResponse.json({ tabs: [], activeTabId: 0 });
}

export async function POST(req: NextRequest) {
  const type = req.nextUrl.searchParams.get('type') || 'projects';
  const file = getTabsFile(type);
  try {
    const body = await req.json();
    writeFileSync(file, JSON.stringify(body, null, 2));
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}
