import * as vscode from 'vscode';
import { Auth } from '../auth/auth';

export interface ApiResponse<T = any> {
  ok: boolean;
  data?: T;
  status: number;
  error?: string;
}

export class ForgeClient {
  constructor(private auth: Auth) {}

  private get baseUrl(): string {
    return vscode.workspace.getConfiguration('forge').get<string>('serverUrl', 'http://localhost:8403');
  }

  get terminalUrl(): string {
    return vscode.workspace.getConfiguration('forge').get<string>('terminalUrl', 'ws://localhost:8404');
  }

  /** Verify password and store the resulting token. Returns ok/false. */
  async login(password: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await fetch(`${this.baseUrl}/api/auth/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      const data = await res.json() as { ok?: boolean; token?: string; error?: string };
      if (!res.ok || !data.ok || !data.token) {
        return { ok: false, error: data.error || `HTTP ${res.status}` };
      }
      await this.auth.setToken(data.token);
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: e?.message || 'Network error' };
    }
  }

  async logout(): Promise<void> {
    await this.auth.clearToken();
  }

  /** True if forge is reachable on the current serverUrl, regardless of auth. */
  async ping(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/version`, { signal: AbortSignal.timeout(2000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  async request<T = any>(path: string, init: RequestInit = {}): Promise<ApiResponse<T>> {
    const token = await this.auth.getToken();
    const headers = new Headers(init.headers);
    headers.set('Content-Type', 'application/json');
    if (token) headers.set('X-Forge-Token', token);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, { ...init, headers });
      const text = await res.text();
      let data: any;
      try { data = text ? JSON.parse(text) : undefined; } catch { data = text; }
      if (!res.ok) {
        return { ok: false, status: res.status, error: data?.error || `HTTP ${res.status}` };
      }
      return { ok: true, status: res.status, data };
    } catch (e: any) {
      return { ok: false, status: 0, error: e?.message || 'Network error' };
    }
  }

  // ── High-level helpers ──────────────────────────────

  listProjects()    { return this.request<any[]>('/api/projects'); }
  listWorkspaces()  { return this.request<any[]>('/api/workspace'); }
  /** Returns { agents, states, busLog, daemonActive } */
  getWorkspaceAgents(id: string) {
    return this.request<{ agents: any[]; states: Record<string, any>; busLog?: any[]; daemonActive?: boolean }>(`/api/workspace/${id}/agents`);
  }
  listTasks()       { return this.request<any[]>('/api/tasks'); }
  listTerminals()   { return this.request<any>('/api/terminal-state'); }
  getNotifications(){ return this.request<any>('/api/notifications'); }
  /** Returns { fixedSessionId } for a given project path, or null if not bound. */
  getProjectSession(projectPath: string) {
    return this.request<{ fixedSessionId: string | null }>(`/api/project-sessions?projectPath=${encodeURIComponent(projectPath)}`);
  }

  /** Returns recent claude sessions for a project, newest first. */
  listClaudeSessions(projectName: string) {
    return this.request<any[]>(`/api/claude-sessions/${encodeURIComponent(projectName)}`);
  }

  /** List all configured agents + the default. */
  listAgents() {
    return this.request<{ agents: any[]; defaultAgent: string }>('/api/agents');
  }

  /** Resolve launch info for an agent: { cliCmd, cliType, supportsSession, env?, model? } */
  resolveAgent(agentId: string) {
    return this.request<{
      cliCmd: string;
      cliType: string;
      supportsSession: boolean;
      env?: Record<string, string>;
      model?: string;
      resumeFlag?: string;
    }>(`/api/agents?resolve=${encodeURIComponent(agentId)}`);
  }

  /** Find a workspace by project path (returns null if none). */
  findWorkspaceByPath(projectPath: string) {
    return this.request<any>(`/api/workspace?projectPath=${encodeURIComponent(projectPath)}`);
  }

  /** Generic workspace daemon action — POST /api/workspace/<id>/agents { action, ... } */
  wsAction(workspaceId: string, action: string, body: Record<string, any> = {}) {
    return this.request<any>(`/api/workspace/${workspaceId}/agents`, {
      method: 'POST',
      body: JSON.stringify({ action, ...body }),
    });
  }

  createTask(projectName: string, prompt: string, opts?: { newSession?: boolean }) {
    return this.request<any>('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({ project: projectName, prompt, ...opts }),
    });
  }
}
