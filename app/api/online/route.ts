import { NextResponse, type NextRequest } from 'next/server';

// Track active users: IP/identifier → last seen timestamp
const activeUsers = new Map<string, { lastSeen: number; isRemote: boolean }>();
const TIMEOUT = 30_000; // 30s — user is "offline" if no ping in 30s

function cleanup() {
  const now = Date.now();
  for (const [key, val] of activeUsers) {
    if (now - val.lastSeen > TIMEOUT) activeUsers.delete(key);
  }
}

// POST /api/online — heartbeat ping
export async function POST(req: NextRequest) {
  cleanup();

  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || req.headers.get('x-real-ip')
    || 'local';
  const host = req.headers.get('host') || '';
  const isRemote = host.includes('.trycloudflare.com') || (ip !== 'local' && ip !== '127.0.0.1' && ip !== '::1');

  activeUsers.set(ip, { lastSeen: Date.now(), isRemote });

  const total = activeUsers.size;
  const remote = [...activeUsers.values()].filter(v => v.isRemote).length;

  return NextResponse.json({ total, remote });
}

// GET /api/online — just get counts
export async function GET() {
  cleanup();

  const total = activeUsers.size;
  const remote = [...activeUsers.values()].filter(v => v.isRemote).length;

  return NextResponse.json({ total, remote });
}
