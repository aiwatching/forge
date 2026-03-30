import { NextResponse } from 'next/server';
import { execSync } from 'node:child_process';

function run(cmd: string): string {
  try {
    return execSync(cmd, { encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch { return ''; }
}

function countProcess(pattern: string): { count: number; pid: string; startedAt: string } {
  const out = run(`ps aux | grep '${pattern}' | grep -v grep | head -1`);
  const pid = out ? out.split(/\s+/)[1] || '' : '';
  const count = out ? run(`ps aux | grep '${pattern}' | grep -v grep | wc -l`).trim() : '0';
  // Get start time from ps
  const startedAt = pid ? run(`ps -o lstart= -p ${pid} 2>/dev/null`).trim() : '';
  return { count: parseInt(count), pid, startedAt };
}

export async function GET() {
  // Processes
  const nextjs = countProcess('next-server');
  const terminal = countProcess('terminal-standalone');
  const telegram = countProcess('telegram-standalone');
  const workspace = countProcess('workspace-standalone');
  const tunnel = countProcess('cloudflared tunnel');

  // MCP Server (runs inside workspace process, check /health endpoint)
  let mcpStatus = { running: false, sessions: 0 };
  try {
    const mcpPort = Number(process.env.MCP_PORT) || 8406;
    const mcpRes = run(`curl -s http://localhost:${mcpPort}/health 2>/dev/null`);
    if (mcpRes.includes('"ok":true')) {
      const data = JSON.parse(mcpRes);
      mcpStatus = { running: true, sessions: data.sessions || 0 };
    }
  } catch {}

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
      nextjs: { running: nextjs.count > 0, pid: nextjs.pid, startedAt: nextjs.startedAt },
      terminal: { running: terminal.count > 0, pid: terminal.pid, startedAt: terminal.startedAt },
      telegram: { running: telegram.count > 0, pid: telegram.pid, startedAt: telegram.startedAt },
      workspace: { running: workspace.count > 0, pid: workspace.pid, startedAt: workspace.startedAt },
      tunnel: { running: tunnel.count > 0, pid: tunnel.pid, url: tunnelUrl, startedAt: tunnel.startedAt },
      mcp: { running: mcpStatus.running, port: 8406, sessions: mcpStatus.sessions },
    },
    sessions,
    uptime: uptime.replace(/.*up\s+/, '').replace(/,\s+\d+ user.*/, '').trim(),
  });
}
