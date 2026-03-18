import { NextResponse } from 'next/server';
import { execSync } from 'node:child_process';
import { platform } from 'node:os';

interface CliInfo {
  name: string;
  path: string;
  version: string;
  installHint: string;
}

function detect(name: string, installHint: string): CliInfo {
  try {
    const path = execSync(`which ${name}`, { encoding: 'utf-8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    let version = '';
    try {
      const out = execSync(`${path} --version`, { encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
      // Extract version number from output (e.g. "@anthropic-ai/claude-code v1.2.3" or "codex 0.1.0")
      const match = out.match(/v?(\d+\.\d+\.\d+)/);
      version = match ? match[1] : out.slice(0, 50);
    } catch {}
    return { name, path, version, installHint };
  } catch {
    return { name, path: '', version: '', installHint };
  }
}

export async function GET() {
  const os = platform();
  const isLinux = os === 'linux';
  const isMac = os === 'darwin';

  const results = [
    detect('claude', isMac
      ? 'npm install -g @anthropic-ai/claude-code'
      : isLinux
        ? 'npm install -g @anthropic-ai/claude-code'
        : 'npm install -g @anthropic-ai/claude-code'),
    detect('codex', 'npm install -g @openai/codex'),
    detect('aider', isMac
      ? 'brew install aider  or  pip install aider-chat'
      : 'pip install aider-chat'),
  ];

  return NextResponse.json({ os, tools: results });
}
