import * as vscode from 'vscode';
import { ForgeClient } from '../api/client';

/**
 * Pipelines tree:
 *   PIPELINES
 *   └─ 📁 <project>
 *      ├─ ⚙ <binding>      (workflow attached to project — schedule, enable/disable)
 *      ├─ ⚙ <binding>
 *      ├─ ─── Recent Runs ───
 *      ├─ ✓/▶ <run>        (most-recent runs of this project's workflows)
 *      └─ ...
 */
export class PipelinesProvider implements vscode.TreeDataProvider<PItem> {
  private _onDidChange = new vscode.EventEmitter<PItem | undefined | void>();
  onDidChangeTreeData = this._onDidChange.event;

  constructor(private client: ForgeClient) {}

  refresh(): void {
    this._onDidChange.fire();
  }

  getTreeItem(el: PItem): vscode.TreeItem {
    return el;
  }

  async getChildren(parent?: PItem): Promise<PItem[]> {
    if (!parent) {
      const r = await this.client.listProjects();
      if (r.status === 401 || r.status === 403) return [loginPrompt()];
      if (!r.ok || !Array.isArray(r.data)) return [hint('⚠ ' + (r.error || 'Not connected'))];
      if (r.data.length === 0) return [hint('No projects configured — add one in Settings → Project Roots')];
      const sorted = [...r.data].sort((a: any, b: any) => (a.name || '').localeCompare(b.name || ''));
      return sorted.map((p: any) => {
        const item = new PItem(
          p.name,
          vscode.TreeItemCollapsibleState.Collapsed,
          'forge.pipelineProject',
          { projectPath: p.path, projectName: p.name, view: 'tasks' },
          p.path,
        );
        item.iconPath = new vscode.ThemeIcon('folder');
        return item;
      });
    }

    if (parent.contextValue === 'forge.pipelineProject' && parent.meta?.projectPath) {
      const r = await this.client.getProjectPipelines(parent.meta.projectPath);
      if (!r.ok) return [hint('⚠ ' + (r.error || 'failed to load'))];
      const bindings: any[] = r.data?.bindings || [];
      const runs: any[] = r.data?.runs || [];
      const out: PItem[] = [];

      // Bindings — workflows attached to this project.
      if (bindings.length === 0) {
        const empty = new PItem(
          '＋ No pipelines yet',
          vscode.TreeItemCollapsibleState.None,
          'forge.pipelineEmpty',
          parent.meta,
          'Click to add a pipeline workflow to this project',
        );
        empty.iconPath = new vscode.ThemeIcon('add', new vscode.ThemeColor('charts.gray'));
        empty.command = {
          command: 'forge.addPipeline',
          title: 'Add Pipeline',
          arguments: [parent.meta],
        };
        out.push(empty);
      } else {
        for (const b of bindings) {
          const enabled = !!b.enabled;
          const schedule = b.config?.schedule || b.config?.cron || (b.config?.trigger === 'manual' ? 'manual' : 'manual');
          const item = new PItem(
            b.workflowName,
            vscode.TreeItemCollapsibleState.None,
            enabled ? 'forge.pipelineBinding.enabled' : 'forge.pipelineBinding.disabled',
            { projectPath: parent.meta.projectPath, projectName: parent.meta.projectName, workflowName: b.workflowName, enabled },
            `${b.workflowName}\n${enabled ? 'enabled' : 'disabled'} · ${schedule}${b.nextRunAt ? `\nnext run: ${new Date(b.nextRunAt).toLocaleString()}` : ''}`,
          );
          item.iconPath = new vscode.ThemeIcon(
            enabled ? 'gear' : 'gear',
            new vscode.ThemeColor(enabled ? 'charts.green' : 'charts.gray'),
          );
          item.description = `${enabled ? '' : 'disabled · '}${schedule}`;
          // Click → trigger now (fast iteration use case).
          item.command = {
            command: 'forge.triggerPipeline',
            title: 'Trigger Pipeline',
            arguments: [{ projectPath: parent.meta.projectPath, projectName: parent.meta.projectName, workflowName: b.workflowName }],
          };
          out.push(item);
        }
      }

      // Recent Runs section.
      if (runs.length > 0) {
        const sep = new PItem('Recent Runs', vscode.TreeItemCollapsibleState.None, 'forge.pipelineRunsHeader');
        sep.iconPath = new vscode.ThemeIcon('history');
        out.push(sep);
        // Sort by createdAt desc, last 10.
        const sorted = [...runs].sort((a: any, b: any) => (b.createdAt || '').localeCompare(a.createdAt || ''));
        for (const run of sorted.slice(0, 10)) {
          const status = run.status || 'pending';
          const created = run.createdAt ? new Date(run.createdAt).toLocaleString() : '';
          // Two ids: run.id (the project-pipelines bookkeeping row) and
          // run.pipelineId (the actual /api/pipelines/<id> document). Use
          // pipelineId for fetching detail; fall back to id for very old rows.
          const detailId = run.pipelineId || run.id;
          const item = new PItem(
            `${statusEmoji(status)} ${run.workflowName || detailId?.slice(0, 8)}`,
            vscode.TreeItemCollapsibleState.Collapsed,
            'forge.pipelineRun',
            { runId: detailId, status, view: 'tasks' },
            `${run.workflowName}\nstatus: ${status}\ncreated: ${created}`,
          );
          item.iconPath = statusIcon(status);
          item.description = `${status}  ·  ${created}`;
          out.push(item);
        }
      }

      return out;
    }

    // Run expanded → show nodes with status + error.
    if (parent.contextValue === 'forge.pipelineRun' && parent.meta?.runId) {
      const r = await this.client.getPipeline(parent.meta.runId);
      if (!r.ok || !r.data) return [hint(`⚠ ${r.error || 'failed to load'}`)];
      const nodes: Record<string, any> = r.data.nodes || {};
      const order: string[] = r.data.nodeOrder || Object.keys(nodes);
      if (order.length === 0) return [hint('No nodes')];
      return order.map((name) => {
        const n = nodes[name] || {};
        const status = n.status || 'pending';
        const item = new PItem(
          `${statusEmoji(status)} ${name}`,
          vscode.TreeItemCollapsibleState.None,
          'forge.pipelineNode',
          {
            runId: parent.meta.runId,
            nodeName: name,
            status,
            error: n.error || '',
            taskId: n.taskId,
            outputs: n.outputs || {},
            startedAt: n.startedAt,
            completedAt: n.completedAt,
          },
          `${name}\nstatus: ${status}${n.error ? `\n\nerror:\n${n.error}` : ''}${n.taskId ? `\ntaskId: ${n.taskId}` : ''}`,
        );
        item.iconPath = statusIcon(status);
        // Description shows error preview for failed nodes, status for others.
        if (status === 'failed' && n.error) {
          item.description = '✕ ' + String(n.error).split('\n')[0].slice(0, 60);
        } else if (n.startedAt) {
          const dur = n.completedAt
            ? `${Math.round((new Date(n.completedAt).getTime() - new Date(n.startedAt).getTime()) / 1000)}s`
            : '';
          item.description = dur ? `${status}  ·  ${dur}` : status;
        }
        // Always clickable — pending nodes still show status/duration (helpful)
        // and once they run we get richer detail.
        item.command = {
          command: 'forge.showPipelineNodeResult',
          title: 'Show Node Result',
          arguments: [{ runId: parent.meta.runId, nodeName: name, status, error: n.error, taskId: n.taskId, outputs: n.outputs, startedAt: n.startedAt, completedAt: n.completedAt }],
        };
        return item;
      });
    }

    return [];
  }
}

