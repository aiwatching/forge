import * as vscode from 'vscode';
import { ForgeClient } from '../api/client';

export async function newTaskCommand(client: ForgeClient): Promise<void> {
  const projRes = await client.listProjects();
  const projects: any[] = projRes.ok && Array.isArray(projRes.data) ? projRes.data : [];
  if (projects.length === 0) {
    vscode.window.showWarningMessage('Forge: no projects configured. Add one in Settings → Project Roots.');
    return;
  }

  const projItems = projects.map(p => ({
    label: p.name,
    description: p.path,
    project: p,
  }));
  const proj = await vscode.window.showQuickPick(projItems, { placeHolder: 'Project for this task' });
  if (!proj) return;

  const prompt = await vscode.window.showInputBox({
    prompt: `Task prompt for ${proj.label}`,
    placeHolder: 'e.g. Add unit tests for the auth module',
    ignoreFocusOut: true,
  });
  if (!prompt) return;

  const newSessionPick = await vscode.window.showQuickPick(
    [
      { label: 'Continue last session', value: false },
      { label: 'Fresh session', value: true },
    ],
    { placeHolder: 'Session mode' },
  );
  if (newSessionPick === undefined) return;

  const r = await client.createTask(proj.label, prompt, { newSession: newSessionPick.value });
  if (r.ok) {
    vscode.window.showInformationMessage(`Forge: task queued${r.data?.id ? ' (id ' + r.data.id + ')' : ''}.`);
    vscode.commands.executeCommand('forge.refresh');
  } else {
    vscode.window.showErrorMessage(`Forge: failed to queue task — ${r.error}`);
  }
}
