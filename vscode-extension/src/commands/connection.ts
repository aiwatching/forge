import * as vscode from 'vscode';
import { ConnectionManager, ForgeConnection } from '../connection/manager';

const ADD_NEW = '$(add) Add New Connection…';

export async function switchConnectionCommand(mgr: ConnectionManager): Promise<void> {
  const list = mgr.list();
  const active = mgr.active();
  const items: vscode.QuickPickItem[] = list.map(c => ({
    label: c.name === active.name ? `$(circle-large-filled) ${c.name}` : `$(circle-large-outline) ${c.name}`,
    description: c.serverUrl,
  }));
  items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
  items.push({ label: ADD_NEW });

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: `Switch forge connection (current: ${active.name})`,
  });
  if (!picked) return;

  if (picked.label === ADD_NEW) {
    return addConnectionCommand(mgr, true);
  }
  // Strip the icon prefix to get the actual name.
  const name = picked.label.replace(/^\$\([^)]+\)\s+/, '');
  if (name === active.name) return;
  await mgr.setActive(name);
  vscode.window.showInformationMessage(`Forge: switched to "${name}"`);
}

export async function addConnectionCommand(mgr: ConnectionManager, switchAfter = false): Promise<void> {
  const name = await vscode.window.showInputBox({
    prompt: 'Connection name',
    placeHolder: 'e.g. Office, Cloud, Staging',
    ignoreFocusOut: true,
    validateInput: v => {
      if (!v.trim()) return 'Name required';
      if (mgr.list().some(c => c.name === v.trim())) return 'Name already used';
      return null;
    },
  });
  if (!name) return;

  const serverUrl = await vscode.window.showInputBox({
    prompt: 'Forge HTTP URL',
    value: 'http://',
    placeHolder: 'http://1.2.3.4:8403  or  https://forge.example.com',
    ignoreFocusOut: true,
    validateInput: v => v.startsWith('http://') || v.startsWith('https://') ? null : 'Must start with http:// or https://',
  });
  if (!serverUrl) return;

  // Reasonable terminal URL guess: same host, +1 port if on 8403; user can override.
  const guessedTerminal = guessTerminalUrl(serverUrl);
  const terminalUrl = await vscode.window.showInputBox({
    prompt: 'Terminal WebSocket URL',
    value: guessedTerminal,
    placeHolder: 'ws://1.2.3.4:8404',
    ignoreFocusOut: true,
    validateInput: v => v.startsWith('ws://') || v.startsWith('wss://') ? null : 'Must start with ws:// or wss://',
  });
  if (!terminalUrl) return;

  const conn: ForgeConnection = { name: name.trim(), serverUrl: serverUrl.trim(), terminalUrl: terminalUrl.trim() };
  try {
    await mgr.add(conn);
  } catch (e: any) {
    vscode.window.showErrorMessage(`Forge: ${e.message}`);
    return;
  }
  vscode.window.showInformationMessage(`Forge: added "${conn.name}"`);
  if (switchAfter) {
    await mgr.setActive(conn.name);
  }
}

export async function removeConnectionCommand(mgr: ConnectionManager): Promise<void> {
  const list = mgr.list();
  if (list.length <= 1) {
    vscode.window.showWarningMessage('Forge: cannot remove the last connection.');
    return;
  }
  const picked = await vscode.window.showQuickPick(
    list.map(c => ({ label: c.name, description: c.serverUrl, name: c.name })),
    { placeHolder: 'Remove which connection?' },
  );
  if (!picked) return;
  const confirm = await vscode.window.showWarningMessage(
    `Remove connection "${picked.name}"? Saved token will be cleared.`,
    'Remove', 'Cancel',
  );
  if (confirm !== 'Remove') return;
  await mgr.remove(picked.name);
  vscode.window.showInformationMessage(`Forge: removed "${picked.name}"`);
}

export async function editConnectionsCommand(): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.openSettingsJson');
  vscode.window.showInformationMessage('Forge: edit `forge.connections` in settings.json');
}

function guessTerminalUrl(serverUrl: string): string {
  try {
    const u = new URL(serverUrl);
    const proto = u.protocol === 'https:' ? 'wss:' : 'ws:';
    let port = parseInt(u.port || (u.protocol === 'https:' ? '443' : '80'), 10);
    // forge default: HTTP=8403 → terminal=8404. If port is HTTP-style + 1.
    if (port === 8403) port = 8404;
    return `${proto}//${u.hostname}:${port}`;
  } catch {
    return 'ws://localhost:8404';
  }
}
