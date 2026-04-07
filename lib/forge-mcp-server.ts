/**
 * Forge MCP Server — agent communication bus via Model Context Protocol.
 *
 * Each Claude Code session connects with context baked into the SSE URL:
 *   http://localhost:8406/sse?workspaceId=xxx&agentId=yyy
 *
 * The agent doesn't need to know IDs. It just calls:
 *   send_message(to: "Reviewer", content: "fixed the bug")
 *   get_inbox()
 *   get_status()
 *
 * Forge resolves everything from the connection context.
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

// Per-session context (resolved from SSE URL + orchestrator topo)
interface SessionContext {
  workspaceId: string;
  agentId: string; // resolved dynamically, may be empty for non-agent terminals
}
const sessionContexts = new Map<string, SessionContext>();

/** Resolve agentId from orchestrator's agent-tmux mapping */
function resolveAgentFromOrch(workspaceId: string): string {
  // For now, default to primary agent. Future: resolve from tmux session → agent map
  try {
    const orch = getOrch(workspaceId);
    const primary = orch.getPrimaryAgent();
    return primary?.config?.id || '';
  } catch { return ''; }
}

// ─── MCP Server Definition ──────────────────────────────

function createForgeMcpServer(sessionId: string): McpServer {
  const server = new McpServer({
    name: 'forge',
    version: '1.0.0',
  });

  // Helper: get context for this session
  const ctx = () => sessionContexts.get(sessionId) || { workspaceId: '', agentId: '' };

  // ── send_message ──────────────────────────
  server.tool(
    'send_message',
    'Send a message to another agent in the workspace. Set noReply=true for notifications that do not need a response.',
    {
      to: z.string().describe('Target agent — name like "Reviewer", or description like "the one who does testing"'),
      content: z.string().describe('Message content'),
      action: z.string().optional().describe('Message type: fix_request, update_notify, question, review, info_request'),
      noReply: z.boolean().optional().describe('If true, recipient should not reply to this message'),
    },
    async (params) => {
      const { to, content, action = 'update_notify', noReply } = params;
      const { workspaceId, agentId } = ctx();
      if (!workspaceId) return { content: [{ type: 'text', text: 'Error: No workspace context.' }] };

      try {
        const orch = getOrch(workspaceId);
        const snapshot = orch.getSnapshot();
        const candidates = snapshot.agents.filter((a: any) => a.type !== 'input' && a.id !== agentId);

        // Match: exact label > label contains > role contains
        const toLower = to.toLowerCase();
        let target = candidates.find((a: any) => a.label.toLowerCase() === toLower);
        if (!target) target = candidates.find((a: any) => a.label.toLowerCase().includes(toLower));
        if (!target) target = candidates.find((a: any) => (a.role || '').toLowerCase().includes(toLower));

        if (!target) {
          const available = candidates.map((a: any) => `${a.label} (${(a.role || '').slice(0, 50)})`).join(', ');
          return { content: [{ type: 'text', text: `No agent matches "${to}". Available: ${available}` }] };
        }

        // Block reply to agents who have a running/pending message to us.
        // The system auto-delivers completion status — use /forge-send only for NEW messages.
        // Uses findLast to check the most recent message state (not oldest/stale ones).
        const incomingFromTarget = orch.getBus().getLog().findLast((m: any) =>
          m.to === agentId && m.from === target.id &&
          (m.status === 'running' || m.status === 'pending')
        );
        if (incomingFromTarget && !incomingFromTarget.payload?.noReply) {
          return { content: [{ type: 'text', text: `Skipped: you are processing a message from ${target.label}. Your completion is delivered automatically — no need to reply via send_message.` }] };
        }

        const payload: any = { action, content };
        if (noReply) payload.noReply = true;
        orch.getBus().send(agentId, target.id, 'notify', payload);
        return { content: [{ type: 'text', text: `Message sent to ${target.label}${noReply ? ' (no-reply)' : ''}` }] };
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
    async () => {
      const { workspaceId, agentId } = ctx();
      if (!workspaceId) return { content: [{ type: 'text', text: 'Error: No workspace context' }] };

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

        const formatted = messages.map((m: any) => {
          const noReplyTag = m.payload?.noReply ? ' [no-reply]' : '';
          const refInfo = m.payload?.ref ? ` [ref: ${m.payload.ref}]` : '';
          return `[${m.status}] From ${getLabel(m.from)}${noReplyTag}: ${m.payload?.content || m.payload?.action || '(no content)'}${refInfo} (${m.id.slice(0, 8)})`;
        }).join('\n');

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
    async (params) => {
      const { workspaceId, agentId } = ctx();
      if (!workspaceId) return { content: [{ type: 'text', text: 'Error: No workspace context' }] };

      try {
        const orch = getOrch(workspaceId);
        const msg = orch.getBus().getLog().find((m: any) =>
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
    'Get live status of all agents in the workspace (from topology cache)',
    {},
    async () => {
      const { workspaceId } = ctx();
      if (!workspaceId) return { content: [{ type: 'text', text: 'Error: No workspace context' }] };

      try {
        const orch = getOrch(workspaceId);
        const topo = orch.getWorkspaceTopo();

        const lines = topo.agents.map((a: any) => {
          const icon = a.smithStatus === 'active'
            ? (a.taskStatus === 'running' ? '🔵' : a.taskStatus === 'done' ? '✅' : a.taskStatus === 'failed' ? '🔴' : '🟢')
            : '⬚';
          return `${icon} ${a.label}: smith=${a.smithStatus} task=${a.taskStatus}`;
        });
        lines.unshift(`Flow: ${topo.flow}\n`);

        return { content: [{ type: 'text', text: lines.join('\n') || 'No agents configured.' }] };
      } catch (err: any) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }] };
      }
    }
  );

  // ── get_agents ────────────────────────────
  server.tool(
    'get_agents',
    'Get workspace topology — all agents, their roles, relationships, current status, and execution flow. Cached and auto-refreshed on any agent change. Call this to understand the full team composition before planning work.',
    {},
    async () => {
      const { workspaceId, agentId } = ctx();
      if (!workspaceId) return { content: [{ type: 'text', text: 'Error: No workspace context' }] };

      try {
        const orch = getOrch(workspaceId);
        const topo = orch.getWorkspaceTopo();

        const lines: string[] = [];
        lines.push(`## Workspace Topology (${topo.agents.length} agents)`);
        lines.push(`Flow: ${topo.flow}\n`);

        // Identify present and missing standard roles
        const labels = new Set(topo.agents.map((a: any) => a.label.toLowerCase()));
        const standardRoles = ['architect', 'engineer', 'qa', 'reviewer', 'pm', 'lead'];
        const present = standardRoles.filter(r => labels.has(r));
        const missing = standardRoles.filter(r => !labels.has(r));
        if (missing.length > 0) {
          lines.push(`Present roles: ${present.join(', ') || 'none'}`);
          lines.push(`Missing roles: ${missing.join(', ')} — these responsibilities must be covered by existing agents\n`);
        }

        for (const a of topo.agents as any[]) {
          const isMe = a.id === agentId;
          lines.push(`### ${a.icon} ${a.label}${isMe ? ' ← YOU' : ''}${a.primary ? ' [PRIMARY]' : ''}`);
          lines.push(`Status: smith=${a.smithStatus} task=${a.taskStatus}`);
          lines.push(`Role: ${a.roleSummary}`);
          if (a.dependsOn.length > 0) lines.push(`Depends on: ${a.dependsOn.join(', ')}`);
          if (a.workDir !== './') lines.push(`Work dir: ${a.workDir}`);
          if (a.outputs.length > 0) lines.push(`Outputs: ${a.outputs.join(', ')}`);
          if (a.steps.length > 0) lines.push(`Steps: ${a.steps.join(' → ')}`);
          lines.push('');
        }

        return { content: [{ type: 'text', text: lines.join('\n') }] };
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
    async (params) => {
      const { workspaceId, agentId } = ctx();
      if (!workspaceId) return { content: [{ type: 'text', text: 'Error: No workspace context' }] };

      try {
        const orch = getOrch(workspaceId);
        const entry = orch.getSnapshot().agents.find((a: any) => a.id === agentId);
        if (!entry) return { content: [{ type: 'text', text: 'Agent not found in workspace' }] };

        orch.completeManualAgent(agentId, params.files || []);

        return { content: [{ type: 'text', text: `Progress synced: ${params.summary}` }] };
      } catch (err: any) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }] };
      }
    }
  );

  // ── check_outbox ──────────────────────────
  server.tool(
    'check_outbox',
    'Check status of messages you sent to other agents. See if they replied or completed.',
    {},
    async () => {
      const { workspaceId, agentId } = ctx();
      if (!workspaceId) return { content: [{ type: 'text', text: 'Error: No workspace context' }] };

      try {
        const orch = getOrch(workspaceId);
        const snapshot = orch.getSnapshot();
        const getLabel = (id: string) => snapshot.agents.find((a: any) => a.id === id)?.label || id;

        // Messages sent BY this agent
        const sent = orch.getBus().getLog()
          .filter((m: any) => m.from === agentId && m.type !== 'ack')
          .slice(-20);

        if (sent.length === 0) {
          return { content: [{ type: 'text', text: 'No messages sent.' }] };
        }

        // Check for replies
        const formatted = sent.map((m: any) => {
          const targetLabel = getLabel(m.to);
          const replies = orch.getBus().getLog().filter((r: any) =>
            r.from === m.to && r.to === agentId && r.timestamp > m.timestamp && r.type !== 'ack'
          );
          const replyInfo = replies.length > 0
            ? `replied: ${replies[replies.length - 1].payload?.content?.slice(0, 100) || '(no content)'}`
            : 'no reply yet';
          return `→ ${targetLabel}: [${m.status}] ${(m.payload?.content || '').slice(0, 60)} | ${replyInfo}`;
        }).join('\n');

        return { content: [{ type: 'text', text: formatted }] };
      } catch (err: any) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }] };
      }
    }
  );

  // ── trigger_pipeline ──────────────────────────
  server.tool(
    'trigger_pipeline',
    'Trigger a pipeline workflow. Lists available workflows if called without arguments.',
    {
      workflow: z.string().optional().describe('Workflow name to trigger. Omit to list available workflows.'),
      input: z.record(z.string(), z.string()).optional().describe('Input variables for the pipeline (e.g., { project: "my-app" })'),
    },
    async (params) => {
      try {
        if (!params.workflow) {
          // List available workflows
          const { listWorkflows } = await import('./pipeline');
          const workflows = listWorkflows();
          if (workflows.length === 0) {
            return { content: [{ type: 'text', text: 'No workflows found. Create .yaml files in ~/.forge/flows/' }] };
          }
          const list = workflows.map((w: any) => `• ${w.name}${w.description ? ' — ' + w.description : ''} (${Object.keys(w.nodes || {}).length} nodes)`).join('\n');
          return { content: [{ type: 'text', text: `Available workflows:\n${list}` }] };
        }

        const { startPipeline } = await import('./pipeline');
        const pipeline = startPipeline(params.workflow, (params.input || {}) as Record<string, string>);
        return { content: [{ type: 'text', text: `Pipeline started: ${pipeline.id} (workflow: ${params.workflow}, status: ${pipeline.status})` }] };
      } catch (err: any) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }] };
      }
    }
  );

  // ── run_plugin ──────────────────────────────────
  server.tool(
    'run_plugin',
    'Run an installed plugin action directly. Lists installed plugins if called without arguments.',
    {
      plugin: z.string().optional().describe('Plugin ID (e.g., "jenkins", "shell-command", "docker"). Omit to list installed plugins.'),
      action: z.string().optional().describe('Action name (e.g., "trigger", "run", "build"). Uses default action if omitted.'),
      params: z.record(z.string(), z.string()).optional().describe('Parameters for the action. Keys matching plugin config fields will override config values.'),
      wait: z.boolean().optional().describe('Auto-run "wait" action after main action (for async operations like Jenkins builds)'),
    },
    async (params) => {
      try {
        const { listInstalledPlugins, getInstalledPlugin } = await import('./plugins/registry');

        if (!params.plugin) {
          const installed = listInstalledPlugins();
          if (installed.length === 0) {
            return { content: [{ type: 'text', text: 'No plugins installed. Install from the Plugins page.' }] };
          }
          const list = installed.map((p: any) => {
            const actions = Object.keys(p.definition.actions).join(', ');
            return `• ${p.definition.icon} ${p.id} — ${p.definition.description || p.definition.name}\n  actions: ${actions}`;
          }).join('\n');
          return { content: [{ type: 'text', text: `Installed plugins:\n${list}` }] };
        }

        const inst = getInstalledPlugin(params.plugin);
        if (!inst) return { content: [{ type: 'text', text: `Plugin "${params.plugin}" not installed.` }] };
        if (!inst.enabled) return { content: [{ type: 'text', text: `Plugin "${params.plugin}" is disabled.` }] };

        const { executePluginWithWait } = await import('./plugins/executor');
        const actionName = params.action || inst.definition.defaultAction || Object.keys(inst.definition.actions)[0];

        if (!inst.definition.actions[actionName]) {
          const available = Object.keys(inst.definition.actions).join(', ');
          return { content: [{ type: 'text', text: `Action "${actionName}" not found. Available: ${available}` }] };
        }

        const result = await executePluginWithWait(inst, actionName, params.params || {}, params.wait || false);

        const output = JSON.stringify(result.output, null, 2);
        const status = result.ok ? 'OK' : 'FAILED';
        const duration = result.duration ? ` (${result.duration}ms)` : '';
        const error = result.error ? `\nError: ${result.error}` : '';

        return { content: [{ type: 'text', text: `${status}${duration}${error}\n${output}` }] };
      } catch (err: any) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }] };
      }
    }
  );

  // ── Memory Tools (code graph + knowledge store) ──────────
  // Heavy AST scanning runs in a worker thread to avoid blocking terminal/MCP.

  const memoryGraphCache = new Map<string, any>();

  async function runGraphWorker(action: string, data: any): Promise<any> {
    const { Worker } = await import('node:worker_threads');
    const { join } = await import('node:path');
    const workerPath = join(import.meta.dirname || __dirname, 'memory', 'graph-worker.ts');

    return new Promise((resolve, reject) => {
      const worker = new Worker(workerPath, {
        workerData: { action, ...data },
        execArgv: ['--require', require.resolve('tsx/cjs'), '--import', `file://${require.resolve('tsx/esm')}`],
      });
      worker.on('message', (msg) => {
        if (msg.ok) resolve(msg.result);
        else reject(new Error(msg.error));
      });
      worker.on('error', reject);
      worker.on('exit', (code) => { if (code !== 0) reject(new Error(`Worker exited with code ${code}`)); });
    });
  }

  async function getMemoryGraph(projectPath: string) {
    if (memoryGraphCache.has(projectPath)) return memoryGraphCache.get(projectPath);
    try {
      console.log(`[memory] Building code graph in worker thread: ${projectPath}`);
      const graph = await runGraphWorker('build', { projectPath });
      console.log(`[memory] Graph built: ${graph.nodes.length} nodes, ${graph.edges.length} edges`);
      memoryGraphCache.set(projectPath, graph);
      return graph;
    } catch (err: any) {
      console.error(`[memory] Worker failed: ${err.message}`);
      // Fallback: run in main thread for small projects
      try {
        const { buildCodeGraph } = await import('./memory/code-graph.js');
        const graph = buildCodeGraph(projectPath);
        memoryGraphCache.set(projectPath, graph);
        return graph;
      } catch { return null; }
    }
  }

  function getMemoryKnowledge(projectPath: string): any[] {
    try {
      const { join } = require('node:path');
      const { existsSync, readFileSync } = require('node:fs');
      const fp = join(projectPath, '.forge', 'memory', 'knowledge.json');
      if (!existsSync(fp)) return [];
      return JSON.parse(readFileSync(fp, 'utf-8'));
    } catch { return []; }
  }

  function saveMemoryKnowledge(projectPath: string, entries: any[]) {
    const { join } = require('node:path');
    const { writeFileSync, mkdirSync } = require('node:fs');
    const dir = join(projectPath, '.forge', 'memory');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'knowledge.json'), JSON.stringify(entries, null, 2));
  }

  server.tool(
    'search_code',
    'Find related files, functions, and dependencies via AST code graph. Returns direct matches + impact chain. Use before modifying code to understand blast radius.',
    { query: z.string().describe('Search query — function name, file name, module name (English code identifiers)') },
    async ({ query }) => {
      const { workspaceId } = ctx();
      if (!workspaceId) return { content: [{ type: 'text', text: 'Error: No workspace context' }] };
      try {
        const orch = getOrch(workspaceId);
        const graph = await getMemoryGraph(orch.projectPath);
        if (!graph) return { content: [{ type: 'text', text: 'Error: Failed to build code graph' }] };

        const { findAffectedBy } = await import('./memory/code-graph.js');
        const result = findAffectedBy(graph, query);
        const lines: string[] = [];
        if (result.directMatches.length > 0) {
          lines.push(`## Direct matches (${result.directMatches.length})`);
          for (const n of result.directMatches.slice(0, 15)) {
            lines.push(`- [${n.type}] **${n.name}**${n.exported ? ' (exported)' : ''} — ${n.filePath}${n.line ? ':' + n.line : ''}`);
          }
        }
        if (result.impactChain.length > 0) {
          lines.push(`\n## Impact chain (${result.impactChain.length})`);
          for (const c of result.impactChain.slice(0, 20)) {
            lines.push(`- depth=${c.depth} [${c.node.type}] ${c.node.name} — ${c.node.filePath}${c.node.line ? ':' + c.node.line : ''}`);
          }
        }
        if (result.directMatches.length === 0) lines.push('No matches found.');
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      } catch (err: any) { return { content: [{ type: 'text', text: `Error: ${err.message}` }] }; }
    }
  );

  server.tool(
    'get_file_context',
    'Get full context for a file: imports, importers, exports, and attached knowledge. Call before modifying a file.',
    { file_path: z.string().describe('Relative file path (e.g. "lib/workspace/orchestrator.ts")') },
    async ({ file_path }) => {
      const { workspaceId } = ctx();
      if (!workspaceId) return { content: [{ type: 'text', text: 'Error: No workspace context' }] };
      try {
        const orch = getOrch(workspaceId);
        const graph = await getMemoryGraph(orch.projectPath);
        if (!graph) return { content: [{ type: 'text', text: 'Error: No code graph' }] };
        const entries = getMemoryKnowledge(orch.projectPath);

        const fileNode = graph.nodes.find((n: any) => n.type === 'file' && (n.filePath === file_path || n.filePath.endsWith(file_path)));
        if (!fileNode) return { content: [{ type: 'text', text: `File "${file_path}" not found in graph.` }] };

        const lines: string[] = [`## ${fileNode.filePath} (module: ${fileNode.module})`];
        const imports = graph.edges.filter((e: any) => e.from === fileNode.id && e.type === 'imports');
        if (imports.length > 0) { lines.push(`\n### Imports (${imports.length})`); for (const e of imports) lines.push(`- ${e.to}${e.detail ? ' — ' + e.detail : ''}`); }
        const importedBy = graph.edges.filter((e: any) => e.to === fileNode.id && e.type === 'imports');
        if (importedBy.length > 0) { lines.push(`\n### Imported by (${importedBy.length})`); for (const e of importedBy) lines.push(`- ${e.from}`); }
        const exports = graph.edges.filter((e: any) => e.from === fileNode.id && e.type === 'exports');
        if (exports.length > 0) { lines.push(`\n### Exports (${exports.length})`); for (const e of exports) lines.push(`- ${e.detail || e.to}`); }

        const ICONS: Record<string, string> = { decision: '🎯', bug: '🐛', constraint: '⚠️', experience: '💡', note: '📝' };
        const fileKnowledge = entries.filter((k: any) => k.file && k.status === 'active' && (fileNode.filePath.includes(k.file) || k.file.includes(fileNode.filePath)));
        if (fileKnowledge.length > 0) {
          lines.push(`\n### Knowledge (${fileKnowledge.length})`);
          for (const k of fileKnowledge) lines.push(`- ${ICONS[k.type] || '📝'} **${k.title}**\n  ${k.content.slice(0, 200)}`);
        }
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      } catch (err: any) { return { content: [{ type: 'text', text: `Error: ${err.message}` }] }; }
    }
  );

  server.tool(
    'remember',
    'Store knowledge about the project (design decisions, known bugs, constraints). Persists across sessions.',
    {
      title: z.string().describe('One-line summary'),
      content: z.string().describe('Full description'),
      type: z.enum(['decision', 'bug', 'constraint', 'experience', 'note']),
      file: z.string().optional().describe('Anchor to file path'),
      tags: z.array(z.string()).optional(),
    },
    async ({ title, content, type, file, tags }) => {
      const { workspaceId, agentId } = ctx();
      if (!workspaceId) return { content: [{ type: 'text', text: 'Error: No workspace context' }] };
      try {
        const orch = getOrch(workspaceId);
        const entries = getMemoryKnowledge(orch.projectPath);
        const existing = entries.find((e: any) => e.title === title && e.file === file && e.status === 'active');
        if (existing) {
          existing.content = content; existing.type = type; existing.tags = tags || existing.tags; existing.updatedAt = Date.now();
          saveMemoryKnowledge(orch.projectPath, entries);
          return { content: [{ type: 'text', text: `Updated: "${title}" (id: ${existing.id})` }] };
        }
        const entry = { id: `k-${Date.now()}-${Math.random().toString(36).slice(2,5)}`, type, title, content, file, tags: tags || [], status: 'active', createdAt: Date.now(), updatedAt: Date.now(), createdBy: agentId };
        entries.push(entry);
        saveMemoryKnowledge(orch.projectPath, entries);
        return { content: [{ type: 'text', text: `Remembered: "${title}" [${type}]${file ? ' → ' + file : ''} (id: ${entry.id})` }] };
      } catch (err: any) { return { content: [{ type: 'text', text: `Error: ${err.message}` }] }; }
    }
  );

  server.tool(
    'recall',
    'Retrieve stored project knowledge. Search by keyword, filter by file or type.',
    {
      query: z.string().optional().describe('Keyword search'),
      file: z.string().optional().describe('Filter by file'),
      type: z.enum(['decision', 'bug', 'constraint', 'experience', 'note']).optional(),
    },
    async ({ query, file, type }) => {
      const { workspaceId } = ctx();
      if (!workspaceId) return { content: [{ type: 'text', text: 'Error: No workspace context' }] };
      try {
        const orch = getOrch(workspaceId);
        let entries = getMemoryKnowledge(orch.projectPath).filter((e: any) => e.status === 'active');
        if (type) entries = entries.filter((e: any) => e.type === type);
        if (file) entries = entries.filter((e: any) => e.file && (e.file.includes(file) || file.includes(e.file)));
        if (query) {
          const terms = query.toLowerCase().split(/\s+/);
          entries = entries.filter((e: any) => { const h = `${e.title} ${e.content} ${(e.tags||[]).join(' ')} ${e.file||''}`.toLowerCase(); return terms.every((t: string) => h.includes(t)); });
        }
        entries = entries.slice(0, 20);
        if (entries.length === 0) return { content: [{ type: 'text', text: 'No knowledge found.' }] };
        const ICONS: Record<string, string> = { decision: '🎯', bug: '🐛', constraint: '⚠️', experience: '💡', note: '📝' };
        const lines = entries.map((e: any) => `${ICONS[e.type]||'📝'} **${e.title}**\n  ${e.content.slice(0,300)}\n  ${e.file?'file: '+e.file:''} | id: ${e.id}`);
        return { content: [{ type: 'text', text: `Found ${entries.length}:\n\n${lines.join('\n\n')}` }] };
      } catch (err: any) { return { content: [{ type: 'text', text: `Error: ${err.message}` }] }; }
    }
  );

  server.tool(
    'forget',
    'Delete a knowledge entry by ID.',
    { id: z.string() },
    async ({ id }) => {
      const { workspaceId } = ctx();
      if (!workspaceId) return { content: [{ type: 'text', text: 'Error: No workspace context' }] };
      try {
        const orch = getOrch(workspaceId);
        const entries = getMemoryKnowledge(orch.projectPath);
        const idx = entries.findIndex((e: any) => e.id === id);
        if (idx < 0) return { content: [{ type: 'text', text: `Not found: ${id}` }] };
        const removed = entries.splice(idx, 1)[0];
        saveMemoryKnowledge(orch.projectPath, entries);
        return { content: [{ type: 'text', text: `Deleted: "${removed.title}"` }] };
      } catch (err: any) { return { content: [{ type: 'text', text: `Error: ${err.message}` }] }; }
    }
  );

  server.tool(
    'rescan_code',
    'Update the code graph. By default does incremental update (only changed files). Use force=true for full rescan.',
    {
      force: z.boolean().optional().describe('Force full rescan instead of incremental update'),
    },
    async ({ force }) => {
      const { workspaceId } = ctx();
      if (!workspaceId) return { content: [{ type: 'text', text: 'Error: No workspace context' }] };
      try {
        const orch = getOrch(workspaceId);
        const projectPath = orch.projectPath;
        const t0 = Date.now();

        if (force) {
          // Full rescan
          memoryGraphCache.delete(projectPath);
          const graph = await getMemoryGraph(projectPath);
          return { content: [{ type: 'text', text: `Full rescan in ${Date.now()-t0}ms: ${graph?.nodes?.length || 0} nodes, ${graph?.edges?.length || 0} edges` }] };
        }

        // Incremental: find changed files since last scan
        const { existsSync, readFileSync, writeFileSync, mkdirSync } = await import('node:fs');
        const { join } = await import('node:path');
        const { execSync } = await import('node:child_process');
        const metaPath = join(projectPath, '.forge', 'memory', 'meta.json');
        let lastCommit: string | undefined;
        try { lastCommit = JSON.parse(readFileSync(metaPath, 'utf-8')).lastScanCommit; } catch {}
        let currentCommit: string | undefined;
        try { currentCommit = execSync('git rev-parse HEAD', { cwd: projectPath, encoding: 'utf-8' }).trim().slice(0, 12); } catch {}

        // Quick check: any dirty files at all?
        if (lastCommit === currentCommit) {
          let dirtyCount = 0;
          try { dirtyCount += execSync('git diff --name-only', { cwd: projectPath, encoding: 'utf-8' }).trim().split('\n').filter(Boolean).length; } catch {}
          try { dirtyCount += execSync('git ls-files --others --exclude-standard', { cwd: projectPath, encoding: 'utf-8' }).trim().split('\n').filter(Boolean).length; } catch {}
          if (dirtyCount === 0) {
            return { content: [{ type: 'text', text: 'Graph is up to date (no changes since last scan).' }] };
          }
        }

        // Get ALL changed files: committed + modified (unstaged) + untracked
        let changedFiles: string[] = [];
        // Committed changes since last scan
        if (lastCommit) {
          try { changedFiles = execSync(`git diff --name-only ${lastCommit}..HEAD`, { cwd: projectPath, encoding: 'utf-8' }).trim().split('\n').filter(Boolean); } catch {}
        }
        // Modified but not committed (working tree changes)
        try {
          const modified = execSync('git diff --name-only', { cwd: projectPath, encoding: 'utf-8' }).trim().split('\n').filter(Boolean);
          changedFiles.push(...modified);
        } catch {}
        // Staged but not committed
        try {
          const staged = execSync('git diff --name-only --cached', { cwd: projectPath, encoding: 'utf-8' }).trim().split('\n').filter(Boolean);
          changedFiles.push(...staged);
        } catch {}
        // Untracked new files
        try {
          const untracked = execSync('git ls-files --others --exclude-standard', { cwd: projectPath, encoding: 'utf-8' }).trim().split('\n').filter(Boolean);
          changedFiles.push(...untracked);
        } catch {}
        changedFiles = [...new Set(changedFiles)];

        if (changedFiles.length === 0) {
          return { content: [{ type: 'text', text: 'No file changes detected.' }] };
        }

        const existing = memoryGraphCache.get(projectPath);
        if (existing && changedFiles.length < 500) {
          // Incremental update in worker
          try {
            const updated = await runGraphWorker('incremental', { existingGraph: existing, projectPath, changedFiles });
            memoryGraphCache.set(projectPath, updated);
            // Save meta
            mkdirSync(join(projectPath, '.forge', 'memory'), { recursive: true });
            writeFileSync(metaPath, JSON.stringify({ projectPath, lastScanCommit: currentCommit, lastScanAt: Date.now(), nodeCount: updated.nodes.length, edgeCount: updated.edges.length }, null, 2));
            return { content: [{ type: 'text', text: `Incremental update in ${Date.now()-t0}ms: ${changedFiles.length} files changed → ${updated.nodes.length} nodes, ${updated.edges.length} edges` }] };
          } catch {}
        }

        // Fallback: full rescan
        memoryGraphCache.delete(projectPath);
        const graph = await getMemoryGraph(projectPath);
        mkdirSync(join(projectPath, '.forge', 'memory'), { recursive: true });
        writeFileSync(metaPath, JSON.stringify({ projectPath, lastScanCommit: currentCommit, lastScanAt: Date.now(), nodeCount: graph?.nodes?.length, edgeCount: graph?.edges?.length }, null, 2));
        return { content: [{ type: 'text', text: `Full rescan in ${Date.now()-t0}ms: ${graph?.nodes?.length || 0} nodes, ${graph?.edges?.length || 0} edges` }] };
      } catch (err: any) { return { content: [{ type: 'text', text: `Error: ${err.message}` }] }; }
    }
  );

  // ── get_pipeline_status ────────────────────────
  server.tool(
    'get_pipeline_status',
    'Check the status and results of a running or completed pipeline.',
    {
      pipeline_id: z.string().describe('Pipeline ID to check'),
    },
    async (params) => {
      try {
        const { getPipeline } = await import('./pipeline');
        const pipeline = getPipeline(params.pipeline_id);
        if (!pipeline) return { content: [{ type: 'text', text: `Pipeline "${params.pipeline_id}" not found.` }] };

        const nodes = Object.entries(pipeline.nodes).map(([id, n]: [string, any]) => {
          let line = `  ${id}: ${n.status}`;
          if (n.error) line += ` — ${n.error}`;
          if (n.outputs && Object.keys(n.outputs).length > 0) {
            for (const [k, v] of Object.entries(n.outputs)) {
              line += `\n    ${k}: ${String(v).slice(0, 200)}`;
            }
          }
          return line;
        }).join('\n');

        return { content: [{ type: 'text', text: `Pipeline ${pipeline.id} [${pipeline.status}] (${pipeline.workflowName})\n${nodes}` }] };
      } catch (err: any) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }] };
      }
    }
  );

  // ─── Request/Response Document Tools ─────────────────────

  server.tool(
    'create_request',
    'Create a new request document for implementation. Auto-notifies downstream agents via DAG.',
    {
      title: z.string().describe('Short title for the request'),
      description: z.string().describe('Detailed description of what to implement'),
      type: z.enum(['feature', 'bugfix', 'refactor', 'task']).optional().describe('Request type (default: feature)'),
      modules: z.array(z.object({
        name: z.string(),
        description: z.string(),
        acceptance_criteria: z.array(z.string()),
      })).describe('Feature modules with acceptance criteria'),
      batch: z.string().optional().describe('Batch name to group related requests (default: auto-generated from date)'),
      priority: z.enum(['high', 'medium', 'low']).optional().describe('Priority level (default: medium)'),
    },
    async (params) => {
      const { workspaceId, agentId } = ctx();
      if (!workspaceId) return { content: [{ type: 'text', text: 'Error: No workspace context.' }] };
      try {
        const orch = getOrch(workspaceId);
        const { createRequest } = await import('./workspace/requests') as any;
        const batch = params.batch || `delivery-${new Date().toISOString().slice(0, 10)}`;
        const agentLabel = orch.getSnapshot().agents.find((a: any) => a.id === agentId)?.label || agentId;

        const ref = createRequest(orch.projectPath, {
          title: params.title,
          description: params.description,
          type: params.type || 'feature',
          modules: params.modules,
          batch,
          priority: params.priority || 'medium',
          status: 'open',
          assigned_to: '',
          created_by: agentLabel,
        });

        // Auto-notify downstream agents via DAG
        const snapshot = orch.getSnapshot();
        const notified: string[] = [];
        for (const agent of snapshot.agents) {
          if (agent.type === 'input') continue;
          if (!agent.dependsOn?.includes(agentId)) continue;
          orch.getBus().send(agentId, agent.id, 'notify', {
            action: 'new_request',
            content: `New request: ${params.title} [${params.priority || 'medium'}] — ${params.modules.length} module(s). Use list_requests and claim_request to pick it up.`,
            ref,
          });
          notified.push(agent.label);
        }

        return { content: [{ type: 'text', text: `Created request: ${ref}\nBatch: ${batch}\nModules: ${params.modules.length}\nNotified: ${notified.length > 0 ? notified.join(', ') : '(no downstream agents)'}` }] };
      } catch (err: any) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }] };
      }
    }
  );

  server.tool(
    'claim_request',
    'Claim an open request for implementation. Prevents other agents from working on the same request.',
    {
      request_id: z.string().describe('Request ID to claim (e.g., REQ-20260403-001)'),
    },
    async (params) => {
      const { workspaceId, agentId } = ctx();
      if (!workspaceId) return { content: [{ type: 'text', text: 'Error: No workspace context.' }] };
      try {
        const orch = getOrch(workspaceId);
        const { claimRequest } = await import('./workspace/requests') as any;
        const agentLabel = orch.getSnapshot().agents.find((a: any) => a.id === agentId)?.label || agentId;

        const result = claimRequest(orch.projectPath, params.request_id, agentLabel);
        if (!result.ok) {
          return { content: [{ type: 'text', text: `Cannot claim ${params.request_id}: already claimed by ${result.claimedBy}. Use list_requests(status: "open") to find available requests.` }] };
        }
        return { content: [{ type: 'text', text: `Claimed ${params.request_id}. Status: in_progress. You can now implement it and use update_response when done.` }] };
      } catch (err: any) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }] };
      }
    }
  );

  server.tool(
    'update_response',
    'Update a response document with your work results. Auto-advances status and notifies downstream agents via DAG.',
    {
      request_id: z.string().describe('Request ID (e.g., REQ-20260403-001)'),
      section: z.enum(['engineer', 'review', 'qa']).describe('Which section to update'),
      data: z.object({
        files_changed: z.array(z.string()).optional().describe('Files modified (engineer)'),
        notes: z.string().optional().describe('Implementation notes (engineer)'),
        result: z.string().optional().describe('Result: approved/changes_requested/rejected (review) or passed/failed (qa)'),
        findings: z.array(z.object({
          severity: z.string(),
          description: z.string(),
        })).optional().describe('Issues found (review/qa)'),
        test_files: z.array(z.string()).optional().describe('Test files run (qa)'),
      }).describe('Response data for your section'),
    },
    async (params) => {
      const { workspaceId, agentId } = ctx();
      if (!workspaceId) return { content: [{ type: 'text', text: 'Error: No workspace context.' }] };
      try {
        const orch = getOrch(workspaceId);
        const { updateResponse, getRequest } = await import('./workspace/requests') as any;

        const ref = updateResponse(orch.projectPath, params.request_id, params.section, params.data);
        const updated = getRequest(orch.projectPath, params.request_id);
        const newStatus = updated?.request?.status || 'unknown';

        // Auto-notify downstream agents via DAG
        const snapshot = orch.getSnapshot();
        const notified: string[] = [];
        for (const agent of snapshot.agents) {
          if (agent.type === 'input') continue;
          if (!agent.dependsOn?.includes(agentId)) continue;
          orch.getBus().send(agentId, agent.id, 'notify', {
            action: 'response_updated',
            content: `${params.section} completed for ${params.request_id} → status: ${newStatus}. Use get_request to review details.`,
            ref,
          });
          notified.push(agent.label);
        }

        return { content: [{ type: 'text', text: `Updated ${params.request_id} [${params.section}] → status: ${newStatus}\nNotified: ${notified.length > 0 ? notified.join(', ') : '(no downstream agents)'}` }] };
      } catch (err: any) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }] };
      }
    }
  );

  server.tool(
    'list_requests',
    'List all request documents in the project, optionally filtered by batch or status.',
    {
      batch: z.string().optional().describe('Filter by batch/delivery name'),
      status: z.enum(['open', 'in_progress', 'review', 'qa', 'done', 'rejected']).optional().describe('Filter by status'),
    },
    async (params) => {
      const { workspaceId } = ctx();
      if (!workspaceId) return { content: [{ type: 'text', text: 'Error: No workspace context.' }] };
      try {
        const orch = getOrch(workspaceId);
        const { listRequests, getBatchStatus } = await import('./workspace/requests') as any;

        const requests = listRequests(orch.projectPath, { batch: params.batch, status: params.status as any });
        if (requests.length === 0) {
          return { content: [{ type: 'text', text: params.batch || params.status ? 'No requests match the filter.' : 'No requests found. Use create_request to create one.' }] };
        }

        const lines = requests.map((r: any) =>
          `[${r.status}] ${r.id}: ${r.title} (${r.priority}) — ${r.modules?.length || 0} module(s)${r.assigned_to ? ` → ${r.assigned_to}` : ''}`
        );

        // Add batch summary if filtering by batch
        if (params.batch) {
          const bs = getBatchStatus(orch.projectPath, params.batch);
          lines.push(`\nBatch "${params.batch}": ${bs.done}/${bs.total} done${bs.allDone ? ' ✓ ALL COMPLETE' : ''}`);
        }

        return { content: [{ type: 'text', text: lines.join('\n') }] };
      } catch (err: any) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }] };
      }
    }
  );

  server.tool(
    'get_request',
    'Get full details of a request document and its response.',
    {
      request_id: z.string().describe('Request ID (e.g., REQ-20260403-001)'),
    },
    async (params) => {
      const { workspaceId } = ctx();
      if (!workspaceId) return { content: [{ type: 'text', text: 'Error: No workspace context.' }] };
      try {
        const orch = getOrch(workspaceId);
        const { getRequest } = await import('./workspace/requests') as any;

        const result = getRequest(orch.projectPath, params.request_id);
        if (!result) return { content: [{ type: 'text', text: `Request "${params.request_id}" not found.` }] };

        const YAML = (await import('yaml')).default;
        let text = `# Request: ${result.request.title}\n\n`;
        text += YAML.stringify(result.request);
        if (result.response) {
          text += `\n---\n# Response\n\n`;
          text += YAML.stringify(result.response);
        } else {
          text += `\n---\nNo response yet.`;
        }

        return { content: [{ type: 'text', text }] };
      } catch (err: any) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }] };
      }
    }
  );

  // Update get_inbox to show ref field
  // (Already handled — ref is part of payload, shown via content)

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

      // Extract workspace context from URL params
      const workspaceId = url.searchParams.get('workspaceId') || '';
      const agentId = url.searchParams.get('agentId') || (workspaceId ? resolveAgentFromOrch(workspaceId) : '');
      sessionContexts.set(sessionId, { workspaceId, agentId });

      transport.onclose = () => {
        transports.delete(sessionId);
        sessionContexts.delete(sessionId);
      };

      // Each session gets its own MCP server with context
      const server = createForgeMcpServer(sessionId);
      await server.connect(transport);
      let agentLabel = 'unknown';
      try { agentLabel = workspaceId ? (getOrch(workspaceId)?.getSnapshot()?.agents?.find((a: any) => a.id === agentId)?.label || agentId) : 'unknown'; } catch {}
      console.log(`[forge-mcp] Client connected: ${agentLabel} (ws=${workspaceId?.slice(0, 8) || '?'}, session=${sessionId})`);
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
  return Number(process.env.MCP_PORT) || 8406;
}
