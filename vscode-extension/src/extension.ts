import * as vscode from 'vscode';
import { Auth } from './auth/auth';
import { ConnectionManager } from './connection/manager';
import { ForgeClient } from './api/client';
import { switchConnectionCommand, addConnectionCommand, removeConnectionCommand, editConnectionsCommand } from './commands/connection';
import { WorkspacesProvider } from './views/workspaces';
import { TerminalsProvider } from './views/terminals';
import { PipelinesProvider } from './views/pipelines';
import { DocsProvider } from './views/docs';
import { StatusBar } from './statusbar';
import { loginCommand, logoutCommand } from './commands/auth';
import { openTerminalCommand, attachTerminalCommand, openSessionCommand, sendSelectionCommand } from './commands/terminal';
import { startServerCommand, stopServerCommand, openWebUICommand } from './commands/server';
import { newTaskCommand } from './commands/task';
import {
  openWorkspaceForFolderCommand, openWorkspaceCommand,
  startDaemonCommand, stopDaemonCommand, restartDaemonCommand,
} from './commands/workspace';
import {
  smithOpenTerminalCommand, smithPauseCommand, smithResumeCommand,
  smithMarkDoneCommand, smithMarkFailedCommand, smithMarkIdleCommand,
  smithRetryCommand, smithSendMessageCommand, registerSmithTerminalCleanup,
} from './commands/smith';
import { openDocCommand, openDocsTerminalCommand } from './commands/docs';
import { ForgeDocsFs } from './docs/fs-provider';
import { ForgeResultProvider, SCHEME as RESULT_SCHEME, buildResultUri } from './docs/result-provider';
import { addPipelineCommand, triggerPipelineCommand, togglePipelineCommand, removePipelineCommand } from './commands/pipeline';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const auth = new Auth(context.secrets);
  const conn = new ConnectionManager();
  conn.watchConfig(context);
  const client = new ForgeClient(auth, conn);

  // One-time migration of legacy single-token storage to per-connection.
  await auth.migrateLegacy(conn.active().name);

  // Smith terminal cache — reuse VSCode terminal pane on repeated click
  registerSmithTerminalCleanup(context);

  // Tree views
  const wsProvider       = new WorkspacesProvider(client);
  const termProvider     = new TerminalsProvider(client);
  const pipelineProvider = new PipelinesProvider(client);
  const docsProvider     = new DocsProvider(client);
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('forge.workspaces', wsProvider),
    vscode.window.registerTreeDataProvider('forge.terminals',  termProvider),
    vscode.window.registerTreeDataProvider('forge.pipelines',  pipelineProvider),
    vscode.window.registerTreeDataProvider('forge.docs',       docsProvider),
  );

  const refreshAll = () => {
    wsProvider.refresh();
    termProvider.refresh();
    pipelineProvider.refresh();
    docsProvider.refresh();
  };

  // Status bar
  const status = new StatusBar(client, auth);
  context.subscriptions.push(status);
  const interval = vscode.workspace.getConfiguration('forge').get<number>('refreshInterval', 5);
  status.startPolling(interval);

  // Auto-refresh tree views on the same interval
  const treeTimer = setInterval(refreshAll, Math.max(interval, 2) * 1000);
  context.subscriptions.push({ dispose: () => clearInterval(treeTimer) });

  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand('forge.login',         () => loginCommand(client)),
    vscode.commands.registerCommand('forge.logout',        () => logoutCommand(client)),
    vscode.commands.registerCommand('forge.startServer',   () => startServerCommand(client)),
    vscode.commands.registerCommand('forge.stopServer',    () => stopServerCommand()),
    vscode.commands.registerCommand('forge.openWebUI',     () => openWebUICommand(client)),
    vscode.commands.registerCommand('forge.openTerminal',  () => openTerminalCommand(client)),
    vscode.commands.registerCommand('forge.attachTerminal',(arg) => attachTerminalCommand(client, arg)),
    vscode.commands.registerCommand('forge.openSession',   (arg) => openSessionCommand(client, arg)),
    vscode.commands.registerCommand('forge.sendSelection', () => sendSelectionCommand(client)),
    vscode.commands.registerCommand('forge.newTask',       () => newTaskCommand(client)),
    vscode.commands.registerCommand('forge.refresh',       () => { refreshAll(); status.update(); }),

    // Connection management
    vscode.commands.registerCommand('forge.switchConnection', () => switchConnectionCommand(conn)),
    vscode.commands.registerCommand('forge.addConnection',    () => addConnectionCommand(conn)),
    vscode.commands.registerCommand('forge.removeConnection', () => removeConnectionCommand(conn)),
    vscode.commands.registerCommand('forge.editConnections',  () => editConnectionsCommand()),

    // Workspace bootstrap + daemon control
    vscode.commands.registerCommand('forge.openWorkspaceForFolder', () => openWorkspaceForFolderCommand(client)),
    vscode.commands.registerCommand('forge.openWorkspace',          () => openWorkspaceCommand(client)),
    vscode.commands.registerCommand('forge.startDaemon',  (arg) => startDaemonCommand(client, arg?.meta || arg)),
    vscode.commands.registerCommand('forge.stopDaemon',   (arg) => stopDaemonCommand(client, arg?.meta || arg)),
    vscode.commands.registerCommand('forge.restartDaemon',(arg) => restartDaemonCommand(client, arg?.meta || arg)),

    // Smith actions (right-click menu + click)
    vscode.commands.registerCommand('forge.smithOpenTerminal', (arg) => smithOpenTerminalCommand(client, arg?.meta || arg)),
    vscode.commands.registerCommand('forge.smithPause',        (arg) => smithPauseCommand(client, arg?.meta || arg)),
    vscode.commands.registerCommand('forge.smithResume',       (arg) => smithResumeCommand(client, arg?.meta || arg)),
    vscode.commands.registerCommand('forge.smithMarkDone',     (arg) => smithMarkDoneCommand(client, arg?.meta || arg)),
    vscode.commands.registerCommand('forge.smithMarkFailed',   (arg) => smithMarkFailedCommand(client, arg?.meta || arg)),
    vscode.commands.registerCommand('forge.smithMarkIdle',     (arg) => smithMarkIdleCommand(client, arg?.meta || arg)),
    vscode.commands.registerCommand('forge.smithRetry',        (arg) => smithRetryCommand(client, arg?.meta || arg)),
    vscode.commands.registerCommand('forge.smithSendMessage',  (arg) => smithSendMessageCommand(client, arg?.meta || arg)),

    // Docs
    vscode.commands.registerCommand('forge.openDoc',           (arg) => openDocCommand(client, arg?.meta || arg)),
    vscode.commands.registerCommand('forge.openDocsTerminal',  (arg) => openDocsTerminalCommand(client, arg?.meta || arg)),

    // Pipelines (project-bound)
    vscode.commands.registerCommand('forge.addPipeline',       (arg) => addPipelineCommand(client, arg?.meta || arg)),
    vscode.commands.registerCommand('forge.triggerPipeline',   (arg) => triggerPipelineCommand(client, arg?.meta || arg)),
    vscode.commands.registerCommand('forge.togglePipeline',    (arg) => togglePipelineCommand(client, arg?.meta || arg)),
    vscode.commands.registerCommand('forge.removePipeline',    (arg) => removePipelineCommand(client, arg?.meta || arg)),
    vscode.commands.registerCommand('forge.showPipelineNodeError', async (arg) => {
      if (!arg?.error) return;
      const uri = buildResultUri(`error/${arg.nodeName}`);
      resultProvider.setContent(uri, `# Pipeline node \`${arg.nodeName}\` failed\n\n\`\`\`\n${arg.error}\n\`\`\`\n`);
      await vscode.commands.executeCommand('vscode.open', uri);
    }),

    // Pipeline node detail view. Combines whatever we know — node status,
    // duration, error, outputs — plus the underlying forge task (if its ID is
    // resolvable). A pipeline node's taskId may not always map to /api/tasks
    // (different ID spaces depending on workflow type), so a 404 is silently
    // skipped rather than rendered as an error.
    vscode.commands.registerCommand('forge.showPipelineNodeResult', async (arg) => {
      if (!arg) return;
      const lines: string[] = [];
      lines.push(`# Pipeline node: \`${arg.nodeName}\``);
      lines.push('');
      lines.push(`**Status:** ${arg.status || 'unknown'}`);
      if (arg.taskId) lines.push(`**Task ID:** \`${arg.taskId}\``);
      if (arg.startedAt) {
        const start = new Date(arg.startedAt).toLocaleString();
        const end = arg.completedAt ? new Date(arg.completedAt).toLocaleString() : '(running)';
        const dur = arg.completedAt
          ? `${Math.round((new Date(arg.completedAt).getTime() - new Date(arg.startedAt).getTime()) / 1000)}s`
          : '';
        lines.push(`**Started:** ${start}`);
        lines.push(`**Completed:** ${end}${dur ? `  (${dur})` : ''}`);
      }
      lines.push('');

      // Pull the underlying task if we can — silently skip on 404.
      let task: any = null;
      if (arg.taskId) {
        const r = await client.getTask(arg.taskId);
        if (r.ok && r.data) task = r.data;
      }

      if (task) {
        if (task.prompt) {
          lines.push('## Prompt');
          lines.push('```');
          lines.push(task.prompt);
          lines.push('```');
          lines.push('');
        }
        if (task.resultSummary) {
          lines.push('## Result');
          lines.push(task.resultSummary);
          lines.push('');
        }
        if (task.gitDiff) {
          lines.push('## Git Diff');
          lines.push('```diff');
          lines.push(task.gitDiff);
          lines.push('```');
          lines.push('');
        }
        if (Array.isArray(task.log) && task.log.length > 0) {
          lines.push('## Log (last 20 entries)');
          for (const e of task.log.slice(-20)) {
            const time = e.timestamp ? new Date(e.timestamp).toLocaleTimeString() : '';
            const tag = e.subtype || e.type || 'log';
            const content = (e.content || '').toString();
            lines.push(`- \`[${time}] [${tag}]\` ${content.slice(0, 500).replace(/\n/g, ' ')}`);
          }
          lines.push('');
        }
        if (task.costUSD) {
          lines.push(`**Cost:** $${task.costUSD.toFixed?.(4) ?? task.costUSD}`);
          lines.push('');
        }
      }

      if (arg.error) {
        lines.push('## Error');
        lines.push('```');
        lines.push(String(arg.error));
        lines.push('```');
        lines.push('');
      }

      if (arg.outputs && Object.keys(arg.outputs).length > 0) {
        lines.push('## Outputs');
        for (const [k, v] of Object.entries(arg.outputs)) {
          lines.push(`### ${k}`);
          lines.push('```');
          lines.push(typeof v === 'string' ? v : JSON.stringify(v, null, 2));
          lines.push('```');
          lines.push('');
        }
      }

      // If we got nothing useful at all (pending node, or node didn't track a
      // task), say so explicitly instead of leaving a near-empty doc.
      if (!task && !arg.error && !(arg.outputs && Object.keys(arg.outputs).length > 0)) {
        lines.push('---');
        lines.push('');
        if (arg.status === 'pending') {
          lines.push('_Node has not run yet — re-open after the pipeline reaches it._');
        } else if (arg.taskId) {
          lines.push(`_The associated task \`${arg.taskId}\` is no longer in the forge task store. The node may have run via the workspace daemon (which uses a separate ID space) or the task was cleaned up._`);
        } else {
          lines.push('_This node did not produce any task output, error, or named outputs._');
        }
      }

      // Use a stable URI per (run, node) so re-clicking the same node reuses
      // the tab; clicking a different node opens in preview mode and replaces
      // the previous unpinned preview tab.
      const key = `node/${arg.runId || 'std'}/${arg.nodeName}`;
      const uri = buildResultUri(key);
      resultProvider.setContent(uri, lines.join('\n'));
      await vscode.commands.executeCommand('vscode.open', uri);
    }),

    // Quick-open in forge web UI. Forge supports `?view=<mode>` to deep-link
    // into a section — the calling tree item passes a `view` hint via meta.
    vscode.commands.registerCommand('forge.openItemInWebUI', (arg) => {
      const meta = arg?.meta || arg || {};
      const view = meta.view || meta.webUiView;
      const base = client.baseUrlPublic;
      const url = view ? `${base}/?view=${encodeURIComponent(view)}` : base;
      vscode.env.openExternal(vscode.Uri.parse(url));
    }),
  );

  // Always register the forge-docs:// FS provider — used when transport is
  // 'http' (auto-selected for remote forges, or forced via settings).
  context.subscriptions.push(
    vscode.workspace.registerFileSystemProvider('forge-docs', new ForgeDocsFs(client), { isCaseSensitive: true }),
  );

  // Read-only virtual provider for ephemeral detail views (pipeline node
  // results, error dumps). Same URI = same tab, no save prompt on close.
  const resultProvider = new ForgeResultProvider();
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(RESULT_SCHEME, resultProvider),
  );

  // Auto-start option
  if (vscode.workspace.getConfiguration('forge').get<boolean>('autoStart', false)) {
    if (!(await client.ping())) {
      void startServerCommand(client);
    }
  }

  // First-run UX: if forge is reachable but we have no token, prompt for login
  // immediately. Otherwise users have to dig through the command palette.
  void (async () => {
    // Wait briefly so a freshly auto-started server has a chance to come up.
    await new Promise(r => setTimeout(r, 800));
    if (!(await client.ping())) return;          // server offline → status bar already says so
    if (await auth.getToken(client.activeName)) {
      // Token exists, but verify it still works (server may have been restarted)
      const probe = await client.listProjects();
      if (probe.status === 401 || probe.status === 403) {
        await client.logout();
      } else {
        return;
      }
    }
    // No token (or stale token cleared) → ask now
    void loginCommand(client);
  })();

  // Notifications: poll unread bell events
  if (vscode.workspace.getConfiguration('forge').get<boolean>('notifications.enabled', true)) {
    const seen = new Set<string>();
    const notifyTimer = setInterval(async () => {
      const r = await client.getNotifications();
      const list: any[] = r.ok && r.data?.notifications ? r.data.notifications : [];
      for (const n of list) {
        if (n.read || seen.has(n.id)) continue;
        seen.add(n.id);
        vscode.window.showInformationMessage(`Forge: ${n.title || n.message || 'notification'}`);
      }
    }, 30_000);
    context.subscriptions.push({ dispose: () => clearInterval(notifyTimer) });
  }

  // Re-read settings when the user changes them
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
    if (e.affectsConfiguration('forge.refreshInterval')) {
      const i = vscode.workspace.getConfiguration('forge').get<number>('refreshInterval', 5);
      status.startPolling(i);
    }
  }));

  // When the active connection switches (or its URLs change), reset everything
  // that depends on it: trees, status, and any cached state.
  context.subscriptions.push(conn.onDidChange(() => {
    refreshAll();
    void status.update();
  }));
}

export function deactivate(): void {
  // disposables are released by VSCode automatically
}
