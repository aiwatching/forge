import * as vscode from 'vscode';
import { ForgeClient } from './api/client';
import { Auth } from './auth/auth';

type Status = 'connected' | 'auth' | 'offline';

export class StatusBar {
  private item: vscode.StatusBarItem;
  private timer: NodeJS.Timeout | null = null;

  constructor(private client: ForgeClient, private auth: Auth) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.item.command = 'forge.openWebUI';
    this.item.show();
  }

  async update(): Promise<void> {
    const state = await this.detect();
    switch (state) {
      case 'connected':
        this.item.text = '$(zap) Forge';
        this.item.tooltip = 'Forge connected — click to open Web UI';
        this.item.backgroundColor = undefined;
        break;
      case 'auth':
        this.item.text = '$(key) Forge';
        this.item.tooltip = 'Forge: login required';
        this.item.command = 'forge.login';
        this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        break;
      case 'offline':
        this.item.text = '$(circle-slash) Forge';
        this.item.tooltip = 'Forge server unreachable — click to start';
        this.item.command = 'forge.startServer';
        this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
        break;
    }
  }

  private async detect(): Promise<Status> {
    const reachable = await this.client.ping();
    if (!reachable) return 'offline';
    const token = await this.auth.getToken();
    if (!token) return 'auth';
    // Quick auth probe: fetch any authed endpoint
    const r = await this.client.listProjects();
    if (r.status === 401 || r.status === 403) return 'auth';
    return 'connected';
  }

  startPolling(seconds: number): void {
    this.stopPolling();
    void this.update();
    this.timer = setInterval(() => void this.update(), seconds * 1000);
  }

  stopPolling(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  dispose(): void {
    this.stopPolling();
    this.item.dispose();
  }
}
