import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import type { AppConfig, ProviderName, SessionTemplate } from '@/src/types';
import { getConfigDir as _getConfigDir, getDataDir as _getDataDir } from '@/lib/dirs';

const CONFIG_DIR = _getConfigDir();
const CONFIG_FILE = join(CONFIG_DIR, 'config.yaml');
const TEMPLATES_DIR = join(CONFIG_DIR, 'templates');

export function getConfigDir(): string {
  return CONFIG_DIR;
}

export function getDataDir(): string {
  return _getDataDir();
}

export function getDbPath(): string {
  return join(getDataDir(), 'workflow.db');
}

export function ensureDirs() {
  for (const dir of [CONFIG_DIR, getDataDir()]) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }
}

export function loadConfig(): AppConfig {
  ensureDirs();

  if (!existsSync(CONFIG_FILE)) {
    // Don't auto-create config.yaml — return defaults in memory only
    return getDefaultConfig();
  }

  const raw = readFileSync(CONFIG_FILE, 'utf-8');
  return YAML.parse(raw) as AppConfig;
}

export function saveConfig(config: AppConfig) {
  ensureDirs();
  writeFileSync(CONFIG_FILE, YAML.stringify(config), 'utf-8');
}

export function loadTemplate(templateId: string): SessionTemplate | null {
  const filePath = join(TEMPLATES_DIR, `${templateId}.yaml`);
  if (!existsSync(filePath)) return null;
  const raw = readFileSync(filePath, 'utf-8');
  return YAML.parse(raw) as SessionTemplate;
}

export function loadAllTemplates(): SessionTemplate[] {
  ensureDirs();
  const files = readdirSync(TEMPLATES_DIR).filter(f => f.endsWith('.yaml'));
  return files.map(f => {
    const raw = readFileSync(join(TEMPLATES_DIR, f), 'utf-8');
    return YAML.parse(raw) as SessionTemplate;
  });
}

export function saveTemplate(template: SessionTemplate) {
  ensureDirs();
  const filePath = join(TEMPLATES_DIR, `${template.id}.yaml`);
  writeFileSync(filePath, YAML.stringify(template), 'utf-8');
}

function getDefaultConfig(): AppConfig {
  return {
    dataDir: getDataDir(),
    providers: {
      anthropic: {
        name: 'anthropic',
        displayName: 'Claude',
        defaultModel: 'claude-sonnet-4-6',
        models: ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'],
        enabled: true,
      },
      google: {
        name: 'google',
        displayName: 'Gemini',
        defaultModel: 'gemini-2.0-flash',
        models: ['gemini-2.5-pro', 'gemini-2.0-flash', 'gemini-2.0-flash-lite'],
        enabled: true,
      },
      openai: {
        name: 'openai',
        displayName: 'OpenAI',
        defaultModel: 'gpt-4o-mini',
        models: ['gpt-4o', 'gpt-4o-mini', 'o3-mini'],
        enabled: false,
      },
      grok: {
        name: 'grok',
        displayName: 'Grok',
        defaultModel: 'grok-3-mini-fast',
        models: ['grok-3', 'grok-3-mini-fast'],
        enabled: false,
      },
    },
    server: {
      host: '0.0.0.0',
      port: 8403,
    },
  };
}

export function getProviderApiKey(provider: ProviderName, profileApiKey?: string): string | undefined {
  // Priority: profile-level key > settings provider key > env var
  if (profileApiKey) return profileApiKey;

  try {
    const { loadSettings } = require('@/lib/settings');
    const settings = loadSettings();
    if (settings.providers?.[provider]?.apiKey) {
      return settings.providers[provider].apiKey;
    }
  } catch {}

  const envMap: Record<ProviderName, string> = {
    anthropic: 'ANTHROPIC_API_KEY',
    google: 'GOOGLE_GENERATIVE_AI_API_KEY',
    openai: 'OPENAI_API_KEY',
    grok: 'XAI_API_KEY',
  };
  return process.env[envMap[provider]];
}
