import * as vscode from 'vscode';
import { spawn } from 'node:child_process';
import { ForgeClient } from '../api/client';

export async function startServerCommand(client: ForgeClient): Promise<void> {
  if (await client.ping()) {
    vscode.window.showInformationMessage('Forge: server already running.');
    return;
  }
  const proc = spawn('forge', ['server', 'start'], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  proc.on('error', (err) => {
    vscode.window.showErrorMessage(`Forge: failed to start (${err.message}). Is the 'forge' CLI on PATH?`);
  });
  proc.unref();

  // Poll for up to 30s
  const start = Date.now();
  while (Date.now() - start < 30_000) {
    await new Promise(r => setTimeout(r, 1000));
    if (await client.ping()) {
      vscode.window.showInformationMessage('Forge: server started.');
      vscode.commands.executeCommand('forge.refresh');
      return;
    }
  }
  vscode.window.showWarningMessage('Forge: started but not yet reachable. Try Forge: Refresh in a moment.');
}

export async function stopServerCommand(): Promise<void> {
  const choice = await vscode.window.showWarningMessage(
    'Stop the Forge server? Active terminals and tasks will be terminated.',
    'Stop', 'Cancel',
  );
  if (choice !== 'Stop') return;

  const proc = spawn('forge', ['server', 'stop'], { stdio: 'ignore', env: process.env });
  proc.on('error', (err) => {
    vscode.window.showErrorMessage(`Forge stop failed: ${err.message}`);
  });
  vscode.window.showInformationMessage('Forge: stop signal sent.');
}

export function openWebUICommand(client: ForgeClient): void {
  const url = vscode.workspace.getConfiguration('forge').get<string>('serverUrl', 'http://localhost:8403');
  vscode.env.openExternal(vscode.Uri.parse(url));
}
