// Migration Cockpit types — API parity testing for legacy → new module migrations.

export type EndpointStatus = 'pending' | 'in-progress' | 'migrated' | 'tested' | 'skip' | 'defer';
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS';

export interface Endpoint {
  id: string;                        // stable hash of `${method} ${path}`
  controller: string;                // tag from OpenAPI or controller name from doc
  file?: string;                     // legacy or migrated file path
  method: HttpMethod;
  path: string;                      // raw path with `{id}` style placeholders
  status: EndpointStatus;
  expectedHttpStatus: number;        // 200 normally, 501 for stubbed
  isStubbed: boolean;
  source: string;                    // primary source (OpenAPI / doc file)
  notes?: string;
  acceptance?: string[];
  // OpenAPI cross-reference (when OpenAPI is the primary source)
  operationId?: string;
  tag?: string;
  summary?: string;
  hasResponseSchema?: boolean;
  // Migration doc cross-reference
  docFile?: string;                  // docs/migration/<X>.java.md if matched
}

export interface RunResult {
  endpointId: string;
  startedAt: string;
  durationMs: number;
  legacy: SideResult;
  next: SideResult;
  match: 'pass' | 'fail' | 'stub-ok' | 'error';
  diff?: DiffEntry[];
  errorType?: string;
  errorMessage?: string;
}

export interface SideResult {
  url: string;
  status: number;
  ok: boolean;
  bodyExcerpt?: string;
  bodyJson?: any;
  error?: string;
  durationMs: number;
}

export interface DiffEntry {
  jsonPath: string;
  legacy: any;
  next: any;
  reason: 'value' | 'missing-in-next' | 'missing-in-legacy' | 'type-mismatch';
}

export interface Failure {
  endpointId: string;
  controller: string;
  method: HttpMethod;
  path: string;
  errorType: string;                 // e.g. "http-status-mismatch", "json-diff", "exception"
  errorMessage: string;
  lastSeenAt: string;
}

export interface FailureCluster {
  errorType: string;
  count: number;
  controllers: { controller: string; failures: Failure[] }[];
}

export type DiffMode = 'exact' | 'shape' | 'both';

export interface MigrationConfig {
  legacy: { baseUrl: string };
  next: { baseUrl: string; sourceDir?: string };
  auth: {
    mode: 'skip' | 'bearer' | 'basic';
    tokenEnv?: string;
    username?: string;
    passwordEnv?: string;
  };
  ignorePaths: string[];
  healthCheck: {
    legacyTimeout: number;
    newTimeout: number;
    skipUnhealthy: boolean;
  };
  clusterMode: 'simple' | 'ai';
  diffMode: DiffMode;                // exact = compare both sides; shape = validate new against schema; both = both
  endpointSource: {
    type: 'docs' | 'openapi' | 'source-scan' | 'mixed';
    primary: string;                 // dir for per-controller docs
    fallback?: string;               // history file
    openApiSpec?: string;            // path to OpenAPI 3 JSON (preferred when set)
  };
  pathSubstitutions?: Record<string, string>; // {id} → "1" etc
}

export const DEFAULT_CONFIG: MigrationConfig = {
  legacy: { baseUrl: 'http://localhost:8080' },
  next: { baseUrl: 'http://localhost:9090' },
  auth: { mode: 'skip' },
  ignorePaths: ['$.timestamp', '$.requestId', '$.traceId'],
  healthCheck: { legacyTimeout: 2000, newTimeout: 2000, skipUnhealthy: true },
  clusterMode: 'simple',
  diffMode: 'shape',
  endpointSource: {
    type: 'mixed',
    primary: 'docs/migration',
    fallback: 'docs/lead/migration-history.md',
    openApiSpec: 'docs/fnac-rest-schema-7.6.json',
  },
  pathSubstitutions: { id: '1', dbid: '1', ip: '127.0.0.1', mac: '00:00:00:00:00:00' },
};
