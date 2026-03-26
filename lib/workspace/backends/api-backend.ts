/**
 * API Backend — executes agent steps via Vercel AI SDK (generateText + tools).
 *
 * Uses the subscription-free API path: requires an API key.
 * Provides full tool control and maxSteps auto tool loop.
 */

import { generateText, stepCountIs, type ModelMessage } from 'ai';
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { execSync, execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { getModel } from '@/src/core/providers/registry';
import type { AgentBackend, StepExecutionParams, StepExecutionResult, Artifact } from '../types';
import type { TaskLogEntry } from '@/src/types';

// ─── Tool factory ────────────────────────────────────────

function createTools(projectPath: string, artifacts: Artifact[], onLog?: (e: TaskLogEntry) => void) {
  const ts = () => new Date().toISOString();

  const safePath = (p: string) => {
    const abs = resolve(projectPath, p);
    const root = resolve(projectPath) + '/';
    // Must be exactly the project root or a child (trailing slash prevents /project-evil matching /project)
    if (abs !== resolve(projectPath) && !abs.startsWith(root)) throw new Error(`Path outside project: ${p}`);
    return abs;
  };

  return {
    read_file: {
      description: 'Read the contents of a file. Path is relative to project root.',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      execute: async ({ path }: { path: string }) => {
        const abs = safePath(path);
        onLog?.({ type: 'assistant', subtype: 'tool_use', content: path, tool: 'read_file', timestamp: ts() });
        try {
          const content = readFileSync(abs, 'utf-8');
          onLog?.({ type: 'assistant', subtype: 'tool_result', content: `Read ${content.length} chars`, timestamp: ts() });
          return content;
        } catch (err: any) {
          return `Error reading file: ${err.message}`;
        }
      },
    },

    write_file: {
      description: 'Write content to a file. Creates parent directories if needed.',
      parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
      execute: async ({ path, content }: { path: string; content: string }) => {
        const abs = safePath(path);
        onLog?.({ type: 'assistant', subtype: 'tool_use', content: `write ${path} (${content.length} chars)`, tool: 'write_file', timestamp: ts() });
        try {
          mkdirSync(dirname(abs), { recursive: true });
          writeFileSync(abs, content, 'utf-8');
          artifacts.push({ type: 'file', path, summary: `Written ${content.length} chars` });
          onLog?.({ type: 'assistant', subtype: 'tool_result', content: `Wrote ${path}`, timestamp: ts() });
          return `Successfully wrote ${path}`;
        } catch (err: any) {
          return `Error writing file: ${err.message}`;
        }
      },
    },

    list_dir: {
      description: 'List files and directories. Path is relative to project root.',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: [] },
      execute: async ({ path = '.' }: { path?: string }) => {
        const abs = safePath(path || '.');
        onLog?.({ type: 'assistant', subtype: 'tool_use', content: path || '.', tool: 'list_dir', timestamp: ts() });
        try {
          const entries = readdirSync(abs, { withFileTypes: true });
          return entries.map(e => `${e.isDirectory() ? '[dir]' : '[file]'} ${e.name}`).join('\n');
        } catch (err: any) {
          return `Error listing directory: ${err.message}`;
        }
      },
    },

    search_files: {
      description: 'Search for text content in files using grep.',
      parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } }, required: ['pattern'] },
      execute: async ({ pattern, path = '.' }: { pattern: string; path?: string }) => {
        const abs = safePath(path || '.');
        onLog?.({ type: 'assistant', subtype: 'tool_use', content: `grep "${pattern}" in ${path || '.'}`, tool: 'search_files', timestamp: ts() });
        try {
          // Use execFileSync to avoid shell injection — pattern is passed as argument, not interpolated
          const result = execFileSync('grep', ['-rn', '--include=*', pattern, abs], {
            encoding: 'utf-8', timeout: 10000, maxBuffer: 512 * 1024,
          }).split('\n').slice(0, 50).join('\n');
          return result || 'No matches found';
        } catch {
          return 'No matches found';
        }
      },
    },

    run_command: {
      description: 'Run a shell command in the project directory.',
      parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
      execute: async ({ command }: { command: string }) => {
        onLog?.({ type: 'assistant', subtype: 'tool_use', content: command, tool: 'run_command', timestamp: ts() });
        try {
          const result = execSync(command, { cwd: projectPath, encoding: 'utf-8', timeout: 60000, maxBuffer: 1024 * 1024 });
          const truncated = result.length > 5000 ? result.slice(0, 5000) + '\n... (truncated)' : result;
          onLog?.({ type: 'assistant', subtype: 'tool_result', content: truncated, timestamp: ts() });
          return truncated;
        } catch (err: any) {
          const msg = err.stderr || err.message || String(err);
          onLog?.({ type: 'assistant', subtype: 'tool_result', content: `Error: ${msg}`, timestamp: ts() });
          return `Command failed: ${msg}`;
        }
      },
    },
  };
}

