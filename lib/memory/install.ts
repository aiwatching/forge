#!/usr/bin/env tsx
/**
 * Install forge-memory MCP into a project's Claude Code config.
 *
 * Usage: pnpm tsx lib/memory/install.ts [project-path]
 *
 * Writes to <project>/.claude/settings.local.json
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const projectPath = resolve(process.argv[2] || process.cwd());
const forgeRoot = resolve(import.meta.dirname, '../..');
const serverScript = join(forgeRoot, 'lib/memory/memory-mcp-server.ts');

if (!existsSync(projectPath)) {
  console.error(`Project not found: ${projectPath}`);
  process.exit(1);
}

const claudeDir = join(projectPath, '.claude');
const settingsFile = join(claudeDir, 'settings.local.json');

// Load existing settings
let settings: any = {};
if (existsSync(settingsFile)) {
  try { settings = JSON.parse(readFileSync(settingsFile, 'utf-8')); } catch {}
}

// Add MCP server config
if (!settings.mcpServers) settings.mcpServers = {};
settings.mcpServers['forge-memory'] = {
  command: 'npx',
  args: ['tsx', serverScript, projectPath],
  env: { FORGE_MEMORY_PROJECT: projectPath },
};

// Write settings
mkdirSync(claudeDir, { recursive: true });
writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n');

console.log(`✅ forge-memory MCP installed for: ${projectPath}`);
console.log(`   Config: ${settingsFile}`);
console.log(`   Server: ${serverScript}`);
console.log(`\n   Claude Code will now have these tools:`);
console.log(`   - search_code(query)         — find related code via AST`);
console.log(`   - get_file_context(file)     — get dependencies + knowledge`);
console.log(`   - remember(title, content)   — store knowledge`);
console.log(`   - recall(query)              — retrieve knowledge`);
console.log(`   - forget(id)                 — delete knowledge`);
console.log(`\n   Start Claude Code in ${projectPath} to use.`);
