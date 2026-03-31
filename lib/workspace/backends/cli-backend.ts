/**
 * CLI Backend — executes agent steps by spawning CLI tools headless.
 *
 * Supports subscription accounts (no API key needed).
 * Each step = one `claude -p "..."` call.
 * Multi-step context via --resume (Claude) or prompt injection (others).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { getAgent } from '../../agents';
import type { AgentBackend, AgentStep, StepExecutionParams, StepExecutionResult, Artifact } from '../types';
import type { TaskLogEntry } from '../../../src/types';

const esmRequire = createRequire(import.meta.url);

// ─── Stream-JSON parser (reused from task-manager pattern) ──

function parseStreamJson(parsed: any): TaskLogEntry[] {
  const entries: TaskLogEntry[] = [];
  const ts = new Date().toISOString();

  if (parsed.type === 'system' && parsed.subtype === 'init') {
    entries.push({ type: 'system', subtype: 'init', content: `Model: ${parsed.model || 'unknown'}`, timestamp: ts });
    return entries;
  }

  if (parsed.type === 'assistant' && parsed.message?.content) {
    for (const block of parsed.message.content) {
      if (block.type === 'text' && block.text) {
        entries.push({ type: 'assistant', subtype: 'text', content: block.text, timestamp: ts });
      } else if (block.type === 'tool_use') {
        entries.push({
          type: 'assistant',
          subtype: 'tool_use',
          content: typeof block.input === 'string' ? block.input : JSON.stringify(block.input || {}),
          tool: block.name,
          timestamp: ts,
        });
      } else if (block.type === 'tool_result') {
        entries.push({
          type: 'assistant',
          subtype: 'tool_result',
          content: typeof block.content === 'string' ? block.content : JSON.stringify(block.content || ''),
          timestamp: ts,
        });
      }
    }
    return entries;
  }

  if (parsed.type === 'result') {
    entries.push({
      type: 'result',
      subtype: parsed.subtype || 'success',
      content: typeof parsed.result === 'string' ? parsed.result : JSON.stringify(parsed.result || ''),
      timestamp: ts,
    });
    return entries;
  }

  // Ignore rate limit events
  if (parsed.type === 'rate_limit_event') return entries;

  // Unknown type — log raw
  entries.push({ type: 'assistant', subtype: parsed.type || 'unknown', content: JSON.stringify(parsed), timestamp: ts });
  return entries;
}

// ─── Artifact detection from tool_use events ─────────────

const WRITE_TOOL_NAMES = new Set(['Write', 'write_to_file', 'Edit', 'create_file', 'write_file']);

function detectArtifacts(parsed: any): Artifact[] {
  const artifacts: Artifact[] = [];
  if (parsed.type !== 'assistant' || !parsed.message?.content) return artifacts;

  for (const block of parsed.message.content) {
    if (block.type === 'tool_use' && WRITE_TOOL_NAMES.has(block.name)) {
      const path = block.input?.file_path || block.input?.path || block.input?.filename;
      if (path) {
        artifacts.push({ type: 'file', path, summary: `Written by ${block.name}` });
      }
    }
  }
  return artifacts;
}

// ─── CLI Backend class ───────────────────────────────────

export class CliBackend implements AgentBackend {
  private child: ChildProcess | null = null;
  private sessionId: string | undefined;
  headlessSessionId: string | undefined; // exposed for session file monitoring
  /** Callback to persist sessionId back to agent state */
  onSessionId?: (id: string) => void;

  constructor(initialSessionId?: string) {
    this.sessionId = initialSessionId;
  }

  async executeStep(params: StepExecutionParams): Promise<StepExecutionResult> {
    const { config, step, history, projectPath, upstreamContext, onLog, abortSignal, workspaceId } = params;
    const agentId = config.agentId || 'claude';

    let adapter;
    try {
      adapter = getAgent(agentId);
    } catch {
      throw new Error(`Agent "${agentId}" not found or not installed`);
    }

    // Build prompt with context
    const prompt = this.buildStepPrompt(step, history, upstreamContext);

    // Use adapter to build spawn command (same as task-manager)
    // Model priority: workspace config > profile config > adapter default
    const effectiveModel = config.model || (adapter.config as any).model;
    // Note: if no sessionId, each execution starts a new session (no resume).
    // To maintain context, user can enable persistent terminal session per agent.

    // Generate a session ID for headless execution so we can monitor the .jsonl file
    const isClaude = adapter.config.type === 'claude-code';
    if (isClaude && !this.sessionId) {
      const { randomUUID } = require('node:crypto');
      this.headlessSessionId = randomUUID();
    }

    const spawnOpts = adapter.buildTaskSpawn({
      projectPath,
      prompt,
      model: effectiveModel,
      conversationId: this.sessionId,
      skipPermissions: true,
      outputFormat: adapter.config.capabilities?.supportsStreamJson ? 'stream-json' : undefined,
      extraFlags: this.headlessSessionId && !this.sessionId ? ['--session-id', this.headlessSessionId] : undefined,
    });

    onLog?.({
      type: 'system',
      subtype: 'init',
      content: `Step "${step.label}" — ${agentId}${config.model ? `/${config.model}` : ''}${this.sessionId ? ' (resume)' : ''}`,
      timestamp: new Date().toISOString(),
    });

    return new Promise<StepExecutionResult>((resolve, reject) => {
      // Merge env: process env → adapter spawn env → profile env → workspace context
      const profileEnv = (adapter.config as any).env || {};
      const env = {
        ...process.env,
        ...(spawnOpts.env || {}),
        ...profileEnv,
        // Inject workspace context so forge skills can use them
        FORGE_AGENT_ID: config.id,
        FORGE_WORKSPACE_ID: workspaceId || '',
        FORGE_PORT: String(process.env.PORT || 8403),
      };
      delete env.CLAUDECODE;

      // Check if agent needs TTY (same logic as task-manager)
      const needsTTY = adapter.config.capabilities?.requiresTTY
        || agentId === 'codex' || (adapter.config as any).base === 'codex';

      if (needsTTY) {
        this.executePTY(spawnOpts, projectPath, env, onLog, abortSignal, resolve, reject);
        return;
      }

      this.child = spawn(spawnOpts.cmd, spawnOpts.args, {
        cwd: projectPath,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.child.stdin?.end();

      let buffer = '';
      let resultText = '';
      let sessionId = '';
      const artifacts: Artifact[] = [];
      let inputTokens = 0;
      let outputTokens = 0;

      // Handle abort signal
      const onAbort = () => {
        this.child?.kill('SIGTERM');
      };
      abortSignal?.addEventListener('abort', onAbort, { once: true });

      // Fatal error detection pattern — only used for stderr (stdout is structured JSON)
      const FATAL_PATTERN = /usage limit|rate limit|hit your.*limit|upgrade to (plus|pro|max)|exceeded.*monthly|you've been rate limited|api key.*invalid|insufficient.*quota|billing.*not.*active/i;
      let fatalDetected = false;

      this.child.stdout?.on('data', (data: Buffer) => {
        const raw = data.toString();
        // Fatal detection on stdout — only on non-JSON lines (skip tool results, user messages)
        // JSON lines start with { and contain structured data from claude CLI
        if (!fatalDetected && FATAL_PATTERN.test(raw)) {
          // Check each line individually — only flag if it's NOT inside a JSON payload
          const nonJsonLines = raw.split('\n').filter(l => {
            const trimmed = l.trim();
            return trimmed && !trimmed.startsWith('{') && !trimmed.startsWith('"') && !trimmed.includes('tool_use_id');
          });
          const fatalLine = nonJsonLines.find(l => FATAL_PATTERN.test(l));
          if (fatalLine) {
            fatalDetected = true;
            console.log(`[cli-backend] Fatal error detected: ${fatalLine.trim().slice(0, 100)}`);
            onLog?.({ type: 'system', subtype: 'error', content: fatalLine.trim().slice(0, 200), timestamp: new Date().toISOString() });
            this.child?.kill('SIGTERM');
            return;
          }
        }
        buffer += raw;
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line);

            // Emit log entries
            const entries = parseStreamJson(parsed);
            for (const entry of entries) {
              onLog?.(entry);
            }

            // Track session ID for multi-step resume
            if (parsed.session_id) sessionId = parsed.session_id;

            // Track result
            if (parsed.type === 'result') {
              resultText = typeof parsed.result === 'string'
                ? parsed.result
                : JSON.stringify(parsed.result || '');
              if (parsed.total_cost_usd) {
                // Cost tracking if available
              }
            }

            // Track usage
            if (parsed.usage) {
              inputTokens += parsed.usage.input_tokens || 0;
              outputTokens += parsed.usage.output_tokens || 0;
            }

            // Detect file write artifacts
            artifacts.push(...detectArtifacts(parsed));

          } catch {
            // Non-JSON line — emit as raw text log
            if (line.trim()) {
              onLog?.({
                type: 'assistant',
                subtype: 'text',
                content: line,
                timestamp: new Date().toISOString(),
              });
            }
          }
        }
      });

      this.child.stderr?.on('data', (data: Buffer) => {
        const text = data.toString().trim();
        // Also check stderr for fatal errors
        if (!fatalDetected && FATAL_PATTERN.test(text)) {
          fatalDetected = true;
          console.log(`[cli-backend] Fatal error in stderr: ${text.slice(0, 100)}`);
          this.child?.kill('SIGTERM');
        }
        if (text) {
          onLog?.({
            type: 'system',
            subtype: 'error',
            content: text,
            timestamp: new Date().toISOString(),
          });
        }
      });

      this.child.on('error', (err) => {
        abortSignal?.removeEventListener('abort', onAbort);
        this.child = null;
        reject(err);
      });

      this.child.on('exit', (code) => {
        abortSignal?.removeEventListener('abort', onAbort);

        // Flush remaining buffer
        if (buffer.trim()) {
          try {
            const parsed = JSON.parse(buffer);
            const entries = parseStreamJson(parsed);
            for (const entry of entries) onLog?.(entry);
            if (parsed.type === 'result') {
              resultText = typeof parsed.result === 'string' ? parsed.result : JSON.stringify(parsed.result || '');
            }
            if (parsed.session_id) sessionId = parsed.session_id;
            artifacts.push(...detectArtifacts(parsed));
          } catch {
            if (buffer.trim()) {
              onLog?.({ type: 'assistant', subtype: 'text', content: buffer.trim(), timestamp: new Date().toISOString() });
            }
          }
        }

        // Persist session ID for multi-step resume
        this.sessionId = sessionId || this.sessionId;
        if (this.sessionId && this.onSessionId) this.onSessionId(this.sessionId);
        this.child = null;

        // Check for error patterns even if exit code is 0
        const KNOWN_ERRORS = /usage limit|rate limit|upgrade to|authentication failed|api key.*invalid/i;
        const errorInOutput = resultText.split('\n').find(l => KNOWN_ERRORS.test(l))?.trim();

        if (errorInOutput) {
          reject(new Error(errorInOutput.slice(0, 200)));
        } else if (code === 0 || code === null) {
          resolve({
            response: resultText,
            artifacts,
            sessionId: this.sessionId,
            inputTokens,
            outputTokens,
          });
        } else if (abortSignal?.aborted || code === 143 || code === 130) {
          // 143=SIGTERM, 130=SIGINT — normal shutdown, not an error
          reject(new Error('Aborted'));
        } else {
          reject(new Error(`CLI exited with code ${code}`));
        }
      });
    });
  }

  abort(): void {
    this.child?.kill('SIGTERM');
  }

  /**
   * Build the prompt for a step, injecting history context.
   * If resuming (sessionId exists), the CLI already has conversation context.
   * Otherwise, prepend a summary of prior steps.
   */
  /** Execute step using node-pty for agents that require a TTY (e.g., codex) */
  private executePTY(
    spawnOpts: { cmd: string; args: string[] },
    projectPath: string,
    env: Record<string, string | undefined>,
    onLog: StepExecutionParams['onLog'],
    abortSignal: AbortSignal | undefined,
    resolve: (r: StepExecutionResult) => void,
    reject: (e: Error) => void,
  ): void {
    try {
      const pty = esmRequire('node-pty');
      const stripAnsi = (s: string) => s
        .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
        .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
        .replace(/\x1b[()][0-9A-B]/g, '')
        .replace(/\x1b[=>]/g, '')
        .replace(/\r/g, '')
        .replace(/\x07/g, '');

      const ptyProcess = pty.spawn(spawnOpts.cmd, spawnOpts.args, {
        name: 'xterm-256color',
        cols: 120, rows: 40,
        cwd: projectPath,
        env,
      });

      let resultText = '';
      let ptyBytes = 0;
      let idleTimer: any = null;
      const PTY_IDLE_MS = 15000;

      const onAbort = () => { try { ptyProcess.kill(); } catch {} };
      abortSignal?.addEventListener('abort', onAbort, { once: true });

      // Noise filter: skip spinner fragments, partial redraws, and short garbage
      const NOISE_PATTERNS = /^(W|Wo|Wor|Work|Worki|Workin|Working|orking|rking|king|ing|ng|g|•|[0-9]+s?|[0-9]+m [0-9]+s|›.*|─+|╭.*|│.*|╰.*|\[K|\[0m|;[0-9;m]+|\s*)$/;
      const isNoise = (line: string) => {
        const t = line.trim();
        return !t || t.length < 3 || NOISE_PATTERNS.test(t) || /^[•\s]*$/.test(t);
      };

      let lineBuf = '';

      ptyProcess.onData((data: string) => {
        const clean = stripAnsi(data);
        ptyBytes += clean.length;
        resultText += clean;
        if (resultText.length > 50000) resultText = resultText.slice(-25000);

        // Buffer lines and only emit meaningful content
        lineBuf += clean;
        const lines = lineBuf.split('\n');
        lineBuf = lines.pop() || '';

        for (const line of lines) {
          if (!isNoise(line)) {
            onLog?.({ type: 'assistant', subtype: 'text', content: line.trim(), timestamp: new Date().toISOString() });
          }
        }

        // Detect fatal errors in real-time — kill immediately instead of waiting for idle
        if (/usage limit|rate limit|hit your.*limit|upgrade to (plus|pro)/i.test(clean)) {
          console.log(`[cli-backend] Detected usage limit — killing PTY immediately`);
          onLog?.({ type: 'system', subtype: 'error', content: 'Agent hit usage limit', timestamp: new Date().toISOString() });
          if (idleTimer) clearTimeout(idleTimer);
          try { ptyProcess.kill(); } catch {}
          return;
        }

        // Idle timer: kill after 15s of silence (interactive agents don't exit on their own)
        if (idleTimer) clearTimeout(idleTimer);
        if (ptyBytes > 500) {
          idleTimer = setTimeout(() => { try { ptyProcess.kill(); } catch {} }, PTY_IDLE_MS);
        }
      });

      ptyProcess.onExit(({ exitCode }: { exitCode: number }) => {
        if (idleTimer) clearTimeout(idleTimer);
        abortSignal?.removeEventListener('abort', onAbort);

        // Flush remaining buffer
        if (lineBuf.trim() && !isNoise(lineBuf)) {
          onLog?.({ type: 'assistant', subtype: 'text', content: lineBuf.trim(), timestamp: new Date().toISOString() });
        }

        // Detect error patterns in output (rate limit, auth failure, etc.)
        const ERROR_PATTERNS = [
          /usage limit/i,
          /rate limit/i,
          /upgrade to/i,
          /authentication failed/i,
          /api key/i,
          /permission denied/i,
          /error:.*fatal/i,
        ];
        const errorMatch = ERROR_PATTERNS.find(p => p.test(resultText));
        if (errorMatch) {
          // Extract the error line
          const errorLine = resultText.split('\n').find(l => errorMatch.test(l))?.trim() || 'Agent execution failed';
          reject(new Error(errorLine.slice(0, 200)));
          return;
        }

        const meaningful = resultText.split('\n').filter(l => !isNoise(l)).join('\n');
        resolve({
          response: meaningful.slice(-2000) || resultText.slice(-500),
          artifacts: [],
          inputTokens: 0,
          outputTokens: 0,
        });
      });
    } catch (err: any) {
      reject(new Error(`PTY spawn failed: ${err.message}`));
    }
  }

  private buildStepPrompt(step: AgentStep, history: TaskLogEntry[], upstreamContext?: string): string {
    let prompt = step.prompt;

    // If resuming with session, Claude already has conversation context — skip history injection
    if (!this.sessionId && history.length > 0) {
      // Only inject last 3 step results (not full history) to save tokens
      const MAX_HISTORY_STEPS = 3;
      const stepResults = history
        .filter(m => m.type === 'result' && m.subtype === 'step_complete')
        .slice(-MAX_HISTORY_STEPS);

      if (stepResults.length > 0) {
        const contextSummary = stepResults
          .map((m, i) => `Step ${i + 1}: ${m.content.slice(0, 500)}${m.content.length > 500 ? '...' : ''}`)
          .join('\n\n');
        prompt = `## Context from previous steps (last ${stepResults.length}):\n${contextSummary}\n\n---\n\n## Current task:\n${prompt}`;
      }
    }

    if (upstreamContext) {
      prompt = `## Upstream agent output:\n${upstreamContext}\n\n---\n\n${prompt}`;
    }

    // Note: [SEND:] bus markers disabled. Agent communication now uses forge skills (/forge-send, /forge-inbox).
    // Phase 2 will add ticket system + causedBy protocol for structured agent-to-agent feedback.

    return prompt;
  }
}
