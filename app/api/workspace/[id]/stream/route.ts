export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const WORKSPACE_PORT = Number(process.env.WORKSPACE_PORT) || 8405;
const DAEMON_URL = `http://localhost:${WORKSPACE_PORT}`;

// SSE relay — proxy daemon's SSE stream to browser
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  try {
    const daemonRes = await fetch(`${DAEMON_URL}/workspace/${id}/stream`, {
      signal: req.signal,
    });

    if (!daemonRes.ok || !daemonRes.body) {
      return new Response(daemonRes.statusText || 'Daemon error', { status: daemonRes.status });
    }

    // Pipe daemon SSE stream directly to browser
    return new Response(daemonRes.body, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
      },
    });
  } catch (err: any) {
    return new Response('Workspace daemon not available', { status: 503 });
  }
}
