/**
 * Forge MCP Server — agent communication bus via Model Context Protocol.
 * Replaces HTTP-based forge-send/forge-inbox/forge-status skills.
 *
 * Claude Code connects via: --mcp-config pointing to this server.
 * Agents call tools like send_message(), get_inbox(), get_status() instead of curl.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { z } from 'zod';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

// Lazy imports to avoid circular deps (workspace modules)
let _getOrchestrator: ((workspaceId: string) => any) | null = null;

export function setOrchestratorResolver(fn: (id: string) => any): void {
  _getOrchestrator = fn;
}

function getOrch(workspaceId: string): any {
  if (!_getOrchestrator) throw new Error('Orchestrator resolver not set');
  return _getOrchestrator(workspaceId);
}

// ─── MCP Server Definition ──────────────────────────────

function createForgeMcpServer(): McpServer {
  const server = new McpServer({
    name: 'forge',
    version: '1.0.0',
  });

  // ── send_message ──────────────────────────
  server.tool(
    'send_message',
    'Send a message to another agent in the workspace',
    {
      to: z.string().describe('Target agent label (e.g., "Engineer", "QA", "Reviewer")'),
      content: z.string().describe('Message content'),
      action: z.string().optional().describe('Message type: fix_request, update_notify, question, review, info_request'),
    },
    async (params, extra) => {
      const { to, content, action = 'update_notify' } = params;
      // Agent ID and workspace ID from client metadata (set via env vars)
      const agentId = (extra as any)?.agentId || process.env.FORGE_AGENT_ID || '';
      const workspaceId = (extra as any)?.workspaceId || process.env.FORGE_WORKSPACE_ID || '';
      if (!workspaceId) return { content: [{ type: 'text', text: 'Error: No workspace ID. Set FORGE_WORKSPACE_ID env var.' }] };

      try {
        const orch = getOrch(workspaceId);
        // Find target agent by label
        const snapshot = orch.getSnapshot();
        const target = snapshot.agents.find((a: any) =>
          a.label.toLowerCase() === to.toLowerCase() || a.id === to
        );
        if (!target) {
          return { content: [{ type: 'text', text: `Error: Agent "${to}" not found. Available: ${snapshot.agents.map((a: any) => a.label).join(', ')}` }] };
        }

        orch.getBus().send(agentId, target.id, 'notify', {
          action,
          content,
        });

        return { content: [{ type: 'text', text: `Message sent to ${target.label}` }] };
      } catch (err: any) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }] };
      }
    }
  );

  // ── get_inbox ─────────────────────────────
  server.tool(
    'get_inbox',
    'Check inbox messages from other agents',
    {},
    async (_params, extra) => {
      const agentId = (extra as any)?.agentId || process.env.FORGE_AGENT_ID || '';
      const workspaceId = (extra as any)?.workspaceId || process.env.FORGE_WORKSPACE_ID || '';
      if (!workspaceId) return { content: [{ type: 'text', text: 'Error: No workspace ID' }] };

      try {
        const orch = getOrch(workspaceId);
        const messages = orch.getBus().getLog()
          .filter((m: any) => m.to === agentId && m.type !== 'ack')
          .slice(-20);

        if (messages.length === 0) {
          return { content: [{ type: 'text', text: 'No messages in inbox.' }] };
        }

        const snapshot = orch.getSnapshot();
        const getLabel = (id: string) => snapshot.agents.find((a: any) => a.id === id)?.label || id;

        const formatted = messages.map((m: any) =>
          `[${m.status}] From ${getLabel(m.from)}: ${m.payload?.content || m.payload?.action || '(no content)'} (${m.id.slice(0, 8)})`
        ).join('\n');

        return { content: [{ type: 'text', text: formatted }] };
      } catch (err: any) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }] };
      }
    }
  );

  // ── mark_message_done ─────────────────────
  server.tool(
    'mark_message_done',
    'Mark an inbox message as done after handling it',
    {
      message_id: z.string().describe('Message ID (first 8 chars or full UUID)'),
    },
    async (params, extra) => {
      const agentId = (extra as any)?.agentId || process.env.FORGE_AGENT_ID || '';
      const workspaceId = (extra as any)?.workspaceId || process.env.FORGE_WORKSPACE_ID || '';
      if (!workspaceId) return { content: [{ type: 'text', text: 'Error: No workspace ID' }] };

      try {
        const orch = getOrch(workspaceId);
        const bus = orch.getBus();
        const msg = bus.getLog().find((m: any) =>
          (m.id === params.message_id || m.id.startsWith(params.message_id)) && m.to === agentId
        );
        if (!msg) return { content: [{ type: 'text', text: 'Message not found' }] };

        msg.status = 'done';
        return { content: [{ type: 'text', text: `Message ${params.message_id} marked as done` }] };
      } catch (err: any) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }] };
      }
    }
  );

  // ── get_status ────────────────────────────
  server.tool(
    'get_status',
    'Get status of all agents in the workspace',
    {},
    async (_params, extra) => {
      const workspaceId = (extra as any)?.workspaceId || process.env.FORGE_WORKSPACE_ID || '';
      if (!workspaceId) return { content: [{ type: 'text', text: 'Error: No workspace ID' }] };

      try {
        const orch = getOrch(workspaceId);
        const snapshot = orch.getSnapshot();
        const states = orch.getAllAgentStates();

        const lines = snapshot.agents
          .filter((a: any) => a.type !== 'input')
          .map((a: any) => {
            const s = states[a.id];
            const smith = s?.smithStatus || 'down';
            const task = s?.taskStatus || 'idle';
            const icon = smith === 'active' ? (task === 'running' ? '🔵' : task === 'done' ? '✅' : task === 'failed' ? '🔴' : '🟢') : '⬚';
            return `${icon} ${a.label}: smith=${smith} task=${task}${s?.error ? ` error=${s.error}` : ''}`;
          });

        return { content: [{ type: 'text', text: lines.join('\n') || 'No agents configured.' }] };
      } catch (err: any) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }] };
      }
    }
  );

  // ── sync_progress ─────────────────────────
  server.tool(
    'sync_progress',
    'Report your work progress to the workspace (what you did, files changed)',
    {
      summary: z.string().describe('Brief summary of what you accomplished'),
      files: z.array(z.string()).optional().describe('List of files changed'),
    },
    async (params, extra) => {
      const agentId = (extra as any)?.agentId || process.env.FORGE_AGENT_ID || '';
      const workspaceId = (extra as any)?.workspaceId || process.env.FORGE_WORKSPACE_ID || '';
      if (!workspaceId) return { content: [{ type: 'text', text: 'Error: No workspace ID' }] };

      try {
        const orch = getOrch(workspaceId);
        const entry = orch.getSnapshot().agents.find((a: any) => a.id === agentId);
        if (!entry) return { content: [{ type: 'text', text: 'Agent not found in workspace' }] };

        // Emit as done event
        orch.completeManualAgent(agentId, params.files || []);

        return { content: [{ type: 'text', text: `Progress synced: ${params.summary}` }] };
      } catch (err: any) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }] };
      }
    }
  );

  return server;
}

// ─── HTTP Server with SSE Transport ─────────────────────

let mcpHttpServer: ReturnType<typeof createServer> | null = null;
const transports = new Map<string, SSEServerTransport>();

export async function startMcpServer(port: number): Promise<void> {
  mcpHttpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || '/', `http://localhost:${port}`);

    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    // SSE endpoint — each connection gets its own MCP server instance
    if (url.pathname === '/sse' && req.method === 'GET') {
      const transport = new SSEServerTransport('/message', res);
      const sessionId = transport.sessionId;
      transports.set(sessionId, transport);

      transport.onclose = () => {
        transports.delete(sessionId);
      };

      // Each session gets a fresh MCP server
      const server = createForgeMcpServer();
      await server.connect(transport);
      console.log(`[forge-mcp] Client connected: ${sessionId}`);
      return;
    }

    // Message endpoint — route by sessionId query param
    if (url.pathname === '/message' && req.method === 'POST') {
      const sessionId = url.searchParams.get('sessionId');
      if (!sessionId) {
        res.writeHead(400);
        res.end('Missing sessionId parameter');
        return;
      }

      const transport = transports.get(sessionId);
      if (!transport) {
        res.writeHead(404);
        res.end('Session not found');
        return;
      }

      // Read body and pass to transport
      const body: Buffer[] = [];
      req.on('data', (chunk: Buffer) => body.push(chunk));
      req.on('end', async () => {
        try {
          const parsed = JSON.parse(Buffer.concat(body).toString());
          await transport.handlePostMessage(req, res, parsed);
        } catch (err: any) {
          if (!res.headersSent) { res.writeHead(400); res.end('Invalid JSON'); }
        }
      });
      return;
    }

    // Health check
    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, sessions: transports.size }));
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });

  mcpHttpServer.listen(port, () => {
    console.log(`[forge-mcp] MCP Server running on http://localhost:${port}`);
  });
}

export function stopMcpServer(): void {
  if (mcpHttpServer) {
    mcpHttpServer.close();
    mcpHttpServer = null;
    transports.clear();
  }
}

export function getMcpPort(): number {
  return Number(process.env.MCP_PORT) || 7830;
}
