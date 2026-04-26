import * as vscode from 'vscode';
import { ForgeClient } from '../api/client';

export async function loginCommand(client: ForgeClient): Promise<void> {
  const reachable = await client.ping();
  if (!reachable) {
    const choice = await vscode.window.showWarningMessage(
      'Cannot reach Forge server. Make sure it is running.',
      'Start Server',
      'Open Settings',
      'Cancel',
    );
    if (choice === 'Start Server') {
      vscode.commands.executeCommand('forge.startServer');
      return;
    }
    if (choice === 'Open Settings') {
      vscode.commands.executeCommand('workbench.action.openSettings', '@ext:aion0.forge-vscode');
      return;
    }
    return;
  }

  const password = await vscode.window.showInputBox({
    prompt: 'Forge admin password',
    password: true,
    ignoreFocusOut: true,
  });
  if (!password) return;

  const result = await client.login(password);
  if (result.ok) {
    vscode.window.showInformationMessage('Forge: logged in');
    vscode.commands.executeCommand('forge.refresh');
  } else {
    vscode.window.showErrorMessage(`Forge login failed: ${result.error}`);
  }
}

export async function logoutCommand(client: ForgeClient): Promise<void> {
  await client.logout();
  vscode.window.showInformationMessage('Forge: logged out');
  vscode.commands.executeCommand('forge.refresh');
}
