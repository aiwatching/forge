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
          { workspaceId: ws.id, projectPath: ws.projectPath, daemonActive, view: 'projects' },
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
    // Workspace expanded → show ROOT smiths (no dependsOn); each smith's downstream
    // chain is shown by expanding the smith itself. This visualizes the DAG using
    // tree nesting (no arrows possible in TreeView, but the chain is faithful).
    if (parent.contextValue?.startsWith('forge.workspace') && parent.meta?.workspaceId) {
      const r = await this.client.getWorkspaceAgents(parent.meta.workspaceId);
      if (!r.ok || !r.data) return [errorItem(r.error || 'Failed to load')];
      const agents: any[] = r.data.agents || [];
      const states: Record<string, any> = r.data.states || {};
      const roots = agents.filter(a => !a.dependsOn || a.dependsOn.length === 0);
      return roots.map(a => buildSmithItem(a, states[a.id] || {}, parent.meta.workspaceId, agents));
    }

    // Smith expanded → DAG downstream + Inbox + Log virtual sections.
    // Match real smith status nodes only — `forge.smith.<status>[.paused]`.
    // Inbox / Log section nodes use unrelated prefixes so they don't match.
    if (parent.contextValue?.startsWith('forge.smith.') && parent.meta?.workspaceId && parent.meta?.agentId) {
      const r = await this.client.getWorkspaceAgents(parent.meta.workspaceId);
      if (!r.ok || !r.data) return [];
      const agents: any[] = r.data.agents || [];
      const states: Record<string, any> = r.data.states || {};
      const downstream = agents.filter(a => (a.dependsOn || []).includes(parent.meta.agentId));
      const out: WsItem[] = downstream.map(a => buildSmithItem(a, states[a.id] || {}, parent.meta.workspaceId, agents));
      // Always append Inbox + Log section nodes.
      const inboxNode = new WsItem('Inbox', vscode.TreeItemCollapsibleState.Collapsed, 'forge.inboxSection',
        { workspaceId: parent.meta.workspaceId, agentId: parent.meta.agentId, label: parent.meta.label }, 'Recent bus messages addressed to this smith');
      inboxNode.iconPath = new vscode.ThemeIcon('inbox');
      out.push(inboxNode);
      const logNode = new WsItem('Activity Log', vscode.TreeItemCollapsibleState.Collapsed, 'forge.logSection',
        { workspaceId: parent.meta.workspaceId, agentId: parent.meta.agentId, label: parent.meta.label }, 'Latest activity log entries');
      logNode.iconPath = new vscode.ThemeIcon('output');
      out.push(logNode);
      return out;
    }

    // Inbox section expanded → list recent messages.
    if (parent.contextValue === 'forge.inboxSection') {
      const r = await this.client.smithAction(parent.meta.workspaceId, 'inbox', parent.meta.agentId);
      if (!r.ok) return [hintItem(`⚠ ${r.error || 'failed to load'}`)];
      const msgs: any[] = r.data?.messages || [];
      if (msgs.length === 0) return [hintItem('No messages')];
      return msgs.slice().reverse().map((m: any) => {
        const item = new WsItem(
          `${msgIcon(m.status)} ${m.from} → ${m.action}`,
          vscode.TreeItemCollapsibleState.None,
          'forge.inboxItem',
          { messageId: m.id },
          `${m.from} (${m.time})\nstatus: ${m.status}\naction: ${m.action}\n${m.content || ''}`.slice(0, 500),
        );
        item.description = `${m.status}  ·  ${m.time}`;
        return item;
      });
    }

    // Activity log section expanded → list latest log entries (newest first).
    if (parent.contextValue === 'forge.logSection') {
      const r = await this.client.smithAction(parent.meta.workspaceId, 'logs', parent.meta.agentId);
      if (!r.ok) return [hintItem(`⚠ ${r.error || 'failed to load'}`)];
      const logs: any[] = r.data?.logs || [];
      if (logs.length === 0) return [hintItem('No log entries')];
      return logs.slice(-50).reverse().map((entry: any) => {
        const time = entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString() : '';
        const subtype = entry.subtype || entry.type || 'log';
        const content = (entry.content || '').toString();
        const oneLine = content.replace(/\s+/g, ' ').trim();
        const item = new WsItem(
          `${logIcon(subtype)} ${oneLine.slice(0, 80) || subtype}`,
          vscode.TreeItemCollapsibleState.None,
          'forge.logItem',
          {},
          `[${subtype}] ${time}\n\n${content}`.slice(0, 2000),
        );
        item.description = time;
        return item;
      });
    }

    return [];
  }
}

/** Render one smith item. `allAgents` is the full agent list (used to decide
 *  whether to mark this node expandable, and to build the upstream summary). */
function buildSmithItem(a: any, s: any, workspaceId: string, allAgents: any[]): WsItem {
  const smith = s.smithStatus || 'down';
  const task = s.taskStatus || 'idle';
  const paused = s.paused ? ' ⏸' : '';

  // Always expandable — children are downstream smiths (DAG) + Inbox + Activity Log.
  const collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;

  // Description: show upstream count "← N" so the user can tell at a glance
  // that this smith depends on others (without expanding the parent path).
  const upstreamIds: string[] = a.dependsOn || [];
  const description = upstreamIds.length > 0
    ? `← ${upstreamIds.length}`
    : undefined;

  // Tooltip with full upstream/downstream list (helps explain multi-parent dups).
  const upLabels = upstreamIds.map(id => labelFor(id, allAgents)).filter(Boolean).join(', ');
  const downLabels = allAgents
    .filter(x => (x.dependsOn || []).includes(a.id))
    .map(x => x.label)
    .join(', ');
  const tooltipParts = [
    `${a.label} (${a.id})`,
    `smith=${smith} task=${task}${s.paused ? ' (paused)' : ''}`,
  ];
  if (upLabels) tooltipParts.push(`Depends on: ${upLabels}`);
  if (downLabels) tooltipParts.push(`Triggers: ${downLabels}`);

  const ctx = `forge.smith.${task}${s.paused ? '.paused' : ''}`;
  const arg = { workspaceId, agentId: a.id, label: a.label, view: 'projects' };

  const item = new WsItem(
    `${a.icon || '🤖'} ${a.label}${paused}`,
    collapsibleState,
    ctx,
    arg,
    tooltipParts.join('\n'),
  );
  item.description = description;
  item.iconPath = smithIcon(smith, task, !!s.paused);
  item.command = {
    command: 'forge.smithOpenTerminal',
    title: 'Open Smith Terminal',
    arguments: [arg],
  };
  return item;
}

function labelFor(id: string, allAgents: any[]): string {
  return allAgents.find(a => a.id === id)?.label || id;
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

function msgIcon(status: string): string {
  switch (status) {
    case 'pending':          return '⌛';
    case 'pending_approval': return '🔒';
    case 'running':          return '▶';
    case 'done':             return '✓';
    case 'failed':           return '✕';
    default:                 return '·';
  }
}

function logIcon(subtype: string): string {
  switch (subtype) {
    case 'error':         return '✕';
    case 'warning':       return '⚠';
    case 'bus_message':   return '✉';
    case 'watch_detected':return '👁';
    case 'hook_done':     return '✓';
    case 'system':        return 'ℹ';
    default:              return '·';
  }
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
