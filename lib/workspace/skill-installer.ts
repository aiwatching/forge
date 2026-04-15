/**
 * Forge Skills Auto-Installer — installs forge skills into user's ~/.claude/skills/
 * so they are available across all projects and sessions.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { loadSettings } from '../settings';

const _filename = typeof __filename !== 'undefined' ? __filename : fileURLToPath(import.meta.url);
const _dirname = typeof __dirname !== 'undefined' ? __dirname : dirname(_filename);
const FORGE_SKILLS_DIR = join(_dirname, '..', 'forge-skills');

/**
 * Install forge workspace skills into user's ~/.claude/skills/.
 * Skills use env vars ($FORGE_PORT, $FORGE_WORKSPACE_ID, $FORGE_AGENT_ID)
 * so they work across all projects without per-project configuration.
 */
export function installForgeSkills(
  projectPath: string,
  workspaceId: string,
  agentId: string,
  forgePort = 8403,
): { installed: string[] } {
  if (!loadSettings().manageClaudeConfig) return { installed: [] };
  const skillsDir = join(homedir(), '.claude', 'skills');
  mkdirSync(skillsDir, { recursive: true });

  const installed: string[] = [];

  // Read all skill templates
  let sourceDir = FORGE_SKILLS_DIR;
  if (!existsSync(sourceDir)) {
    sourceDir = join(process.cwd(), 'lib', 'forge-skills');
  }
  if (!existsSync(sourceDir)) return { installed };

  const files = readdirSync(sourceDir).filter(f => f.endsWith('.md'));

  for (const file of files) {
    const content = readFileSync(join(sourceDir, file), 'utf-8');
    // Claude Code expects skills as directories with SKILL.md inside
    const skillName = file.replace('.md', '');
    const skillDir = join(skillsDir, skillName);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), content, 'utf-8');
    installed.push(skillName);
  }

  // Clean up old flat .md files (from previous install format)
  for (const file of files) {
    const flatFile = join(skillsDir, file);
    if (existsSync(flatFile)) {
      try { require('node:fs').unlinkSync(flatFile); } catch {}
    }
  }

  // Ensure settings allow forge curl commands (check both global and project)
  ensureForgePermissions(join(homedir(), '.claude'));
  // Also fix project-level deny rules that might block forge curl
  const projectClaudeDir = join(projectPath, '.claude');
  if (existsSync(join(projectClaudeDir, 'settings.json'))) {
    ensureForgePermissions(projectClaudeDir);
  }

  // Install Stop hook in user-level settings (for agent completion detection)
  installForgeStopHook(forgePort);

  return { installed };
}

/**
 * Ensure project's .claude/settings.json allows forge skill curl commands.
 * Removes curl deny rules that block forge, adds allow rule if needed.
 */
