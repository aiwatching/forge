import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import YAML from 'yaml';
import { encryptSecret, decryptSecret, isEncrypted, SECRET_FIELDS } from './crypto';
import { getDataDir } from './dirs';

const DATA_DIR = getDataDir();
const SETTINGS_FILE = join(DATA_DIR, 'settings.yaml');

export interface AgentEntry {
  // Base agent fields (for detected agents like claude, codex, aider)
  path?: string; name?: string; enabled?: boolean;
  flags?: string[]; taskFlags?: string; interactiveCmd?: string; resumeFlag?: string; outputFormat?: string;
  models?: { terminal?: string; task?: string; telegram?: string; help?: string; mobile?: string };
  skipPermissionsFlag?: string;
  requiresTTY?: boolean;
  // Profile fields (for profiles that extend a base agent)
  base?: string;                 // base agent ID (e.g., 'claude') — makes this a profile
  // API profile fields
  type?: 'cli' | 'api';         // 'api' = API mode, default = 'cli'
  provider?: string;             // API provider (e.g., 'anthropic', 'google')
  model?: string;                // model override (for both CLI and API profiles)
  apiKey?: string;               // per-profile API key (encrypted)
  env?: Record<string, string>;  // environment variables injected when spawning CLI
  cliType?: 'claude-code' | 'codex' | 'aider' | 'generic'; // CLI tool type — determines session support, resume flags, etc.
  profile?: string;              // linked profile ID — overrides model, env, etc. when launching
}

export interface ProviderEntry {
  apiKey?: string;               // encrypted, fallback to env var
  defaultModel?: string;
  enabled?: boolean;
}

export interface Settings {
  projectRoots: string[];
  docRoots: string[];
  claudePath: string;
  claudeHome: string;
  telegramBotToken: string;
  telegramChatId: string;
  notifyOnComplete: boolean;
  notifyOnFailure: boolean;
  tunnelAutoStart: boolean;
  telegramTunnelPassword: string;
  taskModel: string;
  pipelineModel: string;
  telegramModel: string;
  skipPermissions: boolean;
  manageClaudeConfig: boolean;
  notificationRetentionDays: number;
  skillsRepoUrl: string;
  displayName: string;
  displayEmail: string;
  favoriteProjects: string[];
  defaultAgent: string;
  telegramAgent: string;
  docsAgent: string;
  agents: Record<string, AgentEntry>;
  providers: Record<string, ProviderEntry>;  // API provider configs
}

const defaults: Settings = {
  projectRoots: [],
  docRoots: [],
  claudePath: '',
  claudeHome: '',
  telegramBotToken: '',
  telegramChatId: '',
  notifyOnComplete: true,
  notifyOnFailure: true,
  tunnelAutoStart: false,
  telegramTunnelPassword: '',
  taskModel: 'default',
  pipelineModel: 'default',
  telegramModel: 'sonnet',
  skipPermissions: false,
  manageClaudeConfig: true,
  notificationRetentionDays: 30,
  skillsRepoUrl: 'https://raw.githubusercontent.com/aiwatching/forge-skills/main',
  displayName: 'Forge',
  displayEmail: '',
  favoriteProjects: [],
  defaultAgent: 'claude',
  telegramAgent: '',
  docsAgent: '',
  agents: {},
  providers: {},
};

/** Decrypt nested apiKey fields in agents and providers */
function decryptNestedSecrets(settings: Settings): void {
  // Decrypt provider apiKeys
  if (settings.providers) {
    for (const p of Object.values(settings.providers)) {
      if (p.apiKey && isEncrypted(p.apiKey)) {
        p.apiKey = decryptSecret(p.apiKey);
      }
    }
  }
  // Decrypt agent profile apiKeys
  if (settings.agents) {
    for (const a of Object.values(settings.agents)) {
      if (a.apiKey && isEncrypted(a.apiKey)) {
        a.apiKey = decryptSecret(a.apiKey);
      }
    }
  }
}

/** Encrypt nested apiKey fields in agents and providers */
function encryptNestedSecrets(settings: Settings): void {
  if (settings.providers) {
    for (const p of Object.values(settings.providers)) {
      if (p.apiKey && !isEncrypted(p.apiKey)) {
        p.apiKey = encryptSecret(p.apiKey);
      }
    }
  }
  if (settings.agents) {
    for (const a of Object.values(settings.agents)) {
      if (a.apiKey && !isEncrypted(a.apiKey)) {
        a.apiKey = encryptSecret(a.apiKey);
      }
    }
  }
}

/** Load settings with secrets decrypted (for internal use) */
export function loadSettings(): Settings {
  if (!existsSync(SETTINGS_FILE)) return { ...defaults };
  try {
    const raw = readFileSync(SETTINGS_FILE, 'utf-8');
    const parsed = { ...defaults, ...YAML.parse(raw) };
    // Decrypt top-level secret fields
    for (const field of SECRET_FIELDS) {
      if (parsed[field] && isEncrypted(parsed[field])) {
        parsed[field] = decryptSecret(parsed[field]);
      }
    }
    // Decrypt nested apiKeys
    decryptNestedSecrets(parsed);
    return parsed;
  } catch {
    return { ...defaults };
  }
}

/** Load settings with secrets masked (for API response to frontend) */
export function loadSettingsMasked(): Settings & { _secretStatus: Record<string, boolean> } {
  const settings = loadSettings();
  const status: Record<string, boolean> = {};
  for (const field of SECRET_FIELDS) {
    status[field] = !!settings[field];
    settings[field] = settings[field] ? '••••••••' : '';
  }
  // Mask nested apiKeys
  if (settings.providers) {
    for (const [name, p] of Object.entries(settings.providers)) {
      status[`providers.${name}.apiKey`] = !!p.apiKey;
      p.apiKey = p.apiKey ? '••••••••' : '';
    }
  }
  if (settings.agents) {
    for (const [name, a] of Object.entries(settings.agents)) {
      if (a.apiKey) {
        status[`agents.${name}.apiKey`] = true;
        a.apiKey = '••••••••';
      }
    }
  }
  return { ...settings, _secretStatus: status };
}

/** Save settings, encrypting secret fields */
export function saveSettings(settings: Settings) {
  const dir = dirname(SETTINGS_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  // Deep copy to avoid mutating original
  const toSave = JSON.parse(JSON.stringify(settings));
  // Encrypt top-level secret fields
  for (const field of SECRET_FIELDS) {
    if (toSave[field] && !isEncrypted(toSave[field])) {
      toSave[field] = encryptSecret(toSave[field]);
    }
  }
  // Encrypt nested apiKeys
  encryptNestedSecrets(toSave);
  writeFileSync(SETTINGS_FILE, YAML.stringify(toSave), 'utf-8');
}

/** Verify a secret field's current value */
export function verifySecret(field: string, value: string): boolean {
  const settings = loadSettings();
  const current = (settings as any)[field] || '';
  return current === value;
}
