import * as vscode from 'vscode';
import { ForgeClient } from '../api/client';

/** Open the forge workspace bound to the current VSCode folder.
 *  - If found: focus the forge sidebar so the user sees it.
 *  - If not found: ask whether to create one. */
export async function openWorkspaceForFolderCommand(client: ForgeClient): Promise<void> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    vscode.window.showWarningMessage('Forge: no folder open in VSCode.');
    return;
  }

  // If user has multiple folders, ask which.
  let folder = folders[0];
  if (folders.length > 1) {
    const picked = await vscode.window.showQuickPick(
      folders.map(f => ({ label: f.name, description: f.uri.fsPath, folder: f })),
      { placeHolder: 'Which folder?' },
    );
    if (!picked) return;
    folder = picked.folder;
  }

  const projectPath = folder.uri.fsPath;
  const r = await client.findWorkspaceByPath(projectPath);

  if (r.ok && r.data) {
    // Existing workspace — focus the sidebar.
    vscode.commands.executeCommand('workbench.view.extension.forge');
    vscode.commands.executeCommand('forge.refresh');
    vscode.window.setStatusBarMessage(`Forge: ${r.data.projectName} workspace ready`, 3000);
    return;
  }

  // No workspace yet — offer to create one.
  const choice = await vscode.window.showInformationMessage(
    `No forge workspace for ${folder.name}. Create one?`,
    'Create', 'Cancel',
  );
  if (choice !== 'Create') return;

  const create = await client.request('/api/workspace', {
    method: 'POST',
    body: JSON.stringify({ projectPath, projectName: folder.name }),
  });
  if (create.ok) {
    vscode.window.showInformationMessage(`Forge: workspace created for ${folder.name}.`);
    vscode.commands.executeCommand('workbench.view.extension.forge');
    vscode.commands.executeCommand('forge.refresh');
  } else {
    vscode.window.showErrorMessage(`Forge: failed to create workspace — ${create.error}`);
  }
}

/** Pick from the list of existing workspaces. */
export async function openWorkspaceCommand(client: ForgeClient): Promise<void> {
  const r = await client.listWorkspaces();
  if (!r.ok || !Array.isArray(r.data) || r.data.length === 0) {
    vscode.window.showInformationMessage('Forge: no workspaces yet. Use "Open Workspace for Current Folder" to create one.');
    return;
  }
  const items = r.data.map((ws: any) => ({
    label: ws.projectName || ws.id,
    description: ws.projectPath || '',
    detail: `${ws.agentCount || 0} smith(s)`,
    workspace: ws,
  }));
  const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Select a workspace' });
  if (!picked) return;
  vscode.commands.executeCommand('workbench.view.extension.forge');
  vscode.commands.executeCommand('forge.refresh');
}

// ── Daemon control ──────────────────────────────────────

export async function startDaemonCommand(client: ForgeClient, arg?: { workspaceId?: string }): Promise<void> {
  const id = await resolveWorkspaceId(client, arg?.workspaceId);
  if (!id) return;
  const r = await client.wsAction(id, 'start_daemon');
  if (r.ok) {
    vscode.window.showInformationMessage('Forge: daemon starting…');
    vscode.commands.executeCommand('forge.refresh');
  } else {
    vscode.window.showErrorMessage(`Forge: start daemon failed — ${r.error}`);
  }
}

export async function stopDaemonCommand(client: ForgeClient, arg?: { workspaceId?: string }): Promise<void> {
  const id = await resolveWorkspaceId(client, arg?.workspaceId);
  if (!id) return;
  const choice = await vscode.window.showWarningMessage(
    'Stop the workspace daemon? Running smiths will be terminated.',
    'Stop', 'Cancel',
  );
  if (choice !== 'Stop') return;
  const r = await client.wsAction(id, 'stop_daemon');
  if (r.ok) {
    vscode.window.showInformationMessage('Forge: daemon stopped.');
    vscode.commands.executeCommand('forge.refresh');
  } else {
    vscode.window.showErrorMessage(`Forge: stop daemon failed — ${r.error}`);
  }
}

export async function restartDaemonCommand(client: ForgeClient, arg?: { workspaceId?: string }): Promise<void> {
  const id = await resolveWorkspaceId(client, arg?.workspaceId);
  if (!id) return;
  const stop = await client.wsAction(id, 'stop_daemon');
  if (!stop.ok) {
    vscode.window.showErrorMessage(`Forge: restart failed at stop step — ${stop.error}`);
    return;
  }
  // Brief settle
  await new Promise(r => setTimeout(r, 800));
  const start = await client.wsAction(id, 'start_daemon');
  if (start.ok) {
    vscode.window.showInformationMessage('Forge: daemon restarted.');
    vscode.commands.executeCommand('forge.refresh');
  } else {
    vscode.window.showErrorMessage(`Forge: restart failed at start step — ${start.error}`);
  }
}

async function resolveWorkspaceId(client: ForgeClient, given?: string): Promise<string | undefined> {
  if (given) return given;
  const r = await client.listWorkspaces();
  if (!r.ok || !Array.isArray(r.data) || r.data.length === 0) {
    vscode.window.showWarningMessage('Forge: no workspaces.');
    return undefined;
  }
  if (r.data.length === 1) return r.data[0].id;
  const picked = await vscode.window.showQuickPick(
    r.data.map((ws: any) => ({ label: ws.projectName || ws.id, description: ws.projectPath, ws })),
    { placeHolder: 'Which workspace?' },
  );
  return picked?.ws?.id;
}
