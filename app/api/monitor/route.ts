import { NextResponse } from 'next/server';
import { execSync } from 'node:child_process';

function run(cmd: string): string {
  try {
    return execSync(cmd, { encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch { return ''; }
}

function countProcess(pattern: string): { count: number; pid: string } {
  const out = run(`ps aux | grep '${pattern}' | grep -v grep | head -1`);
  const pid = out ? out.split(/\s+/)[1] || '' : '';
  const count = out ? run(`ps aux | grep '${pattern}' | grep -v grep | wc -l`).trim() : '0';
  return { count: parseInt(count), pid };
}

export async function GET() {
  // Processes
  const nextjs = countProcess('next-server');
  const terminal = countProcess('terminal-standalone');
  const telegram = countProcess('telegram-standalone');
  const tunnel = countProcess('cloudflared tunnel');

  // Tunnel URL
  let tunnelUrl = '';
  try {
    const { readFileSync } = require('fs');
    const { join } = require('path');
    const { getDataDir: _gdd } = require('@/lib/dirs');
    const state = JSON.parse(readFileSync(join(_gdd(), 'tunnel-state.json'), 'utf-8'));
    tunnelUrl = state.url || '';
  } catch {}

  // tmux sessions
  let sessions: { name: string; created: string; attached: boolean; windows: number }[] = [];
  try {
    const out = run("tmux list-sessions -F '#{session_name}||#{session_created}||#{session_attached}||#{session_windows}' 2>/dev/null");
    sessions = out.split('\n').filter(l => l.startsWith('mw-')).map(line => {
      const [name, created, attached, windows] = line.split('||');
      return { name, created: new Date(Number(created) * 1000).toISOString(), attached: attached !== '0', windows: Number(windows) || 1 };
    });
  } catch {}

  // System info
  const uptime = run('uptime');
  const memory = run("ps -o rss= -p $$ 2>/dev/null || echo 0");

  return NextResponse.json({
    processes: {
      nextjs: { running: nextjs.count > 0, pid: nextjs.pid },
      terminal: { running: terminal.count > 0, pid: terminal.pid },
      telegram: { running: telegram.count > 0, pid: telegram.pid },
      tunnel: { running: tunnel.count > 0, pid: tunnel.pid, url: tunnelUrl },
    },
    sessions,
    uptime: uptime.replace(/.*up\s+/, '').replace(/,\s+\d+ user.*/, '').trim(),
  });
}
