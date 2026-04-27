import { Auth } from '../auth/auth';
import { ConnectionManager } from '../connection/manager';

export interface ApiResponse<T = any> {
  ok: boolean;
  data?: T;
  status: number;
  error?: string;
}

export class ForgeClient {
  constructor(private auth: Auth, private conn: ConnectionManager) {}

  private get baseUrl(): string { return this.conn.active().serverUrl; }
  get terminalUrl(): string     { return this.conn.active().terminalUrl; }
  /** Public read of the active connection's HTTP base URL. */
  get baseUrlPublic(): string   { return this.baseUrl; }
  /** Active connection's display name — used as the SecretStorage token key. */
  get activeName(): string      { return this.conn.active().name; }

  /** Verify password and store the resulting token under the active connection. */
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
      await this.auth.setToken(this.activeName, data.token);
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: e?.message || 'Network error' };
    }
  }

  async logout(): Promise<void> {
    await this.auth.clearToken(this.activeName);
  }

  /** Token for the active connection (used by raw fetch helpers). */
  async getToken(): Promise<string | undefined> {
    return this.auth.getToken(this.activeName);
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
    const token = await this.auth.getToken(this.activeName);
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

  /** Smith-scoped action — POST /api/workspace/<id>/smith { action, agentId, ... } */
  smithAction(workspaceId: string, action: string, agentId: string, body: Record<string, any> = {}) {
    return this.request<any>(`/api/workspace/${workspaceId}/smith`, {
      method: 'POST',
      body: JSON.stringify({ action, agentId, ...body }),
    });
  }

  /** List pipeline runs (instances of started workflows), newest first. */
  listPipelines() { return this.request<any[]>('/api/pipelines'); }

  /** List available workflow templates (the YAMLs you can start as pipelines). */
  listWorkflows() { return this.request<any[]>('/api/pipelines?type=workflows'); }

  /** Fetch a single pipeline run by id (includes per-node status + errors). */
  getPipeline(id: string) {
    return this.request<any>(`/api/pipelines/${id}`);
  }

  /** Fetch a single task by id. Returns prompt, log, resultSummary, error, gitDiff. */
  getTask(id: string) {
    return this.request<any>(`/api/tasks/${id}`);
  }

  /** Start a pipeline run from a workflow template. */
  startPipeline(workflow: string, input: Record<string, string> = {}) {
    return this.request<any>('/api/pipelines', {
      method: 'POST',
      body: JSON.stringify({ workflow, input }),
    });
  }

  /** Project-pipeline bindings: workflows attached to a specific project, with
   *  optional schedule / config. Returns { bindings, runs, workflows }. */
  getProjectPipelines(projectPath: string) {
    return this.request<{ bindings: any[]; runs: any[]; workflows: any[] }>(
      `/api/project-pipelines?project=${encodeURIComponent(projectPath)}`,
    );
  }

  /** Trigger a binding to run now. */
  triggerProjectPipeline(projectPath: string, projectName: string, workflowName: string, input: Record<string, string> = {}) {
    return this.request<any>('/api/project-pipelines', {
      method: 'POST',
      body: JSON.stringify({ action: 'trigger', projectPath, projectName, workflowName, input }),
    });
  }

  /** Add a workflow as a pipeline binding to a project. */
  addProjectPipeline(projectPath: string, projectName: string, workflowName: string, config: Record<string, any> = {}) {
    return this.request<any>('/api/project-pipelines', {
      method: 'POST',
      body: JSON.stringify({ action: 'add', projectPath, projectName, workflowName, config }),
    });
  }

  /** Enable/disable a binding without removing it. */
  updateProjectPipeline(projectPath: string, workflowName: string, opts: { enabled?: boolean; config?: Record<string, any> }) {
    return this.request<any>('/api/project-pipelines', {
      method: 'POST',
      body: JSON.stringify({ action: 'update', projectPath, workflowName, ...opts }),
    });
  }

  /** Remove a binding from a project. */
  removeProjectPipeline(projectPath: string, workflowName: string) {
    return this.request<any>('/api/project-pipelines', {
      method: 'POST',
      body: JSON.stringify({ action: 'remove', projectPath, workflowName }),
    });
  }

  /** List forge's user-configured doc roots and their file trees. */
  listDocs() {
    return this.request<{
      roots: string[];
      rootPaths: string[];
      tree: any[];
    }>('/api/docs');
  }


  createTask(projectName: string, prompt: string, opts?: { newSession?: boolean }) {
    return this.request<any>('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({ project: projectName, prompt, ...opts }),
    });
  }
}
