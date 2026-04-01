/**
 * Plugin Types — defines the plugin system for pipeline node extensions.
 *
 * A plugin is a reusable, configurable capability that can be used as a
 * pipeline node. Plugins are declarative YAML files with config schema,
 * params schema, and actions.
 */

/** Plugin action execution type */
export type PluginActionType = 'http' | 'poll' | 'shell' | 'script';

/** Schema field definition for config/params */
export interface PluginFieldSchema {
  type: 'string' | 'number' | 'boolean' | 'secret' | 'json' | 'select';
  label?: string;
  description?: string;
  required?: boolean;
  default?: any;
  options?: string[];  // for select type
}

/** A single action a plugin can perform */
export interface PluginAction {
  /** Execution type */
  run: PluginActionType;

  // HTTP action fields
  method?: string;            // GET, POST, PUT, DELETE
  url?: string;               // URL template (supports {{config.x}}, {{params.x}})
  headers?: Record<string, string>;
  body?: string;              // body template

  // Poll action fields (extends HTTP)
  interval?: number;          // poll interval in seconds
  until?: string;             // JSONPath condition: "$.result != null"
  timeout?: number;           // max wait in seconds

  // Shell action fields
  command?: string;           // shell command template
  cwd?: string;               // working directory

  // Script action fields
  script?: string;            // path to JS/Python script
  runtime?: 'node' | 'python';

  // Output extraction
  output?: Record<string, string>;  // { fieldName: "$.json.path" or "$body" or "$stdout" }
}

/** Plugin definition (loaded from plugin.yaml) */
export interface PluginDefinition {
  id: string;
  name: string;
  icon: string;
  version: string;
  author?: string;
  description?: string;

  /** Global config — set once when installing the plugin */
  config: Record<string, PluginFieldSchema>;

  /** Per-use params — set each time the plugin is used in a pipeline node */
  params: Record<string, PluginFieldSchema>;

  /** Named actions this plugin can perform */
  actions: Record<string, PluginAction>;

  /** Default action to run if none specified */
  defaultAction?: string;
}

/** Installed plugin instance (definition + user config values) */
export interface InstalledPlugin {
  id: string;
  definition: PluginDefinition;
  config: Record<string, any>;  // user-provided config values
  installedAt: string;
  enabled: boolean;
}

/** Result of executing a plugin action */
export interface PluginActionResult {
  ok: boolean;
  output: Record<string, any>;
  rawResponse?: string;
  error?: string;
  duration?: number;
}

/** Plugin source for marketplace */
export interface PluginSource {
  id: string;
  name: string;
  icon: string;
  version: string;
  author: string;
  description: string;
  source: 'builtin' | 'local' | 'registry';
  installed: boolean;
}
