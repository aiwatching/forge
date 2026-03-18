import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import YAML from 'yaml';

const DATA_DIR = process.env.FORGE_DATA_DIR || join(homedir(), '.forge');
const SETTINGS_FILE = join(DATA_DIR, 'settings.yaml');

export interface Settings {
  projectRoots: string[];       // Multiple project directories
  docRoots: string[];           // Markdown document directories (e.g. Obsidian vaults)
  claudePath: string;           // Path to claude binary
  telegramBotToken: string;     // Telegram Bot API token
  telegramChatId: string;       // Telegram chat ID to send notifications to
  notifyOnComplete: boolean;    // Notify when task completes
  notifyOnFailure: boolean;     // Notify when task fails
  tunnelAutoStart: boolean;     // Auto-start Cloudflare Tunnel on startup
  telegramTunnelPassword: string; // Password for getting login password via Telegram
  taskModel: string;              // Model for tasks (default: sonnet)
  pipelineModel: string;          // Model for pipelines (default: sonnet)
  telegramModel: string;          // Model for Telegram AI features (default: sonnet)
  skipPermissions: boolean;       // Add --dangerously-skip-permissions to all claude invocations
}

const defaults: Settings = {
  projectRoots: [],
  docRoots: [],
  claudePath: '',
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
};

export function loadSettings(): Settings {
  if (!existsSync(SETTINGS_FILE)) return { ...defaults };
  try {
    const raw = readFileSync(SETTINGS_FILE, 'utf-8');
    return { ...defaults, ...YAML.parse(raw) };
  } catch {
    return { ...defaults };
  }
}

export function saveSettings(settings: Settings) {
  const dir = dirname(SETTINGS_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(SETTINGS_FILE, YAML.stringify(settings), 'utf-8');
}
