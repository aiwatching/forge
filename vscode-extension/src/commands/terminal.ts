import * as vscode from 'vscode';
import { ForgeClient } from '../api/client';
import { ForgePty } from '../terminal/pseudoterm';

export async function openTerminalCommand(client: ForgeClient): Promise<void> {
  const reachable = await client.ping();
  if (!reachable) {
    vscode.window.showErrorMessage('Forge: server unreachable. Run "Forge: Start Server" or check settings.');
    return;
  }

  // Pick: attach to existing session, or create a new one for a project
  const termsRes = await client.listTerminals();
  const terms: any[] = termsRes.ok && termsRes.data
    ? (Array.isArray(termsRes.data) ? termsRes.data : (termsRes.data.sessions || []))
    : [];
  const projRes = await client.listProjects();
  const projects: any[] = projRes.ok && Array.isArray(projRes.data) ? projRes.data : [];

  interface OpenPickItem extends vscode.QuickPickItem {
    action: 'attach' | 'create';
    sessionName?: string;
    projectPath?: string;
  }
  const items: OpenPickItem[] = [];

  for (const t of terms) {
    const name = t.name || t.sessionName;
    if (!name) continue;
    items.push({
      label: `$(terminal) ${name}`,
      description: t.projectPath ? `attach · ${t.projectPath}` : 'attach',
      action: 'attach',
      sessionName: name,
    });
  }
  for (const p of projects) {
    items.push({
      label: `$(plus) New terminal in ${p.name}`,
      description: p.path,
      action: 'create',
      projectPath: p.path,
    });
  }

  if (items.length === 0) {
    vscode.window.showInformationMessage('Forge: no projects configured. Add one in Settings → Project Roots.');
    return;
  }

  const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Attach or create a Forge terminal' });
  if (!picked) return;

  if (picked.action === 'attach' && picked.sessionName) {
    attachTerminalImpl(client, picked.sessionName);
  } else if (picked.action === 'create' && picked.projectPath) {
    return openSessionCommand(client, { projectPath: picked.projectPath, projectName: picked.projectPath.split('/').pop() });
  }
}

export async function attachTerminalCommand(client: ForgeClient, arg?: { sessionName?: string }): Promise<void> {
  if (!arg?.sessionName) {
    return openTerminalCommand(client);
  }
  attachTerminalImpl(client, arg.sessionName);
}

function attachTerminalImpl(client: ForgeClient, sessionName: string): void {
  const pty = new ForgePty({ url: client.terminalUrl, attach: sessionName });
  const term = vscode.window.createTerminal({ name: `forge: ${sessionName}`, pty });
  term.show();
}

/** Open a forge session picker for a project — same flow as web UI's terminal picker:
 *  Agent → Current Session / New Session / Other Session. Then launches the chosen
 *  agent in a tmux. */
