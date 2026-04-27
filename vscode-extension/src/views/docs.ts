import * as vscode from 'vscode';
import { ForgeClient } from '../api/client';
import { detectDocsTransport } from '../docs/transport';

interface DocFileNode {
  name: string;
  path: string;
  type: 'file' | 'dir';
  fileType?: 'md' | 'image' | 'other';
  children?: DocFileNode[];
}

export class DocsProvider implements vscode.TreeDataProvider<DocItem> {
  private _onDidChange = new vscode.EventEmitter<DocItem | undefined | void>();
  onDidChangeTreeData = this._onDidChange.event;

  // Cache the latest doc tree so we can resolve path → root-index lookups
  // for "open file" without refetching the whole tree.
  private cached: { roots: string[]; rootPaths: string[]; trees: DocFileNode[][] } | null = null;

  constructor(private client: ForgeClient) {}

  refresh(): void {
    this.cached = null;
    this._onDidChange.fire();
  }

  getTreeItem(el: DocItem): vscode.TreeItem {
    return el;
  }

  async getChildren(parent?: DocItem): Promise<DocItem[]> {
    if (!parent) {
      const r = await this.client.listDocs();
      if (r.status === 401 || r.status === 403) return [loginPrompt()];
      if (!r.ok || !r.data) return [hint('⚠ ' + (r.error || 'Not connected'))];
      const roots = r.data.roots || [];
      if (roots.length === 0) return [hint('No doc roots — add one in Settings → Doc Roots')];

      // /api/docs only returns the tree for ONE root at a time (the rootIdx
      // query). For each root, fire a separate request to get its tree.
      const trees: DocFileNode[][] = [];
      for (let i = 0; i < roots.length; i++) {
        if (i === 0) {
          // First call already happened — its tree is in r.data.tree
          trees.push(r.data.tree || []);
        } else {
          const sub = await this.client.request<any>(`/api/docs?root=${i}`);
          trees.push(sub.ok ? (sub.data?.tree || []) : []);
        }
      }
      const rootPaths = r.data.rootPaths || [];
      this.cached = { roots, rootPaths, trees };

      const transport = detectDocsTransport();

      // Always show docRoot as a parent — even if there's only one — so the
      // inline ⌨️ "Open Terminal" action has somewhere to live.
      return roots.map((name, i) => {
        const item = new DocItem(
          name,
          vscode.TreeItemCollapsibleState.Expanded,  // expand by default
          'forge.docRoot',
          { rootIdx: i, rootPath: rootPaths[i], rootName: name, view: 'docs' },
          `${rootPaths[i] || name}\nMode: ${transport === 'local' ? 'local file' : 'remote (forge HTTP)'}`,
        );
        item.iconPath = new vscode.ThemeIcon('folder-library');
        // Description: distinguish local vs remote at a glance.
        item.description = transport === 'local' ? '$(home) local' : '$(globe) remote';
        return item;
      });
    }

    if (parent.contextValue === 'forge.docRoot' && this.cached) {
      const idx = parent.meta.rootIdx;
      const tree = this.cached.trees[idx] || [];
      const rootPath = this.cached.rootPaths[idx];
      return tree.map(n => buildNode(n, idx, rootPath));
    }

    if (parent.contextValue === 'forge.docDir' && this.cached) {
      const children = parent.meta.children as DocFileNode[] | undefined;
      if (!children) return [];
      return children.map(n => buildNode(n, parent.meta.rootIdx, parent.meta.rootPath));
    }

    return [];
  }
}

class DocItem extends vscode.TreeItem {
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

function buildNode(n: DocFileNode, rootIdx: number, rootPath: string): DocItem {
  if (n.type === 'dir') {
    const item = new DocItem(
      n.name,
      vscode.TreeItemCollapsibleState.Collapsed,
      'forge.docDir',
      { rootIdx, rootPath, children: n.children || [], path: n.path },
      n.path,
    );
    item.iconPath = new vscode.ThemeIcon('folder');
    return item;
  }
  // File
  const icon = n.fileType === 'md' ? 'markdown'
    : n.fileType === 'image' ? 'file-media'
    : 'file';
  const item = new DocItem(
    n.name,
    vscode.TreeItemCollapsibleState.None,
    'forge.docFile',
    { rootIdx, rootPath, path: n.path, fileType: n.fileType },
    n.path,
  );
  item.iconPath = new vscode.ThemeIcon(icon);
  item.command = {
    command: 'forge.openDoc',
    title: 'Open Doc',
    arguments: [{ rootIdx, rootPath, path: n.path, fileType: n.fileType, name: n.name }],
  };
  return item;
}

function hint(msg: string): DocItem {
  return new DocItem(msg, vscode.TreeItemCollapsibleState.None, 'forge.hint');
}

function loginPrompt(): DocItem {
  const item = new DocItem('🔑 Click to login', vscode.TreeItemCollapsibleState.None, 'forge.login');
  item.command = { command: 'forge.login', title: 'Login' };
  return item;
}
