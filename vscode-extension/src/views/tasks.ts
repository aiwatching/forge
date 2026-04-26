import * as vscode from 'vscode';
import { ForgeClient } from '../api/client';

export class TasksProvider implements vscode.TreeDataProvider<TaskItem> {
  private _onDidChange = new vscode.EventEmitter<TaskItem | undefined | void>();
  onDidChangeTreeData = this._onDidChange.event;

  constructor(private client: ForgeClient) {}

  refresh(): void {
    this._onDidChange.fire();
  }

  getTreeItem(el: TaskItem): vscode.TreeItem {
    return el;
  }

  async getChildren(): Promise<TaskItem[]> {
    const r = await this.client.listTasks();
    if (r.status === 401 || r.status === 403) {
      const item = new TaskItem('🔑 Click to login', vscode.TreeItemCollapsibleState.None, 'forge.login');
      item.command = { command: 'forge.login', title: 'Login' };
      return [item];
    }
    if (!r.ok || !Array.isArray(r.data)) return [hint('⚠ ' + (r.error || 'Not connected'))];
    if (r.data.length === 0) return [hint('No tasks')];

    // Sort: running > queued > done > failed; newest first
    const order: Record<string, number> = { running: 0, queued: 1, done: 2, failed: 3 };
    const sorted = [...r.data].sort((a, b) => {
      const pa = order[a.status] ?? 9;
      const pb = order[b.status] ?? 9;
      if (pa !== pb) return pa - pb;
      return (b.createdAt || 0) - (a.createdAt || 0);
    });

    return sorted.slice(0, 50).map((t: any) => {
      const item = new TaskItem(
        `${statusEmoji(t.status)} ${t.projectName || ''} — ${truncate(t.prompt, 50)}`,
        vscode.TreeItemCollapsibleState.None,
        'forge.task',
        { taskId: t.id },
        `${t.status}\n${t.prompt}`,
      );
      item.iconPath = statusIcon(t.status);
      return item;
    });
  }
}

class TaskItem extends vscode.TreeItem {
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

function statusEmoji(s: string): string {
  switch (s) {
    case 'running': return '▶';
    case 'queued':  return '⌛';
    case 'done':    return '✓';
    case 'failed':  return '✕';
    default:        return '·';
  }
}

function statusIcon(s: string): vscode.ThemeIcon {
  switch (s) {
    case 'running': return new vscode.ThemeIcon('loading~spin', new vscode.ThemeColor('charts.green'));
    case 'queued':  return new vscode.ThemeIcon('clock', new vscode.ThemeColor('charts.gray'));
    case 'done':    return new vscode.ThemeIcon('check', new vscode.ThemeColor('charts.green'));
    case 'failed':  return new vscode.ThemeIcon('error', new vscode.ThemeColor('charts.red'));
    default:        return new vscode.ThemeIcon('circle-outline');
  }
}

function truncate(s: string, n: number): string {
  if (!s) return '';
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function hint(msg: string): TaskItem {
  return new TaskItem(msg, vscode.TreeItemCollapsibleState.None, 'forge.hint');
}
