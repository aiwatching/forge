/**
 * Verification script — compares direct JSONL scanning with DB scanner results.
 * Run: npx tsx scripts/verify-usage.ts
 */

import { readdirSync, readFileSync, statSync } from 'fs';
import { join, basename } from 'path';
import { homedir } from 'os';

const CLAUDE_DIR = join(homedir(), '.claude', 'projects');

const PRICING: Record<string, { input: number; output: number }> = {
  'claude-opus-4': { input: 15, output: 75 },
  'claude-sonnet-4': { input: 3, output: 15 },
  'claude-haiku-4': { input: 0.80, output: 4 },
  'default': { input: 3, output: 15 },
};

function getModelFamily(model: string): string {
  if (!model) return 'unknown';
  if (model.includes('opus')) return 'claude-opus-4';
  if (model.includes('haiku')) return 'claude-haiku-4';
  if (model.includes('sonnet')) return 'claude-sonnet-4';
  return 'unknown';
}

function calcCost(family: string, input: number, output: number, cacheRead: number, cacheCreate: number): number {
  const p = PRICING[family] || PRICING['default'];
  return (
    (input * p.input / 1_000_000) +
    (output * p.output / 1_000_000) +
    (cacheRead * p.input * 0.1 / 1_000_000) +
    (cacheCreate * p.input * 0.25 / 1_000_000)
  );
}

interface ProjectStats {
  input: number; output: number; cost: number; sessions: number; messages: number;
  cacheRead: number; cacheCreate: number;
}

interface ModelStats {
  input: number; output: number; cost: number; messages: number;
}

interface DayStats {
  input: number; output: number; cost: number;
}

const byProject: Record<string, ProjectStats> = {};
const byModel: Record<string, ModelStats> = {};
const byDay: Record<string, DayStats> = {};
let totalInput = 0, totalOutput = 0, totalCost = 0, totalSessions = 0, totalMessages = 0;

console.log('Scanning JSONL files...\n');

const projectDirs = readdirSync(CLAUDE_DIR);
let fileCount = 0;

for (const projDir of projectDirs) {
  const projPath = join(CLAUDE_DIR, projDir);
  try { if (!statSync(projPath).isDirectory()) continue; } catch { continue; }

  const projectName = projDir.replace(/^-/, '/').replace(/-/g, '/').split('/').pop() || projDir;
  const files = readdirSync(projPath).filter(f => f.endsWith('.jsonl') && !f.startsWith('agent-'));

  for (const file of files) {
    const filePath = join(projPath, file);
    fileCount++;
    let sessionInput = 0, sessionOutput = 0, sessionCost = 0, sessionMsgs = 0;

    try {
      const content = readFileSync(filePath, 'utf-8');
      for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);
          if (obj.type === 'assistant' && obj.message?.usage) {
            const u = obj.message.usage;
            const model = obj.message.model || '';
            const family = getModelFamily(model);
            const input = u.input_tokens || 0;
            const output = u.output_tokens || 0;
            const cacheRead = u.cache_read_input_tokens || 0;
            const cacheCreate = u.cache_creation_input_tokens || 0;
            const cost = calcCost(family, input, output, cacheRead, cacheCreate);

            sessionInput += input;
            sessionOutput += output;
            sessionCost += cost;
            sessionMsgs++;

            if (!byModel[family]) byModel[family] = { input: 0, output: 0, cost: 0, messages: 0 };
            byModel[family].input += input;
            byModel[family].output += output;
            byModel[family].cost += cost;
            byModel[family].messages++;

            const day = (obj.timestamp || '').slice(0, 10) || 'unknown';
            if (!byDay[day]) byDay[day] = { input: 0, output: 0, cost: 0 };
            byDay[day].input += input;
            byDay[day].output += output;
            byDay[day].cost += cost;
          }
        } catch {}
      }
    } catch { continue; }

    if (sessionMsgs > 0) {
      totalSessions++;
      totalMessages += sessionMsgs;
      totalInput += sessionInput;
      totalOutput += sessionOutput;
      totalCost += sessionCost;

      if (!byProject[projectName]) byProject[projectName] = { input: 0, output: 0, cost: 0, sessions: 0, messages: 0, cacheRead: 0, cacheCreate: 0 };
      byProject[projectName].input += sessionInput;
      byProject[projectName].output += sessionOutput;
      byProject[projectName].cost += sessionCost;
      byProject[projectName].sessions++;
      byProject[projectName].messages += sessionMsgs;
    }
  }
}

