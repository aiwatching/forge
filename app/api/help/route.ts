import { NextResponse } from 'next/server';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getConfigDir } from '@/lib/dirs';
import { loadSettings } from '@/lib/settings';
import { execSync } from 'node:child_process';

const HELP_DIR = join(getConfigDir(), 'help');
const SOURCE_HELP_DIR = join(process.cwd(), 'lib', 'help-docs');

/** Ensure help docs are copied to ~/.forge/help/ */
function ensureHelpDocs() {
  if (!existsSync(HELP_DIR)) mkdirSync(HELP_DIR, { recursive: true });
  if (existsSync(SOURCE_HELP_DIR)) {
    for (const file of readdirSync(SOURCE_HELP_DIR)) {
      if (!file.endsWith('.md')) continue;
      const src = join(SOURCE_HELP_DIR, file);
      const dest = join(HELP_DIR, file);
      // Always overwrite to keep docs up to date
      writeFileSync(dest, readFileSync(src));
    }
  }
}

/** Check if any agent CLI is available */
function detectAgent(): { name: string; path: string } | null {
  const settings = loadSettings();
  if (settings.claudePath) {
    try {
      execSync(`"${settings.claudePath}" --version`, { timeout: 5000, stdio: 'pipe' });
      return { name: 'claude', path: settings.claudePath };
    } catch {}
  }
  for (const agent of ['claude', 'codex', 'aider']) {
    try {
      const path = execSync(`which ${agent}`, { encoding: 'utf-8', timeout: 3000, stdio: 'pipe' }).trim();
      if (path) return { name: agent, path };
    } catch {}
  }
  return null;
}

// GET /api/help
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const action = searchParams.get('action') || 'status';

  if (action === 'status') {
    const agent = detectAgent();
    ensureHelpDocs();
    const docs = existsSync(HELP_DIR)
      ? readdirSync(HELP_DIR).filter(f => f.endsWith('.md')).sort()
      : [];
    return NextResponse.json({ agent, docsCount: docs.length, helpDir: HELP_DIR });
  }

  if (action === 'docs') {
    ensureHelpDocs();
    const docs = existsSync(HELP_DIR)
      ? readdirSync(HELP_DIR).filter(f => f.endsWith('.md')).sort().map(f => ({
          name: f,
          title: f.replace(/^\d+-/, '').replace(/\.md$/, '').replace(/-/g, ' '),
        }))
      : [];
    return NextResponse.json({ docs });
  }

  if (action === 'doc') {
    const name = searchParams.get('name');
    if (!name) return NextResponse.json({ error: 'name required' }, { status: 400 });
    ensureHelpDocs();
    const file = join(HELP_DIR, name);
    if (!existsSync(file)) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ content: readFileSync(file, 'utf-8') });
  }

  return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
}
