// Craft = a project-scoped mini-app: UI tab + optional API routes.
// Lives at <project>/.forge/crafts/<name>/ or in lib/builtin-crafts/<name>/.

export interface CraftManifest {
  name: string;                       // unique slug, dir name
  displayName?: string;               // tab label (default = name)
  icon?: string;                      // emoji shown in tab
  description?: string;
  version?: string;

  ui?: {
    tab?: string;                     // path to ui.tsx (default 'ui.tsx')
    showWhen?: string;                // expression: hasFile("X") | always (v2)
  };

  server?: {
    entry?: string;                   // path to server.ts (default 'server.ts')
  };

  // Source of truth — set by loader, not authored.
  __dir?: string;                     // absolute dir
  __scope?: 'builtin' | 'project';
}

export interface CraftDescriptor extends CraftManifest {
  __dir: string;
  __scope: 'builtin' | 'project';
  hasUi: boolean;
  hasServer: boolean;
}

export interface CraftRouteHandlerCtx {
  projectPath: string;
  projectName?: string;
  query: Record<string, string>;
  params: Record<string, string>;
  body?: any;
  headers: Record<string, string>;
  forge: ForgeServerApi;
}

export type CraftRouteHandler = (ctx: CraftRouteHandlerCtx) => Promise<any> | any;

export interface CraftServerDef {
  routes: Record<string, CraftRouteHandler>;  // key = "METHOD path", e.g. "GET /items"
  onLoad?: (ctx: { projectPath: string; forge: ForgeServerApi }) => Promise<void> | void;
  schedule?: string;                          // optional cron — v2
}

// Server-side helper bag passed into every handler. Keep small + stable.
export interface ForgeServerApi {
  // Project context
  project: {
    path: string;
    name?: string;
  };

  // Storage scoped to <project>/.forge/crafts/<name>/data/
  storage: {
    read<T = any>(file: string): T | null;
    write(file: string, data: any): void;
    listFiles(): string[];
  };

  // Run a shell command in the project cwd
  exec(cmd: string, opts?: { timeout?: number; input?: string }): {
    stdout: string;
    stderr: string;
    code: number;
  };

  // Spawn a Forge background task in this project
  task(opts: { prompt: string; agent?: string }): { id: string };

  // Inject text into the project's bound tmux session (auto-resolves)
  inject(text: string, opts?: { sessionName?: string }): { ok: boolean; sessionName?: string };

  // Lazy access to OpenAPI loader (when project has one configured)
  openapi(specPath: string): any | null;

  // Structured logging — visible in Forge logs
  log: (...args: any[]) => void;
}