/** Create inter-agent communication tools (only if bus callbacks are provided) */
function createCommTools(
  agentId: string,
  peerAgentIds: string[],
  onBusSend?: (to: string, content: string) => void,
  onBusRequest?: (to: string, question: string) => Promise<string>,
  onLog?: (e: TaskLogEntry) => void,
) {
  const ts = () => new Date().toISOString();
  const tools: Record<string, any> = {};

  if (onBusSend) {
    tools.notify_agent = {
      description: `Send a notification message to another agent. Available agents: ${peerAgentIds.join(', ')}`,
      parameters: { type: 'object', properties: {
        to: { type: 'string', description: 'Target agent ID' },
        message: { type: 'string', description: 'Message content' },
      }, required: ['to', 'message'] },
      execute: async ({ to, message }: { to: string; message: string }) => {
        onLog?.({ type: 'assistant', subtype: 'tool_use', content: `→ ${to}: ${message}`, tool: 'notify_agent', timestamp: ts() });
        onBusSend(to, message);
        return `Message sent to ${to}`;
      },
    };
  }

  if (onBusRequest) {
    tools.ask_agent = {
      description: `Ask another agent a question and wait for their response. Available agents: ${peerAgentIds.join(', ')}`,
      parameters: { type: 'object', properties: {
        to: { type: 'string', description: 'Target agent ID' },
        question: { type: 'string', description: 'Question to ask' },
      }, required: ['to', 'question'] },
      execute: async ({ to, question }: { to: string; question: string }) => {
        onLog?.({ type: 'assistant', subtype: 'tool_use', content: `→ ${to}: ${question}`, tool: 'ask_agent', timestamp: ts() });
        try {
          const response = await onBusRequest(to, question);
          onLog?.({ type: 'assistant', subtype: 'tool_result', content: `← ${to}: ${response}`, timestamp: ts() });
          return response;
        } catch (err: any) {
          return `No response from ${to}: ${err.message}`;
        }
      },
    };
  }

  return tools;
}

// ─── History → AI SDK messages ───────────────────────────

function historyToMessages(history: TaskLogEntry[]): ModelMessage[] {
  const messages: ModelMessage[] = [];
  // Only include last 3 step results + truncate tool results to save tokens
  const MAX_HISTORY_STEPS = 3;
  const MAX_TOOL_RESULT = 500;

  // Filter to step-level results only (skip individual tool calls)
  const stepResults = history
    .filter(m => m.type === 'result' && m.subtype === 'step_complete')
    .slice(-MAX_HISTORY_STEPS);

  let currentAssistant = '';

  for (const entry of stepResults) {
    const truncated = entry.content.length > 1000
      ? entry.content.slice(0, 1000) + '... (truncated)'
      : entry.content;
    currentAssistant += (currentAssistant ? '\n\n' : '') + truncated;
  }

  if (currentAssistant) {
    messages.push({ role: 'assistant', content: currentAssistant });
  }

  return messages;
}

// ─── API Backend class ───────────────────────────────────

export class ApiBackend implements AgentBackend {
  private abortController: AbortController | null = null;

  async executeStep(params: StepExecutionParams): Promise<StepExecutionResult> {
    const { config, step, history, projectPath, upstreamContext, onLog,
            onBusSend, onBusRequest, peerAgentIds } = params;

    if (!config.provider) throw new Error('API backend requires a provider');

    this.abortController = new AbortController();
    const model = getModel(config.provider, config.model);
    const artifacts: Artifact[] = [];

    // Build messages: history context + current step prompt
    const messages: ModelMessage[] = historyToMessages(history);

    let userPrompt = step.prompt;
    if (upstreamContext) {
      userPrompt = `## Upstream agent output:\n${upstreamContext}\n\n---\n\n${userPrompt}`;
    }
    messages.push({ role: 'user', content: userPrompt });

    // Create tools: filesystem + communication
    const fsTools = createTools(projectPath, artifacts, onLog);
    const commTools = createCommTools(config.id, peerAgentIds || [], onBusSend, onBusRequest, onLog);
    const tools = { ...fsTools, ...commTools } as any;

    onLog?.({
      type: 'system',
      subtype: 'init',
      content: `Step "${step.label}" — ${config.provider}/${config.model || 'default'}`,
      timestamp: new Date().toISOString(),
    });

    const result = await generateText({
      model,
      system: config.role,
      messages,
      tools,
      stopWhen: stepCountIs(20),
      abortSignal: this.abortController.signal,
      onStepFinish: ({ text }: { text?: string }) => {
        if (text) {
          onLog?.({
            type: 'assistant',
            subtype: 'text',
            content: text,
            timestamp: new Date().toISOString(),
          });
        }
      },
    } as any);

    return {
      response: result.text,
      artifacts,
      inputTokens: result.usage?.inputTokens ?? 0,
      outputTokens: result.usage?.outputTokens ?? 0,
    };
  }

  abort(): void {
    this.abortController?.abort();
    this.abortController = null;
  }
}
