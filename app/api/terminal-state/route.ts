import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextResponse } from 'next/server';
import { getDataDir } from '@/lib/dirs';

const STATE_FILE = join(getDataDir(), 'terminal-state.json');

export async function GET() {
  try {
    const data = JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
    return NextResponse.json(data);
  } catch {
    return NextResponse.json(null);
  }
}
