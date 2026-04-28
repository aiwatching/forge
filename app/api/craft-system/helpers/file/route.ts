import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, normalize } from 'node:path';

// GET /api/crafts/_helpers/file?projectPath=...&path=src/foo.ts
export async function GET(req: Request) {
  const u = new URL(req.url);
  const projectPath = u.searchParams.get('projectPath');
  const path = u.searchParams.get('path');
  if (!projectPath || !path) return new Response('missing args', { status: 400 });

  const full = normalize(join(projectPath, path));
  if (!full.startsWith(projectPath)) return new Response('invalid path', { status: 400 });
  if (!existsSync(full)) return new Response('not found', { status: 404 });
  if (statSync(full).isDirectory()) return new Response('is a directory', { status: 400 });

  // Cap at 1MB to avoid blowing up the client
  const buf = readFileSync(full);
  if (buf.length > 1024 * 1024) return new Response(buf.subarray(0, 1024 * 1024).toString('utf8') + '\n…(truncated)', { headers: { 'Content-Type': 'text/plain' } });
  return new Response(buf.toString('utf8'), { headers: { 'Content-Type': 'text/plain' } });
}
