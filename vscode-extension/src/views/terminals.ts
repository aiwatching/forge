import * as vscode from 'vscode';
import { ForgeClient } from '../api/client';

export class TerminalsProvider implements vscode.TreeDataProvider<TermItem> {
  private _onDidChange = new vscode.EventEmitter<TermItem | undefined | void>();
  onDidChangeTreeData = this._onDidChange.event;

  constructor(private client: ForgeClient) {}

  refresh(): void {
    this._onDidChange.fire();
  }

  getTreeItem(el: TermItem): vscode.TreeItem {
    return el;
  }

  async getChildren(): Promise<TermItem[]> {
    const r = await this.client.listTerminals();
    if (r.status === 401 || r.status === 403) {
      const item = new TermItem('🔑 Click to login', vscode.TreeItemCollapsibleState.None, 'forge.login');
      item.command = { command: 'forge.login', title: 'Login' };
      return [item];
    }
    if (!r.ok || !r.data) return [hint('⚠ ' + (r.error || 'Not connected'))];

    // /api/terminal-state returns { sessions: [{name, projectPath, ...}], ... }
    const sessions: any[] = Array.isArray(r.data) ? r.data : (r.data.sessions || []);

    const items: TermItem[] = sessions.map((s: any) => {
      const name = s.name || s.sessionName || 'unknown';
      const proj = s.projectPath ? s.projectPath.split('/').pop() : '';
      const item = new TermItem(
        `${name}${proj ? '  ·  ' + proj : ''}`,
        vscode.TreeItemCollapsibleState.None,
        'forge.terminal',
        { sessionName: name },
        s.projectPath || name,
      );
      item.iconPath = new vscode.ThemeIcon('terminal');
      item.command = {
        command: 'forge.attachTerminal',
        title: 'Attach',
        arguments: [{ sessionName: name }],
      };
      return item;
    });

    // Always offer "Open <project>…" entries below — clicking opens the
    // session picker (Current / New / Other) like the forge web UI.
    const projRes = await this.client.listProjects();
    const projects: any[] = projRes.ok && Array.isArray(projRes.data) ? projRes.data : [];
    for (const p of projects) {
      const item = new TermItem(
        `Open ${p.name}…`,
        vscode.TreeItemCollapsibleState.None,
        'forge.openSession',
        { projectPath: p.path },
        `Open a session in ${p.path}`,
      );
      item.iconPath = new vscode.ThemeIcon('repo');
      item.command = {
        command: 'forge.openSession',
        title: 'Open Session',
        arguments: [{ projectPath: p.path, projectName: p.name }],
      };
      items.push(item);
    }

    if (items.length === 0) return [hint('No active terminals — add a project root in Settings')];
    return items;
  }
}

class TermItem extends vscode.TreeItem {
  constructor(
    label: string,
    collapsible: vscode.TreeItemCollapsibleState,
    contextValue: string,
    public meta: any = {},
    tooltip?: string,
  ) {
    super(label, collapsible);
    this.contextValue = contextValue;
    if (tooltip) this.tooltip = tooltip;
  }
}

function hint(msg: string): TermItem {
  return new TermItem(msg, vscode.TreeItemCollapsibleState.None, 'forge.hint');
}