export async function openSessionCommand(client: ForgeClient, arg?: { projectPath?: string; projectName?: string; agentId?: string }): Promise<void> {
  let projectPath = arg?.projectPath;
  let projectName = arg?.projectName;
  let agentId = arg?.agentId;

  if (!projectPath) {
    const projRes = await client.listProjects();
    const projects: any[] = projRes.ok && Array.isArray(projRes.data) ? projRes.data : [];
    if (projects.length === 0) {
      vscode.window.showInformationMessage('Forge: no projects configured. Add one in Settings → Project Roots.');
      return;
    }
    const picked = await vscode.window.showQuickPick(
      projects.map(p => ({ label: p.name, description: p.path, project: p })),
      { placeHolder: 'Select project' },
    );
    if (!picked) return;
    projectPath = picked.project.path;
    projectName = picked.project.name;
  }
  if (!projectName && projectPath) projectName = projectPath.split('/').pop();

  // Pick agent if not provided — only ask when there are 2+ enabled agents.
  if (!agentId) {
    const agentsRes = await client.listAgents();
    const allAgents: any[] = agentsRes.ok && Array.isArray(agentsRes.data?.agents) ? agentsRes.data!.agents : [];
    const defaultAgent = agentsRes.ok ? agentsRes.data?.defaultAgent : undefined;
    const enabled = allAgents.filter(a => a.enabled !== false);
    if (enabled.length === 0) {
      // Fall back to claude if nothing detected — better than refusing.
      agentId = 'claude';
    } else if (enabled.length === 1) {
      agentId = enabled[0].id;
    } else {
      // Place default first, then the rest.
      const sorted = [
        ...enabled.filter(a => a.id === defaultAgent),
        ...enabled.filter(a => a.id !== defaultAgent),
      ];
      const picks = sorted.map(a => ({
        label: `${iconForAgent(a.cliType || a.type)} ${a.name || a.id}`,
        description: a.id === defaultAgent ? 'default' : (a.cliType || a.type || ''),
        detail: a.path && a.path !== a.id ? a.path : undefined,
        agent: a,
      }));
      const sel = await vscode.window.showQuickPick(picks, { placeHolder: 'Select agent' });
      if (!sel) return;
      agentId = sel.agent.id;
    }
  }

  // Resolve agent launch info — gives us cliCmd, supportsSession, model, env.
  const resolveRes = await client.resolveAgent(agentId!);
  const cliCmd          = resolveRes.ok ? (resolveRes.data?.cliCmd || 'claude')          : 'claude';
  const supportsSession = resolveRes.ok ? (resolveRes.data?.supportsSession ?? true)     : true;
  const cliType         = resolveRes.ok ? (resolveRes.data?.cliType || 'claude-code')    : 'claude-code';
  const model           = resolveRes.ok ? resolveRes.data?.model                          : undefined;
  const env             = resolveRes.ok ? (resolveRes.data?.env || {})                    : {};

  // Resolve the project's bound fixedSession (if any). Only meaningful when
  // the agent supports --resume.
  let fixedSessionId: string | null = null;
  if (supportsSession) {
    try {
      const r = await client.getProjectSession(projectPath!);
      if (r.ok && r.data?.fixedSessionId) fixedSessionId = r.data.fixedSessionId;
    } catch {}
  }

  // For agents that don't support --resume (codex, aider, custom), skip the
  // session picker entirely — there's nothing to resume.
  let resumeId: string | null = null;
  if (supportsSession) {
    interface SessionPick extends vscode.QuickPickItem {
      mode: 'current' | 'new' | 'other';
    }
    const picks: SessionPick[] = [];
    if (fixedSessionId) {
      picks.push({
        label: `$(circle-large-filled) Current Session`,
        description: fixedSessionId.slice(0, 16) + '…',
        detail: 'Resume the bound session for this project',
        mode: 'current',
      });
    }
    picks.push({
      label: `$(add) New Session`,
      detail: `Start a fresh ${cliCmd} session`,
      mode: 'new',
    });
    if (cliType === 'claude-code') {
      // Only claude-code has on-disk session files we can list.
      picks.push({
        label: `$(history) Other Session…`,
        detail: 'Pick from recent claude sessions for this project',
        mode: 'other',
      });
    }

    const choice = await vscode.window.showQuickPick(picks, {
      placeHolder: `Open ${projectName} (${cliCmd}) — choose a session`,
    });
    if (!choice) return;

    if (choice.mode === 'current' && fixedSessionId) {
      resumeId = fixedSessionId;
    } else if (choice.mode === 'other') {
      if (!projectName) return;
      const sessRes = await client.listClaudeSessions(projectName);
      const sessions: any[] = sessRes.ok && Array.isArray(sessRes.data) ? sessRes.data : [];
      if (sessions.length === 0) {
        vscode.window.showInformationMessage(`Forge: no past sessions found for ${projectName}.`);
        return;
      }
      const otherPicks = sessions.map((s: any, i: number) => {
        const sid = s.sessionId || s.id || '';
        const date = s.modified ? new Date(s.modified).toLocaleString() : '';
        const isCurrent = sid === fixedSessionId;
        const isLatest = i === 0;
        const tag = isCurrent ? ' (current)' : isLatest ? ' (latest)' : '';
        return {
          label: `$(comment-discussion) ${sid.slice(0, 16)}…${tag}`,
          description: date,
          sessionId: sid,
        };
      });
      const sel = await vscode.window.showQuickPick(otherPicks, {
        placeHolder: `Recent sessions in ${projectName}`,
      });
      if (!sel) return;
      resumeId = sel.sessionId;
    }
    // mode === 'new' → resumeId stays null
  }

  // Build launch command. Only claude-code uses --dangerously-skip-permissions
  // by default; other CLIs have their own (e.g. codex --full-auto) that we
  // don't auto-add — user can configure their own settings.
  const resumeFlag = resumeId ? ` --resume ${resumeId}` : '';
  const modelFlag  = model ? ` --model ${model}` : '';
  const skipFlag   = cliType === 'claude-code' ? ' --dangerously-skip-permissions' : '';
  const envExports = Object.entries(env)
    .filter(([k]) => k !== 'CLAUDE_MODEL') // model passed via --model
    .map(([k, v]) => `export ${k}="${v}"`)
    .join(' && ');
  const envPrefix  = envExports ? envExports + ' && ' : '';
  const launchCommand = `${envPrefix}cd "${projectPath}" && ${cliCmd}${resumeFlag}${modelFlag}${skipFlag}`;

  const pty = new ForgePty({ url: client.terminalUrl, cwd: projectPath, launchCommand });
  const label = projectName || 'forge';
  const agentTag = cliCmd !== 'claude' ? ` (${cliCmd})` : '';
  const term = vscode.window.createTerminal({ name: `forge: ${label}${agentTag}`, pty });
  term.show();
}

function iconForAgent(cliType: string | undefined): string {
  switch (cliType) {
    case 'claude-code': return '$(comment-discussion)';
    case 'codex':       return '$(zap)';
    case 'aider':       return '$(edit)';
    default:            return '$(robot)';
  }
}

/** Backwards-compatible alias kept for the tree view "New Terminal" entries. */
export const newTerminalCommand = openSessionCommand;

export async function sendSelectionCommand(client: ForgeClient): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.selection.isEmpty) {
    vscode.window.showWarningMessage('Forge: no text selected.');
    return;
  }
  const text = editor.document.getText(editor.selection);

  const termsRes = await client.listTerminals();
  const terms: any[] = termsRes.ok && termsRes.data
    ? (Array.isArray(termsRes.data) ? termsRes.data : (termsRes.data.sessions || []))
    : [];
  if (terms.length === 0) {
    vscode.window.showInformationMessage('Forge: no active terminals.');
    return;
  }
  const items: (vscode.QuickPickItem & { name: string })[] = terms
    .map((t: any) => ({
      label: `$(terminal) ${t.name || t.sessionName}`,
      description: t.projectPath || '',
      name: t.name || t.sessionName,
    }))
    .filter(i => i.name);
  const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Send selection to which terminal?' });
  if (!picked) return;

  const r = await client.request(`/api/terminal/inject`, {
    method: 'POST',
    body: JSON.stringify({ sessionName: picked.name, text }),
  });
  if (r.ok) {
    vscode.window.showInformationMessage(`Forge: sent ${text.length} chars to ${picked.name}`);
  } else {
    vscode.window.showErrorMessage(`Forge inject failed: ${r.error}`);
  }
}
