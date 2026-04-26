import * as vscode from 'vscode';
import { ForgeClient } from '../api/client';

export class WorkspacesProvider implements vscode.TreeDataProvider<WsItem> {
  private _onDidChange = new vscode.EventEmitter<WsItem | undefined | void>();
  onDidChangeTreeData = this._onDidChange.event;

  constructor(private client: ForgeClient) {}

  refresh(): void {
    this._onDidChange.fire();
  }

  getTreeItem(el: WsItem): vscode.TreeItem {
    return el;
  }

  async getChildren(parent?: WsItem): Promise<WsItem[]> {
    if (!parent) {
      const r = await this.client.listWorkspaces();
      if (r.status === 401 || r.status === 403) return [loginPrompt()];
      if (!r.ok || !Array.isArray(r.data)) return [errorItem(r.error || 'Not connected')];
      if (r.data.length === 0) return [hintItem('No workspaces yet')];
      return r.data.map((ws: any) => new WsItem(
        ws.projectName || ws.id,
        vscode.TreeItemCollapsibleState.Collapsed,
        'forge.workspace',
        { workspaceId: ws.id, projectPath: ws.projectPath },
        `${ws.projectPath || ''}\n${ws.agentCount} smith(s)`,
      ));
    }
    if (parent.contextValue === 'forge.workspace' && parent.meta?.workspaceId) {
      const r = await this.client.getWorkspaceAgents(parent.meta.workspaceId);
      if (!r.ok || !r.data) return [errorItem(r.error || 'Failed to load')];
      const agents: any[] = r.data.agents || [];
      const states: Record<string, any> = r.data.states || {};
      return agents.map(a => {
        const s = states[a.id] || {};
        const smith = s.smithStatus || 'down';
        const task = s.taskStatus || 'idle';
        const paused = s.paused ? ' ⏸' : '';
        const icon = smithIcon(smith, task, !!s.paused);
        const item = new WsItem(
          `${a.icon || '🤖'} ${a.label}${paused}`,
          vscode.TreeItemCollapsibleState.None,
          'forge.smith',
          { workspaceId: parent.meta.workspaceId, agentId: a.id, label: a.label },
          `smith=${smith} task=${task}`,
        );
        item.iconPath = icon;
        return item;
      });
    }
    return [];
  }
}

class WsItem extends vscode.TreeItem {
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

function errorItem(err: string): WsItem {
  const item = new WsItem(`⚠ ${err}`, vscode.TreeItemCollapsibleState.None, 'forge.error');
  return item;
}

function hintItem(msg: string): WsItem {
  return new WsItem(msg, vscode.TreeItemCollapsibleState.None, 'forge.hint');
}

function loginPrompt(): WsItem {
  const item = new WsItem('🔑 Click to login', vscode.TreeItemCollapsibleState.None, 'forge.login');
  item.command = { command: 'forge.login', title: 'Login' };
  return item;
}

function smithIcon(smith: string, task: string, paused: boolean): vscode.ThemeIcon {
  if (paused) return new vscode.ThemeIcon('debug-pause', new vscode.ThemeColor('charts.orange'));
  if (smith === 'down') return new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('charts.gray'));
  if (smith === 'starting') return new vscode.ThemeIcon('loading~spin', new vscode.ThemeColor('charts.orange'));
  if (task === 'running') return new vscode.ThemeIcon('debug-start', new vscode.ThemeColor('charts.green'));
  if (task === 'failed') return new vscode.ThemeIcon('error', new vscode.ThemeColor('charts.red'));
  if (task === 'done') return new vscode.ThemeIcon('check', new vscode.ThemeColor('charts.green'));
  return new vscode.ThemeIcon('circle-outline');
}
