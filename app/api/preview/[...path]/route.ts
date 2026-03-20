import { NextResponse, type NextRequest } from 'next/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDataDir } from '@/lib/dirs';

const CONFIG_FILE = join(getDataDir(), 'preview.json');

function getPort(): number {
  try {
    const data = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
    return data.port || 0;
  } catch {
    return 0;
  }
}

async function proxy(req: NextRequest) {
  const port = getPort();
  if (!port) {
    return NextResponse.json({ error: 'Preview not configured' }, { status: 503 });
  }

  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/api\/preview/, '') || '/';
  const target = `http://localhost:${port}${path}${url.search}`;

  try {
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => {
      if (!['host', 'connection', 'transfer-encoding'].includes(k.toLowerCase())) {
        headers[k] = v;
      }
    });

    const res = await fetch(target, {
      method: req.method,
      headers,
      body: req.method !== 'GET' && req.method !== 'HEAD' ? await req.arrayBuffer() : undefined,
      redirect: 'manual',
    });

    const responseHeaders = new Headers();
    res.headers.forEach((v, k) => {
      if (!['transfer-encoding', 'content-encoding'].includes(k.toLowerCase())) {
        responseHeaders.set(k, v);
      }
    });

    return new NextResponse(res.body, {
      status: res.status,
      headers: responseHeaders,
    });
  } catch {
    return NextResponse.json({ error: `Cannot connect to localhost:${port}` }, { status: 502 });
  }
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const DELETE = proxy;
export const PATCH = proxy;
export const HEAD = proxy;
export const OPTIONS = proxy;
