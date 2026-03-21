import { NextResponse } from 'next/server';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { getConfigDir } from '@/lib/dirs';
import { loadSettings } from '@/lib/settings';
import { execSync } from 'node:child_process';

const HELP_DIR = join(getConfigDir(), 'help');
const SOURCE_HELP_DIR = join(process.cwd(), 'lib', 'help-docs');

/** Ensure help docs are copied to ~/.forge/help/ */
function ensureHelpDocs() {
  if (!existsSync(HELP_DIR)) mkdirSync(HELP_DIR, { recursive: true });
  // Copy source docs if newer or missing
  if (existsSync(SOURCE_HELP_DIR)) {
    for (const file of readdirSync(SOURCE_HELP_DIR)) {
      if (!file.endsWith('.md')) continue;
      const src = join(SOURCE_HELP_DIR, file);
      const dest = join(HELP_DIR, file);
      if (!existsSync(dest)) {
        writeFileSync(dest, readFileSync(src));
      }
    }
  }
}

/** Check if any agent CLI is available */
function detectAgent(): { name: string; path: string } | null {
  const settings = loadSettings();
  // Check configured claude path first
  if (settings.claudePath) {
    try {
      execSync(`"${settings.claudePath}" --version`, { timeout: 5000, stdio: 'pipe' });
      return { name: 'claude', path: settings.claudePath };
    } catch {}
  }
  // Try common agent CLIs
  for (const agent of ['claude', 'codex', 'aider']) {
    try {
      const path = execSync(`which ${agent}`, { encoding: 'utf-8', timeout: 3000, stdio: 'pipe' }).trim();
      if (path) return { name: agent, path };
    } catch {}
  }
  return null;
}

// GET /api/help
//   ?action=docs — list all help docs
//   ?action=doc&name=xxx — read specific doc
//   ?action=status — check agent availability
//   ?action=chat — send message to agent with help context
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

// POST /api/help — chat with agent
export async function POST(req: Request) {
  const body = await req.json();

  if (body.action === 'chat') {
    const agent = detectAgent();
    if (!agent) return NextResponse.json({ error: 'No agent CLI found. Install Claude Code: npm install -g @anthropic-ai/claude-code' }, { status: 400 });

    const { message, history } = body;
    if (!message) return NextResponse.json({ error: 'message required' }, { status: 400 });

    // Build context from help docs
    ensureHelpDocs();
    let context = '';
    if (existsSync(HELP_DIR)) {
      for (const file of readdirSync(HELP_DIR).filter(f => f.endsWith('.md')).sort()) {
        context += readFileSync(join(HELP_DIR, file), 'utf-8') + '\n\n---\n\n';
      }
    }

    // Build prompt with conversation history
    const historyText = (history || []).map((h: any) =>
      `${h.role === 'user' ? 'User' : 'Assistant'}: ${h.content}`
    ).join('\n\n');

    const prompt = `You are Forge Help Assistant. You help users configure and use Forge — a self-hosted Vibe Coding platform.

IMPORTANT: When the user asks you to configure something, you should output the exact API calls or file changes needed. You have access to the Forge settings API at http://localhost:${process.env.PORT || 3000}/api/settings.

Here is the complete Forge documentation:

${context}

${historyText ? `Previous conversation:\n${historyText}\n\n` : ''}User: ${message}

Respond concisely. If configuring something, tell the user exactly what was done and where.`;

    try {
      const result = execSync(`"${agent.path}" -p "${prompt.replace(/"/g, '\\"')}"`, {
        encoding: 'utf-8',
        timeout: 60000,
        cwd: process.cwd(),
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
      });
      return NextResponse.json({ response: result.trim(), agent: agent.name });
    } catch (e: any) {
      return NextResponse.json({ error: e.stderr?.toString() || e.message || 'Agent failed' }, { status: 500 });
    }
  }

  // Direct configuration action
  if (body.action === 'configure') {
    const { field, value } = body;
    if (!field) return NextResponse.json({ error: 'field required' }, { status: 400 });
    try {
      const settings = loadSettings();
      (settings as any)[field] = value;
      const { saveSettings } = require('@/lib/settings');
      saveSettings(settings);
      return NextResponse.json({ ok: true, field, value });
    } catch (e: any) {
      return NextResponse.json({ error: e.message }, { status: 500 });
    }
  }

  return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
}