class PItem extends vscode.TreeItem {
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
    case 'running':   return '▶';
    case 'pending':   return '⌛';
    case 'done':      return '✓';
    case 'failed':    return '✕';
    case 'cancelled': return '⊘';
    default:          return '·';
  }
}

function statusIcon(s: string): vscode.ThemeIcon {
  switch (s) {
    case 'running':   return new vscode.ThemeIcon('loading~spin', new vscode.ThemeColor('charts.green'));
    case 'pending':   return new vscode.ThemeIcon('clock',        new vscode.ThemeColor('charts.gray'));
    case 'done':      return new vscode.ThemeIcon('check',        new vscode.ThemeColor('charts.green'));
    case 'failed':    return new vscode.ThemeIcon('error',        new vscode.ThemeColor('charts.red'));
    case 'cancelled': return new vscode.ThemeIcon('stop-circle',  new vscode.ThemeColor('charts.gray'));
    default:          return new vscode.ThemeIcon('circle-outline');
  }
}

function hint(msg: string): PItem {
  return new PItem(msg, vscode.TreeItemCollapsibleState.None, 'forge.hint');
}

function loginPrompt(): PItem {
  const item = new PItem('🔑 Click to login', vscode.TreeItemCollapsibleState.None, 'forge.login');
  item.command = { command: 'forge.login', title: 'Login' };
  return item;
}
