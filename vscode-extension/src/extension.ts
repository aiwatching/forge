import * as vscode from 'vscode';
import { Auth } from './auth/auth';
import { ForgeClient } from './api/client';
import { WorkspacesProvider } from './views/workspaces';
import { TerminalsProvider } from './views/terminals';
import { TasksProvider } from './views/tasks';
import { StatusBar } from './statusbar';
import { loginCommand, logoutCommand } from './commands/auth';
import { openTerminalCommand, attachTerminalCommand, openSessionCommand, sendSelectionCommand } from './commands/terminal';
import { startServerCommand, stopServerCommand, openWebUICommand } from './commands/server';
import { newTaskCommand } from './commands/task';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const auth = new Auth(context.secrets);
  const client = new ForgeClient(auth);

  // Tree views
  const wsProvider   = new WorkspacesProvider(client);
  const termProvider = new TerminalsProvider(client);
  const taskProvider = new TasksProvider(client);
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('forge.workspaces', wsProvider),
    vscode.window.registerTreeDataProvider('forge.terminals', termProvider),
    vscode.window.registerTreeDataProvider('forge.tasks', taskProvider),
  );

  const refreshAll = () => {
    wsProvider.refresh();
    termProvider.refresh();
    taskProvider.refresh();
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
    if (await auth.getToken()) {
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
}

export function deactivate(): void {
  // disposables are released by VSCode automatically
}
