import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import YAML from 'yaml';
import { encryptSecret, decryptSecret, isEncrypted, SECRET_FIELDS } from './crypto';
import { getDataDir } from './dirs';

const DATA_DIR = getDataDir();
const SETTINGS_FILE = join(DATA_DIR, 'settings.yaml');

export interface Settings {
  projectRoots: string[];       // Multiple project directories
  docRoots: string[];           // Markdown document directories (e.g. Obsidian vaults)
  claudePath: string;           // Path to claude binary
  claudeHome: string;           // Claude Code home directory (default: ~/.claude)
  telegramBotToken: string;     // Telegram Bot API token
  telegramChatId: string;       // Telegram chat ID to send notifications to
  notifyOnComplete: boolean;    // Notify when task completes
  notifyOnFailure: boolean;     // Notify when task fails
  tunnelAutoStart: boolean;     // Auto-start Cloudflare Tunnel on startup
  telegramTunnelPassword: string; // Admin password (encrypted) — for login, tunnel, secrets, Telegram
  taskModel: string;              // Model for tasks (default: sonnet)
  pipelineModel: string;          // Model for pipelines (default: sonnet)
  telegramModel: string;          // Model for Telegram AI features (default: sonnet)
  skipPermissions: boolean;       // Add --dangerously-skip-permissions to all claude invocations
  notificationRetentionDays: number; // Auto-cleanup notifications older than N days
  skillsRepoUrl: string;              // GitHub raw URL for skills registry
  displayName: string;                  // User display name (shown in header)
  displayEmail: string;                 // User email (for session/future integrations)
  favoriteProjects: string[];           // Favorite project paths (shown at top of sidebar)
  defaultAgent: string;                  // Default agent ID (e.g., 'claude', 'codex', 'aider')
  agents: Record<string, { path?: string; name?: string; enabled?: boolean; flags?: string[]; taskFlags?: string; interactiveCmd?: string; resumeFlag?: string; outputFormat?: string; model?: string }>;
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
  notificationRetentionDays: 30,
  skillsRepoUrl: 'https://raw.githubusercontent.com/aiwatching/forge-skills/main',
  displayName: 'Forge',
  displayEmail: '',
  favoriteProjects: [],
  defaultAgent: 'claude',
  agents: {},
};

/** Load settings with secrets decrypted (for internal use) */
export function loadSettings(): Settings {
  if (!existsSync(SETTINGS_FILE)) return { ...defaults };
  try {
    const raw = readFileSync(SETTINGS_FILE, 'utf-8');
    const parsed = { ...defaults, ...YAML.parse(raw) };
    // Decrypt secret fields
    for (const field of SECRET_FIELDS) {
      if (parsed[field] && isEncrypted(parsed[field])) {
        parsed[field] = decryptSecret(parsed[field]);
      }
    }
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
  return { ...settings, _secretStatus: status };
}

/** Save settings, encrypting secret fields */
export function saveSettings(settings: Settings) {
  const dir = dirname(SETTINGS_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  // Encrypt secret fields before saving
  const toSave = { ...settings };
  for (const field of SECRET_FIELDS) {
    if (toSave[field] && !isEncrypted(toSave[field])) {
      toSave[field] = encryptSecret(toSave[field]);
    }
  }
  writeFileSync(SETTINGS_FILE, YAML.stringify(toSave), 'utf-8');
}

/** Verify a secret field's current value */
export function verifySecret(field: string, value: string): boolean {
  const settings = loadSettings();
  const current = (settings as any)[field] || '';
  return current === value;
}
