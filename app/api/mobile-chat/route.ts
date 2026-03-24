import { NextResponse } from 'next/server';
import { spawn } from 'node:child_process';
import { loadSettings } from '@/lib/settings';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// POST /api/mobile-chat — send a message to claude and stream response
export async function POST(req: Request) {
  const { message, projectPath, resume, agent: agentId } = await req.json() as {
    message: string;
    projectPath: string;
    resume?: boolean;
    agent?: string;
  };

  if (!message || !projectPath) {
    return NextResponse.json({ error: 'message and projectPath required' }, { status: 400 });
  }

  const { getAgent } = require('@/lib/agents');
  const adapter = getAgent(agentId);
  const projectName = projectPath.split('/').pop() || projectPath;

  const spawnOpts = adapter.buildTaskSpawn({
    projectPath,
    prompt: message,
    skipPermissions: true,
    outputFormat: adapter.config.capabilities?.supportsStreamJson ? 'json' : undefined,
    conversationId: resume ? 'last' : undefined,
  });

  const child = spawn(spawnOpts.cmd, spawnOpts.args, {
    cwd: projectPath,
    env: { ...process.env, ...(spawnOpts.env || {}) },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  child.stdin.write(message);
  child.stdin.end();

  const encoder = new TextEncoder();
  let closed = false;
  let fullOutput = '';

  const stream = new ReadableStream({
    start(controller) {
      child.stdout.on('data', (chunk: Buffer) => {
        if (closed) return;
        const text = chunk.toString();
        fullOutput += text;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'chunk', text })}\n\n`));
        } catch {}
      });

      child.stderr.on('data', (chunk: Buffer) => {
        if (closed) return;
        const text = chunk.toString();
        if (text.includes('npm update') || text.includes('WARN')) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'stderr', text })}\n\n`));
        } catch {}
      });

      child.on('exit', (code) => {
        if (closed) return;
        closed = true;

        // Record usage from the JSON output
        try {
          const parsed = JSON.parse(fullOutput);
          if (parsed.session_id) {
            const { recordUsage } = require('@/lib/usage-scanner');
            recordUsage({
              sessionId: parsed.session_id,
              source: 'mobile',
              projectPath,
              projectName,
              model: parsed.model || 'unknown',
              inputTokens: parsed.usage?.input_tokens || parsed.total_input_tokens || 0,
              outputTokens: parsed.usage?.output_tokens || parsed.total_output_tokens || 0,
            });
          }
        } catch {}

        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'done', code })}\n\n`));
          controller.close();
        } catch {}
      });

      child.on('error', (err) => {
        if (closed) return;
        closed = true;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`));
          controller.close();
        } catch {}
      });
    },
    cancel() {
      closed = true;
      try { child.kill('SIGTERM'); } catch {}
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