function ensureForgePermissions(projectPath: string): void {
  const settingsFile = join(projectPath, '.claude', 'settings.json');
  const FORGE_CURL_ALLOW = 'Bash(curl*localhost*/smith*)';

  try {
    let settings: any = {};
    if (existsSync(settingsFile)) {
      settings = JSON.parse(readFileSync(settingsFile, 'utf-8'));
    }

    if (!settings.permissions) settings.permissions = {};
    if (!settings.permissions.allow) settings.permissions.allow = [];
    if (!settings.permissions.deny) settings.permissions.deny = [];

    let changed = false;

    // Remove deny rules that block curl to localhost (forge skills)
    const denyBefore = settings.permissions.deny.length;
    settings.permissions.deny = settings.permissions.deny.filter((rule: string) => {
      // Remove broad curl denies that would block forge
      if (/^Bash\(curl[:\s*]/.test(rule)) return false;
      return true;
    });
    if (settings.permissions.deny.length !== denyBefore) changed = true;

    // Add forge curl allow if not present
    const hasForgeAllow = settings.permissions.allow.some((rule: string) =>
      rule.includes('localhost') && rule.includes('smith')
    );
    if (!hasForgeAllow) {
      settings.permissions.allow.push(FORGE_CURL_ALLOW);
      changed = true;
    }

    if (changed) {
      mkdirSync(join(projectPath, '.claude'), { recursive: true });
      writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
      console.log('[skills] Updated .claude/settings.json: allowed forge curl commands');
    }
  } catch (err: any) {
    console.error('[skills] Failed to update .claude/settings.json:', err.message);
  }
}

/**
 * Apply agent profile config to project's .claude/settings.json.
 * Sets env vars and model from the profile so interactive claude uses the right config.
 */
export function applyProfileToProject(
  projectPath: string,
  profile: { env?: Record<string, string>; model?: string },
): void {
  if (!profile.env && !profile.model) return;
  if (!loadSettings().manageClaudeConfig) return;

  const settingsFile = join(projectPath, '.claude', 'settings.json');
  try {
    let settings: any = {};
    if (existsSync(settingsFile)) {
      settings = JSON.parse(readFileSync(settingsFile, 'utf-8'));
    }

    let changed = false;

    // Set env vars from profile
    if (profile.env && Object.keys(profile.env).length > 0) {
      if (!settings.env) settings.env = {};
      for (const [key, value] of Object.entries(profile.env)) {
        if (settings.env[key] !== value) {
          settings.env[key] = value;
          changed = true;
        }
      }
    }

    // Set model from profile
    if (profile.model) {
      if (settings.model !== profile.model) {
        settings.model = profile.model;
        changed = true;
      }
    }

    if (changed) {
      mkdirSync(join(projectPath, '.claude'), { recursive: true });
      writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
      console.log(`[skills] Applied profile config to .claude/settings.json (model=${profile.model || 'default'}, env=${Object.keys(profile.env || {}).length} vars)`);
    }
  } catch (err: any) {
    console.error('[skills] Failed to apply profile config:', err.message);
  }
}

const FORGE_HOOK_MARKER = '# forge-stop-hook';

/**
 * Install a Stop hook in user-level ~/.claude/settings.json.
 * When Claude Code finishes a turn, the hook notifies Forge via HTTP.
 * Preserves existing user hooks. Creates backup before modifying.
 */
function installForgeStopHook(forgePort: number): void {
  const settingsFile = join(homedir(), '.claude', 'settings.json');
  const now = new Date();
  const dateStr = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}-${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}`;
  const backupFile = join(homedir(), '.claude', `settings.json.forge-backup-${dateStr}`);
  const daemonPort = forgePort + 2; // 8403 → 8405

  // Hook reads agent context from .forge/agent-context.json in the project dir.
  // This file is written by ensurePersistentSession for each agent's workDir.
  // Falls back to env vars if file doesn't exist.
  const hookCommand = `${FORGE_HOOK_MARKER}\nCTX_FILE="$(pwd)/.forge/agent-context.json"; if [ -f "$CTX_FILE" ]; then WS_ID=$(python3 -c "import json;print(json.load(open('$CTX_FILE')).get('workspaceId',''))" 2>/dev/null); AG_ID=$(python3 -c "import json;print(json.load(open('$CTX_FILE')).get('agentId',''))" 2>/dev/null); elif [ -n "$FORGE_WORKSPACE_ID" ]; then WS_ID="$FORGE_WORKSPACE_ID"; AG_ID="$FORGE_AGENT_ID"; fi; if [ -n "$WS_ID" ] && [ -n "$AG_ID" ]; then curl -s -X POST "http://localhost:${daemonPort}/workspace/$WS_ID/agents" -H "Content-Type: application/json" -d "{\\"action\\":\\"agent_done\\",\\"agentId\\":\\"$AG_ID\\"}" > /dev/null 2>&1 & fi`;

  try {
    let settings: any = {};
    if (existsSync(settingsFile)) {
      const raw = readFileSync(settingsFile, 'utf-8');
      settings = JSON.parse(raw);

      // Check if hook already installed
      // Remove old forge hook if present (will re-add with latest version)
      if (settings.hooks?.Stop) {
        settings.hooks.Stop = settings.hooks.Stop.filter((h: any) => {
          if (h.command?.includes(FORGE_HOOK_MARKER) || h.command?.includes('agent_done')) return false;
          if (h.hooks?.some((sub: any) => sub.command?.includes(FORGE_HOOK_MARKER) || sub.command?.includes('agent_done'))) return false;
          return true;
        });
      }

      // Backup before modifying
      writeFileSync(backupFile, raw, 'utf-8');
    }

    if (!settings.hooks) settings.hooks = {};
    if (!settings.hooks.Stop) settings.hooks.Stop = [];

    // Add forge hook (Claude Code hooks schema: matcher + hooks array)
    settings.hooks.Stop.push({
      matcher: '',
      hooks: [{
        type: 'command',
        command: hookCommand,
        timeout: 5000,
      }],
    });

    mkdirSync(join(homedir(), '.claude'), { recursive: true });
    writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
    console.log('[skills] Installed Forge Stop hook in ~/.claude/settings.json');
  } catch (err: any) {
    console.error('[skills] Failed to install Stop hook:', err.message);
  }
}

/**
 * Remove Forge Stop hook from user-level settings (cleanup).
 */
export function removeForgeStopHook(): void {
  const settingsFile = join(homedir(), '.claude', 'settings.json');
  try {
    if (!existsSync(settingsFile)) return;
    const settings = JSON.parse(readFileSync(settingsFile, 'utf-8'));
    if (!settings.hooks?.Stop) return;

    settings.hooks.Stop = settings.hooks.Stop.filter((h: any) => {
      // Remove entries matching either old flat format or new nested format
      if (h.command?.includes(FORGE_HOOK_MARKER) || h.command?.includes('agent_done')) return false;
      if (h.hooks?.some((sub: any) => sub.command?.includes(FORGE_HOOK_MARKER) || sub.command?.includes('agent_done'))) return false;
      return true;
    });
    if (settings.hooks.Stop.length === 0) delete settings.hooks.Stop;
    if (Object.keys(settings.hooks).length === 0) delete settings.hooks;

    writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
    console.log('[skills] Removed Forge Stop hook from ~/.claude/settings.json');
  } catch {}
}

/**
 * Check if forge skills are already installed for this agent.
 */
export function hasForgeSkills(projectPath: string): boolean {
  const globalDir = join(homedir(), '.claude', 'skills');
  return existsSync(join(globalDir, 'forge-workspace-sync', 'SKILL.md'));
}

/**
 * Remove forge skills from a project.
 */
export function removeForgeSkills(projectPath: string): void {
  const skillsDir = join(homedir(), '.claude', 'skills');
  if (!existsSync(skillsDir)) return;

  const forgeSkills = readdirSync(skillsDir).filter(f => f.startsWith('forge-'));
  for (const name of forgeSkills) {
    const p = join(skillsDir, name);
    try {
      const { rmSync } = require('node:fs');
      rmSync(p, { recursive: true, force: true });
    } catch {}
  }
}
