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
      // Sort by project name so the list order is stable across refreshes
      // (the API's underlying readdir is filesystem-dependent).
      const sorted = [...r.data].sort((a: any, b: any) =>
        (a.projectName || a.id).localeCompare(b.projectName || b.id),
      );
      // Pull daemonActive in parallel for each workspace so we can color the icon.
      const items = await Promise.all(sorted.map(async (ws: any) => {
        const detail = await this.client.getWorkspaceAgents(ws.id);
        const daemonActive = !!detail.data?.daemonActive;
        const ctx = daemonActive ? 'forge.workspace.active' : 'forge.workspace.inactive';
        const item = new WsItem(
          ws.projectName || ws.id,
          vscode.TreeItemCollapsibleState.Collapsed,
          ctx,
          { workspaceId: ws.id, projectPath: ws.projectPath, daemonActive },
          `${ws.projectPath || ''}\n${ws.agentCount} smith(s)\nDaemon: ${daemonActive ? 'active' : 'inactive'}`,
        );
        item.iconPath = new vscode.ThemeIcon(
          daemonActive ? 'circle-large-filled' : 'circle-large-outline',
          new vscode.ThemeColor(daemonActive ? 'charts.green' : 'charts.gray'),
        );
        return item;
      }));
      return items;
    }
    if (parent.contextValue?.startsWith('forge.workspace') && parent.meta?.workspaceId) {
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
        // Two contextValues — running vs not — so the right-click menu can
        // hide actions that don't apply (e.g. retry on a non-failed smith).
        const ctx = `forge.smith.${task}${s.paused ? '.paused' : ''}`;
        const arg = { workspaceId: parent.meta.workspaceId, agentId: a.id, label: a.label };
        const item = new WsItem(
          `${a.icon || '🤖'} ${a.label}${paused}`,
          vscode.TreeItemCollapsibleState.None,
          ctx,
          arg,
          `smith=${smith} task=${task}`,
        );
        item.iconPath = icon;
        item.command = {
          command: 'forge.smithOpenTerminal',
          title: 'Open Smith Terminal',
          arguments: [arg],
        };
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
