/**
 * Forge Skills Auto-Installer — installs forge skills into project's .claude/skills/
 * when a workspace is created or agent switches to manual mode.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const FORGE_SKILLS_DIR = join(__dirname, '..', 'forge-skills');

/**
 * Install forge workspace skills into a project.
 * Replaces template variables with actual workspace/agent IDs.
 */
export function installForgeSkills(
  projectPath: string,
  workspaceId: string,
  agentId: string,
  forgePort = 8403,
): { installed: string[] } {
  const skillsDir = join(projectPath, '.claude', 'skills');
  mkdirSync(skillsDir, { recursive: true });

  const installed: string[] = [];

  // Read all skill templates
  let sourceDir = FORGE_SKILLS_DIR;
  if (!existsSync(sourceDir)) {
    // Fallback: try relative to cwd
    sourceDir = join(process.cwd(), 'lib', 'forge-skills');
  }
  if (!existsSync(sourceDir)) return { installed };

  const files = readdirSync(sourceDir).filter(f => f.endsWith('.md'));

  for (const file of files) {
    const template = readFileSync(join(sourceDir, file), 'utf-8');

    // Replace template variables
    const content = template
      .replace(/\{\{FORGE_PORT\}\}/g, String(forgePort))
      .replace(/\{\{WORKSPACE_ID\}\}/g, workspaceId)
      .replace(/\{\{AGENT_ID\}\}/g, agentId);

    const targetFile = join(skillsDir, file);
    writeFileSync(targetFile, content, 'utf-8');
    installed.push(file);
  }

  return { installed };
}

/**
 * Check if forge skills are already installed for this agent.
 */
export function hasForgeSkills(projectPath: string): boolean {
  const skillsDir = join(projectPath, '.claude', 'skills');
  if (!existsSync(skillsDir)) return false;
  return existsSync(join(skillsDir, 'forge-workspace-sync.md'));
}

/**
 * Remove forge skills from a project.
 */
export function removeForgeSkills(projectPath: string): void {
  const skillsDir = join(projectPath, '.claude', 'skills');
  if (!existsSync(skillsDir)) return;

  const forgeFiles = readdirSync(skillsDir).filter(f => f.startsWith('forge-'));
  for (const file of forgeFiles) {
    try {
      const { unlinkSync } = require('node:fs');
      unlinkSync(join(skillsDir, file));
    } catch {}
  }
}
