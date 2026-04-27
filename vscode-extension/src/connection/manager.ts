import * as vscode from 'vscode';

export interface ForgeConnection {
  name: string;
  serverUrl: string;
  terminalUrl: string;
}

const CONFIG_NS = 'forge';

/** Manages the user's saved forge connections and the active one.
 *  Persisted in VSCode's user settings (`forge.connections` + `forge.activeConnection`). */
export class ConnectionManager {
  private _onDidChange = new vscode.EventEmitter<ForgeConnection>();
  onDidChange = this._onDidChange.event;

  /** Listen for the user editing connections in settings.json so we can
   *  refresh dependent state. */
  watchConfig(context: vscode.ExtensionContext): void {
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('forge.connections') || e.affectsConfiguration('forge.activeConnection')
       || e.affectsConfiguration('forge.serverUrl') || e.affectsConfiguration('forge.terminalUrl')) {
        this._onDidChange.fire(this.active());
      }
    }));
  }

  list(): ForgeConnection[] {
    const cfg = vscode.workspace.getConfiguration(CONFIG_NS);
    const conns = cfg.get<ForgeConnection[]>('connections', []);
    if (conns && conns.length > 0) return conns;
    // Backwards compat: synthesize "Local" from legacy single-server fields.
    return [{
      name: 'Local',
      serverUrl: cfg.get<string>('serverUrl', 'http://localhost:8403'),
      terminalUrl: cfg.get<string>('terminalUrl', 'ws://localhost:8404'),
    }];
  }

  active(): ForgeConnection {
    const all = this.list();
    const cfg = vscode.workspace.getConfiguration(CONFIG_NS);
    const name = cfg.get<string>('activeConnection');
    return (name && all.find(c => c.name === name)) || all[0];
  }

  async setActive(name: string): Promise<void> {
    await vscode.workspace.getConfiguration(CONFIG_NS)
      .update('activeConnection', name, vscode.ConfigurationTarget.Global);
    this._onDidChange.fire(this.active());
  }

  async add(c: ForgeConnection): Promise<void> {
    const cfg = vscode.workspace.getConfiguration(CONFIG_NS);
    let list = cfg.get<ForgeConnection[]>('connections', []);
    if (list.length === 0) {
      // Promote the synthesized Local entry so the user-set list is explicit.
      list = this.list();
    }
    if (list.some(x => x.name === c.name)) {
      throw new Error(`A connection named "${c.name}" already exists`);
    }
    list.push(c);
    await cfg.update('connections', list, vscode.ConfigurationTarget.Global);
    this._onDidChange.fire(this.active());
  }

  async remove(name: string): Promise<void> {
    const cfg = vscode.workspace.getConfiguration(CONFIG_NS);
    const list = cfg.get<ForgeConnection[]>('connections', []).filter(c => c.name !== name);
    await cfg.update('connections', list, vscode.ConfigurationTarget.Global);
    // If we removed the active one, fall back to the first remaining.
    const activeName = cfg.get<string>('activeConnection');
    if (activeName === name) {
      const remaining = this.list();
      await cfg.update('activeConnection', remaining[0]?.name, vscode.ConfigurationTarget.Global);
    }
    this._onDidChange.fire(this.active());
  }
}