// Now run the DB scanner and compare
console.log('Running DB scanner...\n');

// Set up environment for the scanner
process.env.FORGE_DATA_DIR = process.env.FORGE_DATA_DIR || join(homedir(), '.forge', 'data');

// Dynamic import to use the actual scanner
const { scanUsage, queryUsage } = await import('../lib/usage-scanner');

const scanResult = scanUsage();
console.log(`Scan result: ${scanResult.scanned} files scanned, ${scanResult.updated} updated, ${scanResult.errors} errors\n`);

const dbData = queryUsage({});

// Compare
console.log('=== COMPARISON ===\n');

console.log('TOTAL:');
console.log(`  Direct:  ${(totalInput/1000).toFixed(0)}K in, ${(totalOutput/1000).toFixed(0)}K out, $${totalCost.toFixed(2)}, ${totalSessions} sessions, ${totalMessages} msgs`);
console.log(`  DB:      ${(dbData.total.input/1000).toFixed(0)}K in, ${(dbData.total.output/1000).toFixed(0)}K out, $${dbData.total.cost.toFixed(2)}, ${dbData.total.sessions} sessions, ${dbData.total.messages} msgs`);

const costDiff = Math.abs(totalCost - dbData.total.cost);
const costMatch = costDiff < 0.1;
console.log(`  Match:   ${costMatch ? '✅' : '❌'} (diff: $${costDiff.toFixed(2)})\n`);

console.log('BY MODEL:');
for (const [model, d] of Object.entries(byModel).sort((a, b) => b[1].cost - a[1].cost)) {
  const dbModel = dbData.byModel.find(m => m.model === model);
  const dbCost = dbModel?.cost || 0;
  const match = Math.abs(d.cost - dbCost) < 0.1;
  console.log(`  ${model.padEnd(20)} Direct: $${d.cost.toFixed(2).padStart(8)}  DB: $${dbCost.toFixed(2).padStart(8)}  ${match ? '✅' : '❌'}`);
}

console.log('\nBY PROJECT (top 10):');
const sortedProjects = Object.entries(byProject).sort((a, b) => b[1].cost - a[1].cost).slice(0, 10);
for (const [name, d] of sortedProjects) {
  const dbProj = dbData.byProject.find(p => p.name === name);
  const dbCost = dbProj?.cost || 0;
  const match = Math.abs(d.cost - dbCost) < 0.1;
  console.log(`  ${name.padEnd(25)} Direct: $${d.cost.toFixed(2).padStart(8)}  DB: $${dbCost.toFixed(2).padStart(8)}  ${match ? '✅' : '❌'}`);
}

console.log('\nBY DAY (last 7):');
const sortedDays = Object.entries(byDay).filter(([d]) => d !== 'unknown').sort((a, b) => b[0].localeCompare(a[0])).slice(0, 7);
for (const [day, d] of sortedDays) {
  const dbDay = dbData.byDay.find(dd => dd.date === day);
  const dbCost = dbDay?.cost || 0;
  const match = Math.abs(d.cost - dbCost) < 0.1;
  console.log(`  ${day}  Direct: $${d.cost.toFixed(2).padStart(8)}  DB: $${dbCost.toFixed(2).padStart(8)}  ${match ? '✅' : '❌'}`);
}

console.log(`\nFiles scanned: ${fileCount}`);
console.log('');
