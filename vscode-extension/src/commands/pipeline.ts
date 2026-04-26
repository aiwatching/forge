import * as vscode from 'vscode';
import { ForgeClient } from '../api/client';

interface PipelineArg {
  projectPath?: string;
  projectName?: string;
  workflowName?: string;
}

/** Pick a project (if not given), then a workflow, then add the binding. */
export async function addPipelineCommand(client: ForgeClient, arg?: PipelineArg): Promise<void> {
  let projectPath = arg?.projectPath;
  let projectName = arg?.projectName;

  if (!projectPath) {
    const projRes = await client.listProjects();
    const projects: any[] = projRes.ok && Array.isArray(projRes.data) ? projRes.data : [];
    if (projects.length === 0) {
      vscode.window.showWarningMessage('Forge: no projects configured.');
      return;
    }
    const pickedProj = await vscode.window.showQuickPick(
      projects.map(p => ({ label: p.name, description: p.path, project: p })),
      { placeHolder: 'Add pipeline to which project?' },
    );
    if (!pickedProj) return;
    projectPath = pickedProj.project.path;
    projectName = pickedProj.project.name;
  }

  // Fetch workflows + existing bindings to filter out duplicates.
  const projPipes = await client.getProjectPipelines(projectPath!);
  const allWorkflows: any[] = projPipes.ok ? (projPipes.data?.workflows || []) : [];
  const bindings: any[] = projPipes.ok ? (projPipes.data?.bindings || []) : [];
  const bound = new Set(bindings.map((b: any) => b.workflowName));
  const candidates = allWorkflows.filter((w: any) => !bound.has(w.name));

  if (candidates.length === 0) {
    vscode.window.showInformationMessage('Forge: no more workflows to add (all are already bound).');
    return;
  }

  const picked = await vscode.window.showQuickPick(
    candidates.map((w: any) => ({
      label: w.name,
      description: w.builtin ? 'built-in' : 'user',
      detail: w.description || '',
      workflow: w,
    })),
    { placeHolder: 'Workflow to bind' },
  );
  if (!picked) return;

  const r = await client.addProjectPipeline(projectPath!, projectName!, picked.workflow.name, {});
  if (r.ok) {
    vscode.window.showInformationMessage(`Forge: added "${picked.workflow.name}" to ${projectName}`);
    vscode.commands.executeCommand('forge.refresh');
  } else {
    vscode.window.showErrorMessage(`Forge: add pipeline failed — ${r.error}`);
  }
}

/** Trigger a binding to run once. */
export async function triggerPipelineCommand(client: ForgeClient, arg?: PipelineArg): Promise<void> {
  if (!arg?.projectPath || !arg.projectName || !arg.workflowName) return;
  const r = await client.triggerProjectPipeline(arg.projectPath, arg.projectName, arg.workflowName, {});
  if (r.ok) {
    vscode.window.showInformationMessage(`Forge: triggered "${arg.workflowName}"${r.data?.id ? ' (run ' + r.data.id.slice(0, 8) + ')' : ''}`);
    vscode.commands.executeCommand('forge.refresh');
  } else {
    vscode.window.showErrorMessage(`Forge: trigger failed — ${r.error}`);
  }
}

/** Toggle enable/disable on a binding. The argument carries current `enabled`. */
export async function togglePipelineCommand(client: ForgeClient, arg?: PipelineArg & { enabled?: boolean }): Promise<void> {
  if (!arg?.projectPath || !arg.workflowName) return;
  const next = !arg.enabled;
  const r = await client.updateProjectPipeline(arg.projectPath, arg.workflowName, { enabled: next });
  if (r.ok) {
    vscode.window.showInformationMessage(`Forge: "${arg.workflowName}" ${next ? 'enabled' : 'disabled'}`);
    vscode.commands.executeCommand('forge.refresh');
  } else {
    vscode.window.showErrorMessage(`Forge: toggle failed — ${r.error}`);
  }
}

/** Remove a binding from a project. */
export async function removePipelineCommand(client: ForgeClient, arg?: PipelineArg): Promise<void> {
  if (!arg?.projectPath || !arg.workflowName) return;
  const choice = await vscode.window.showWarningMessage(
    `Remove pipeline "${arg.workflowName}" from ${arg.projectName}?`,
    'Remove', 'Cancel',
  );
  if (choice !== 'Remove') return;
  const r = await client.removeProjectPipeline(arg.projectPath, arg.workflowName);
  if (r.ok) {
    vscode.window.showInformationMessage(`Forge: removed "${arg.workflowName}"`);
    vscode.commands.executeCommand('forge.refresh');
  } else {
    vscode.window.showErrorMessage(`Forge: remove failed — ${r.error}`);
  }
}
