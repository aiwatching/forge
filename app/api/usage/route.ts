import { NextResponse } from 'next/server';
import { scanUsage, queryUsage } from '@/lib/usage-scanner';

// GET /api/usage?days=7&project=forge&source=task&model=claude-opus-4
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const days = searchParams.get('days') ? parseInt(searchParams.get('days')!) : undefined;
  const projectName = searchParams.get('project') || undefined;
  const source = searchParams.get('source') || undefined;
  const model = searchParams.get('model') || undefined;

  const data = queryUsage({ days, projectName, source, model });
  return NextResponse.json(data);
}

// POST /api/usage — trigger scan
export async function POST() {
  const result = scanUsage();
  return NextResponse.json(result);
}
