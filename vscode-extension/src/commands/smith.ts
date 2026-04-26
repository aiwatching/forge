import * as vscode from 'vscode';
import { ForgeClient } from '../api/client';
import { ForgePty } from '../terminal/pseudoterm';

export interface SmithArg {
  workspaceId: string;
  agentId: string;
  label?: string;
}

/** Cache of VSCode terminals we created, keyed by tmux session name. Reusing
 *  prevents N duplicate panes when the user clicks the same smith repeatedly.
 *  Entries are removed on terminal close (see registerSmithTerminalCleanup). */
const openedTerminals = new Map<string, vscode.Terminal>();

/** Wire VSCode's terminal-close event so we drop stale cache entries. Called
 *  once from extension activation. */
export function registerSmithTerminalCleanup(context: vscode.ExtensionContext): void {
  context.subscriptions.push(vscode.window.onDidCloseTerminal((t) => {
    for (const [key, term] of openedTerminals) {
      if (term === t) {
        openedTerminals.delete(key);
        break;
      }
    }
  }));
}

/** Open a smith's tmux session in VSCode terminal panel. If we already opened
 *  it earlier, just .show() the existing pane instead of creating a new one. */
export async function smithOpenTerminalCommand(client: ForgeClient, arg?: SmithArg): Promise<void> {
  if (!arg) return;
  const r = await client.wsAction(arg.workspaceId, 'open_terminal', { agentId: arg.agentId });
  if (!r.ok) {
    vscode.window.showErrorMessage(`Forge: open terminal failed — ${r.error}`);
    return;
  }
  const tmuxSession: string | undefined = r.data?.tmuxSession;
  if (!tmuxSession) {
    vscode.window.showErrorMessage(`Forge: smith ${arg.label || arg.agentId} has no tmux session yet — try Start Daemon first.`);
    return;
  }

  const existing = openedTerminals.get(tmuxSession);
  if (existing) {
    existing.show();
    return;
  }

  const pty = new ForgePty({ url: client.terminalUrl, attach: tmuxSession });
  const term = vscode.window.createTerminal({ name: `forge: ${arg.label || arg.agentId}`, pty });
  openedTerminals.set(tmuxSession, term);
  term.show();
}

// ── Lifecycle actions ──────────────────────────────────

export async function smithPauseCommand(client: ForgeClient, arg?: SmithArg) {
  if (!arg) return;
  const r = await client.wsAction(arg.workspaceId, 'pause', { agentId: arg.agentId });
  reportResult('Pause', r);
}

export async function smithResumeCommand(client: ForgeClient, arg?: SmithArg) {
  if (!arg) return;
  const r = await client.wsAction(arg.workspaceId, 'resume', { agentId: arg.agentId });
  reportResult('Resume', r);
}

export async function smithMarkDoneCommand(client: ForgeClient, arg?: SmithArg) {
  if (!arg) return;
  const r = await client.wsAction(arg.workspaceId, 'mark_done', { agentId: arg.agentId, notify: true });
  reportResult('Mark Done', r);
}

export async function smithMarkFailedCommand(client: ForgeClient, arg?: SmithArg) {
  if (!arg) return;
  const r = await client.wsAction(arg.workspaceId, 'mark_failed', { agentId: arg.agentId, notify: true });
  reportResult('Mark Failed', r);
}

export async function smithMarkIdleCommand(client: ForgeClient, arg?: SmithArg) {
  if (!arg) return;
  const r = await client.wsAction(arg.workspaceId, 'mark_done', { agentId: arg.agentId, notify: false });
  reportResult('Mark Idle', r);
}

export async function smithRetryCommand(client: ForgeClient, arg?: SmithArg) {
  if (!arg) return;
  const r = await client.wsAction(arg.workspaceId, 'retry', { agentId: arg.agentId });
  reportResult('Retry', r);
}

export async function smithSendMessageCommand(client: ForgeClient, arg?: SmithArg) {
  if (!arg) return;
  const content = await vscode.window.showInputBox({
    prompt: `Send message to ${arg.label || arg.agentId}`,
    placeHolder: 'Type your instruction…',
    ignoreFocusOut: true,
  });
  if (!content) return;
  const r = await client.wsAction(arg.workspaceId, 'message', { agentId: arg.agentId, content });
  reportResult('Send Message', r);
}

function reportResult(action: string, r: { ok: boolean; error?: string }) {
  if (r.ok) {
    vscode.commands.executeCommand('forge.refresh');
  } else {
    vscode.window.showErrorMessage(`Forge: ${action} failed — ${r.error}`);
  }
}
