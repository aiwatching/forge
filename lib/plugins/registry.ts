/**
 * Plugin Registry — load, install, uninstall, list plugins.
 *
 * Plugins are stored as YAML files:
 * - Built-in: lib/builtin-plugins/*.yaml
 * - User-installed: ~/.forge/plugins/<id>/plugin.yaml
 *
 * Installed plugin configs are stored in:
 * - ~/.forge/data/plugin-configs.json
 */

import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import type { PluginDefinition, InstalledPlugin, PluginSource } from './types';

const _filename = typeof __filename !== 'undefined' ? __filename : fileURLToPath(import.meta.url);
const _dirname = typeof __dirname !== 'undefined' ? __dirname : dirname(_filename);

const BUILTIN_DIR_COMPILED = join(_dirname, '..', 'builtin-plugins');
const BUILTIN_DIR_SOURCE = join(process.cwd(), 'lib', 'builtin-plugins');
const BUILTIN_DIR = existsSync(BUILTIN_DIR_COMPILED) ? BUILTIN_DIR_COMPILED : BUILTIN_DIR_SOURCE;
const USER_PLUGINS_DIR = join(homedir(), '.forge', 'plugins');
const CONFIGS_FILE = join(homedir(), '.forge', 'data', 'plugin-configs.json');

// ─── Load Plugin Definition ──────────────────────────────

function loadPluginYaml(filePath: string): PluginDefinition | null {
  try {
    const raw = readFileSync(filePath, 'utf-8');
    const def = YAML.parse(raw) as PluginDefinition;
    if (!def.id || !def.name || !def.actions) return null;
    // Defaults
    if (!def.config) def.config = {};
    if (!def.params) def.params = {};
    if (!def.icon) def.icon = '🔌';
    if (!def.version) def.version = '0.0.1';
    return def;
  } catch {
    return null;
  }
}

// ─── Config Storage ──────────────────────────────────────

function loadConfigs(): Record<string, { config: Record<string, any>; installedAt: string; enabled: boolean }> {
  try {
    if (existsSync(CONFIGS_FILE)) {
      return JSON.parse(readFileSync(CONFIGS_FILE, 'utf-8'));
    }
  } catch {}
  return {};
}

function saveConfigs(configs: Record<string, any>): void {
  const dir = dirname(CONFIGS_FILE);
  mkdirSync(dir, { recursive: true });
  writeFileSync(CONFIGS_FILE, JSON.stringify(configs, null, 2));
}

// ─── Public API ──────────────────────────────────────────

/** List all available plugins (built-in + user-installed) */
export function listPlugins(): PluginSource[] {
  const sources: PluginSource[] = [];
  const configs = loadConfigs();

  // Built-in plugins
  if (existsSync(BUILTIN_DIR)) {
    for (const file of readdirSync(BUILTIN_DIR).filter(f => f.endsWith('.yaml') || f.endsWith('.yml'))) {
      const def = loadPluginYaml(join(BUILTIN_DIR, file));
      if (def) {
        sources.push({
          id: def.id,
          name: def.name,
          icon: def.icon,
          version: def.version,
          author: def.author || 'forge',
          description: def.description || '',
          source: 'builtin',
          installed: !!configs[def.id],
        });
      }
    }
  }

  // User-installed plugins
  mkdirSync(USER_PLUGINS_DIR, { recursive: true });
  for (const dir of readdirSync(USER_PLUGINS_DIR, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const yamlPath = join(USER_PLUGINS_DIR, dir.name, 'plugin.yaml');
    const ymlPath = join(USER_PLUGINS_DIR, dir.name, 'plugin.yml');
    const filePath = existsSync(yamlPath) ? yamlPath : existsSync(ymlPath) ? ymlPath : null;
    if (!filePath) continue;
    const def = loadPluginYaml(filePath);
    if (def) {
      // Don't duplicate if also built-in
      if (sources.some(s => s.id === def.id)) continue;
      sources.push({
        id: def.id,
        name: def.name,
        icon: def.icon,
        version: def.version,
        author: def.author || 'local',
        description: def.description || '',
        source: 'local',
        installed: !!configs[def.id],
      });
    }
  }

  return sources;
}

/** Get a plugin definition by ID */
export function getPlugin(id: string): PluginDefinition | null {
  // Check built-in first
  if (existsSync(BUILTIN_DIR)) {
    for (const file of readdirSync(BUILTIN_DIR).filter(f => f.endsWith('.yaml') || f.endsWith('.yml'))) {
      const def = loadPluginYaml(join(BUILTIN_DIR, file));
      if (def?.id === id) return def;
    }
  }

  // Check user plugins
  const yamlPath = join(USER_PLUGINS_DIR, id, 'plugin.yaml');
  const ymlPath = join(USER_PLUGINS_DIR, id, 'plugin.yml');
  if (existsSync(yamlPath)) return loadPluginYaml(yamlPath);
  if (existsSync(ymlPath)) return loadPluginYaml(ymlPath);

  return null;
}

/** Get an installed plugin with its config */
export function getInstalledPlugin(id: string): InstalledPlugin | null {
  const def = getPlugin(id);
  if (!def) return null;
  const configs = loadConfigs();
  const cfg = configs[id];
  if (!cfg) return null;
  return {
    id,
    definition: def,
    config: cfg.config || {},
    installedAt: cfg.installedAt || new Date().toISOString(),
    enabled: cfg.enabled !== false,
  };
}

/** List all installed plugins */
export function listInstalledPlugins(): InstalledPlugin[] {
  const configs = loadConfigs();
  const installed: InstalledPlugin[] = [];
  for (const [id, cfg] of Object.entries(configs)) {
    const def = getPlugin(id);
    if (def) {
      installed.push({
        id,
        definition: def,
        config: (cfg as any).config || {},
        installedAt: (cfg as any).installedAt || '',
        enabled: (cfg as any).enabled !== false,
      });
    }
  }
  return installed;
}

/** Install a plugin (save config) */
export function installPlugin(id: string, config: Record<string, any>): boolean {
  const def = getPlugin(id);
  if (!def) return false;
  const configs = loadConfigs();
  configs[id] = { config, installedAt: new Date().toISOString(), enabled: true };
  saveConfigs(configs);
  console.log(`[plugins] Installed: ${def.name} (${id})`);
  return true;
}

/** Uninstall a plugin (remove config, keep definition files) */
export function uninstallPlugin(id: string): boolean {
  const configs = loadConfigs();
  if (!configs[id]) return false;
  delete configs[id];
  saveConfigs(configs);
  console.log(`[plugins] Uninstalled: ${id}`);
  return true;
}

/** Update plugin config */
export function updatePluginConfig(id: string, config: Record<string, any>): boolean {
  const configs = loadConfigs();
  if (!configs[id]) return false;
  (configs[id] as any).config = config;
  saveConfigs(configs);
  return true;
}

/** Enable/disable a plugin */
export function setPluginEnabled(id: string, enabled: boolean): boolean {
  const configs = loadConfigs();
  if (!configs[id]) return false;
  (configs[id] as any).enabled = enabled;
  saveConfigs(configs);
  return true;
}
