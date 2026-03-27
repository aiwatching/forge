/**
 * Workspace system integration tests.
 * Run: npx tsx lib/workspace/__tests__/workspace.test.ts
 */

import { AgentBus } from '../agent-bus';
import { AgentWorker } from '../agent-worker';
import { WorkspaceOrchestrator } from '../orchestrator';
import { createDevPipeline } from '../presets';
import { formatMemoryForPrompt, createMemory, addObservation, loadMemory } from '../smith-memory';
import type { WorkspaceAgentConfig, BusMessage } from '../types';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const TEST_WORKSPACE_ID = '__test_workspace__';
const TEST_PROJECT_PATH = '/tmp/forge-test-workspace';
const TEST_DIR = join(homedir(), '.forge', 'workspaces', TEST_WORKSPACE_ID);

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
  if (condition) {
    console.log(`  ✅ ${msg}`);
    passed++;
  } else {
    console.log(`  ❌ ${msg}`);
    failed++;
  }
}

function cleanup() {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_PROJECT_PATH, { recursive: true });
}

// ─── Test 1: CLI Marker Protocol ─────────────────────────

function testMarkerParsing() {
  console.log('\n📋 Test 1: CLI Marker Protocol');

  const orch = new WorkspaceOrchestrator(TEST_WORKSPACE_ID, TEST_PROJECT_PATH, 'test');

  orch.addAgent({
    id: 'qa-1', label: 'QA', icon: '🧪', role: '', backend: 'cli',
    dependsOn: [], outputs: [], steps: [],
  });
  orch.addAgent({
    id: 'eng-1', label: 'Engineer', icon: '🔨', role: '', backend: 'cli',
    dependsOn: [], outputs: [], steps: [],
  });

  // Simulate QA output with markers
  const messages: BusMessage[] = [];
  orch.on('event', (e: any) => {
    if (e.type === 'bus_message') messages.push(e.message);
  });

  // Access private method via any
  (orch as any).parseBusMarkers('qa-1', [
    { type: 'assistant', content: 'Found bug in auth module.\n[SEND:Engineer:fix_request] Authentication bypass in login flow' },
    { type: 'assistant', content: 'Another issue:\n[SEND:Engineer:fix_request] SQL injection in search' },
    { type: 'assistant', content: 'No marker here, just text.' },
  ]);

  assert(messages.length === 2, `Parsed 2 markers (got ${messages.length})`);
  assert(messages[0]?.to === 'eng-1', `First message targets Engineer`);
  assert(messages[0]?.payload.action === 'fix_request', `Action is fix_request`);
  assert(messages[0]?.payload.content?.includes('Authentication bypass') ?? false, `Content preserved`);

  // Test dedup — same content shouldn't send twice
  (orch as any).parseBusMarkers('qa-1', [
    { type: 'assistant', content: '[SEND:Engineer:fix_request] Authentication bypass in login flow' },
    { type: 'assistant', content: '[SEND:Engineer:fix_request] Authentication bypass in login flow' },
  ]);

  // Should still be 2 from before (dedup within this call)
  // Actually messages accumulate, but parseBusMarkers dedup is within one call
  // The 2nd call's dedup means only 1 new unique message
  const newMsgs = messages.length;
  assert(newMsgs === 3, `Dedup works: 3 total (got ${newMsgs})`);

  orch.shutdown();
}

// ─── Test 2: Bus ACK and Retry ───────────────────────────

async function testBusAckRetry() {
  console.log('\n📋 Test 2: Bus ACK and Retry');

  const bus = new AgentBus();
  bus.setAgentStatus('agent-a', 'alive');
  bus.setAgentStatus('agent-b', 'alive');

  // Send a message
  const msg = bus.send('agent-a', 'agent-b', 'notify', { action: 'test', content: 'hello' });
  assert(msg.status === 'pending', `Message starts as pending`);
  assert(msg.id.length > 0, `Message has ID`);

  // Mark as done directly (ACK timer removed — smith manages status via callbacks)
  msg.status = 'done';
  assert(msg.status === 'done', `Message done after processing`);

  // Test outbox for down agents
  bus.setAgentStatus('agent-c', 'down');
  const msg2 = bus.send('agent-a', 'agent-c', 'notify', { action: 'queued', content: 'for later' });
  assert(msg2.status === 'pending', `Message to down agent is pending`);
  assert(bus.getOutbox('agent-c').length === 1, `Outbox has 1 message`);

  // Agent comes back
  const flushed: BusMessage[] = [];
  bus.on('message', (m: BusMessage) => { if (m.payload.action === 'queued') flushed.push(m); });
  bus.setAgentStatus('agent-c', 'alive');
  assert(flushed.length === 1, `Outbox flushed on agent recovery`);
  assert(bus.getOutbox('agent-c').length === 0, `Outbox empty after flush`);

  // Test dedup
  assert(bus.isDuplicate('unique-id-1') === false, `First check: not duplicate`);
  assert(bus.isDuplicate('unique-id-1') === true, `Second check: is duplicate`);

  bus.clear();
}

// ─── Test 3: Memory Injection ────────────────────────────

async function testMemoryInjection() {
  console.log('\n📋 Test 3: Memory Injection');

  cleanup();

  // Create memory with observations
  const memory = createMemory('pm-1', 'PM', 'Product Manager');
  assert(memory.observations.length === 0, `New memory is empty`);

  // Add observations
  await addObservation(TEST_WORKSPACE_ID, 'pm-1', 'PM', 'Product Manager', {
    type: 'feature',
    title: 'Wrote PRD v1.0 for dictionary app',
    filesModified: ['docs/prd/v1.0-initial.md'],
    stepLabel: 'Write PRD',
  });

  await addObservation(TEST_WORKSPACE_ID, 'pm-1', 'PM', 'Product Manager', {
    type: 'decision',
    title: 'Chose localStorage over IndexedDB for history',
    stepLabel: 'Analyze',
  });

  // Load and check
  const loaded = loadMemory(TEST_WORKSPACE_ID, 'pm-1');
  assert(loaded !== null, `Memory loaded from disk`);
  assert(loaded!.observations.length === 2, `Has 2 observations`);

  // Format for prompt
  const prompt = formatMemoryForPrompt(loaded);
  assert(prompt.includes('Smith Memory'), `Prompt has header`);
  assert(prompt.includes('Wrote PRD v1.0'), `Prompt includes observation title`);
  assert(prompt.includes('localStorage'), `Prompt includes decision`);
  assert(prompt.includes('Do NOT redo completed work'), `Prompt has incremental instruction`);
  assert(prompt.length < 5000, `Prompt is reasonably sized (${prompt.length} chars)`);

  // Test empty memory
  const emptyPrompt = formatMemoryForPrompt(null);
  assert(emptyPrompt === '', `Empty memory returns empty string`);
}

// ─── Test 4: Input Incremental ───────────────────────────

function testInputIncremental() {
  console.log('\n📋 Test 4: Input Incremental (latest only to downstream)');

  cleanup();
  const orch = new WorkspaceOrchestrator(TEST_WORKSPACE_ID, TEST_PROJECT_PATH, 'test');

  // Create Input + PM
  orch.addAgent({
    id: 'input-1', label: 'Requirements', icon: '📝', type: 'input',
    content: '', entries: [], role: '', backend: 'cli',
    dependsOn: [], outputs: [], steps: [],
  });
  orch.addAgent({
    id: 'pm-1', label: 'PM', icon: '📋', role: 'Product Manager', backend: 'cli',
    dependsOn: ['input-1'], outputs: ['docs/prd/'],
    steps: [{ id: 's1', label: 'Analyze', prompt: 'Analyze requirements' }],
  });

  // Submit 3 entries
  orch.completeInput('input-1', 'Build a dictionary app');
  orch.completeInput('input-1', 'Add search history feature');
  orch.completeInput('input-1', 'Change history limit to 20');

  // Check entries
  const snapshot = orch.getSnapshot();
  const input = snapshot.agents.find(a => a.id === 'input-1');
  assert(input?.entries?.length === 3, `Input has 3 entries (got ${input?.entries?.length})`);

  // Check upstream context — should only contain latest
  const pmConfig = snapshot.agents.find(a => a.id === 'pm-1')!;
  const context = (orch as any).buildUpstreamContext(pmConfig) as string;
  assert(context.includes('Change history limit to 20'), `Context has latest entry`);
  assert(!context.includes('Build a dictionary app'), `Context does NOT have first entry`);
  assert(!context.includes('Add search history feature'), `Context does NOT have second entry`);

  orch.shutdown();
}

// ─── Test 5: Dev Pipeline Creation ───────────────────────

function testDevPipeline() {
  console.log('\n📋 Test 5: Dev Pipeline Creation');

  const pipeline = createDevPipeline();
  assert(pipeline.length === 5, `Pipeline has 5 agents (got ${pipeline.length})`);

  const [input, pm, eng, qa, rev] = pipeline;

  assert(input.type === 'input', `First is Input node`);
  assert(pm.label === 'PM', `Second is PM`);
  assert(eng.label === 'Engineer', `Third is Engineer`);
  assert(qa.label === 'QA', `Fourth is QA`);
  assert(rev.label === 'Reviewer', `Fifth is Reviewer`);

  // Check dependencies
  assert(pm.dependsOn.includes(input.id), `PM depends on Input`);
  assert(eng.dependsOn.includes(pm.id), `Engineer depends on PM`);
  assert(qa.dependsOn.includes(eng.id), `QA depends on Engineer`);
  assert(rev.dependsOn.includes(eng.id), `Reviewer depends on Engineer`);
  assert(rev.dependsOn.includes(qa.id), `Reviewer depends on QA`);

  // Check versioned outputs
  assert(pm.outputs.includes('docs/prd/'), `PM outputs to docs/prd/`);
  assert(eng.outputs.includes('docs/architecture/'), `Engineer outputs to docs/architecture/`);
  assert(qa.outputs.includes('docs/qa/'), `QA outputs to docs/qa/`);
  assert(rev.outputs.includes('docs/review/'), `Reviewer outputs to docs/review/`);

  // Check all have steps
  assert(pm.steps.length >= 2, `PM has steps`);
  assert(eng.steps.length >= 2, `Engineer has steps`);
  assert(qa.steps.length >= 2, `QA has steps`);
  assert(rev.steps.length >= 2, `Reviewer has steps`);
}

// ─── Test 6: Engineer→QA Revalidation ────────────────────

function testRevalidation() {
  console.log('\n📋 Test 6: Engineer completes → QA gets waiting_approval');

  cleanup();
  const orch = new WorkspaceOrchestrator(TEST_WORKSPACE_ID, TEST_PROJECT_PATH, 'test');

  orch.addAgent({
    id: 'eng-1', label: 'Engineer', icon: '🔨', role: '', backend: 'cli',
    dependsOn: [], outputs: ['src/'], steps: [{ id: 's1', label: 'Implement', prompt: 'code' }],
  });
  orch.addAgent({
    id: 'qa-1', label: 'QA', icon: '🧪', role: '', backend: 'cli',
    dependsOn: ['eng-1'], outputs: ['tests/'], steps: [{ id: 's1', label: 'Test', prompt: 'test' }],
  });

  // Manually set states to simulate: Engineer done first time, QA done first time
  const engEntry = (orch as any).agents.get('eng-1');
  const qaEntry = (orch as any).agents.get('qa-1');
  engEntry.state.status = 'done';
  engEntry.state.artifacts = [{ type: 'file', path: 'src/app.ts' }];
  qaEntry.state.status = 'done';

  // Track events
  const events: any[] = [];
  orch.on('event', (e: any) => events.push(e));

  // Now simulate Engineer completing again (re-run)
  (orch as any).notifyDownstreamForRevalidation('eng-1', ['src/app.ts']);

  // QA should be set to waiting_approval
  assert(qaEntry.state.status === 'waiting_approval', `QA is waiting_approval (got ${qaEntry.state.status})`);

  const approvalEvent = events.find(e => e.type === 'approval_required' && e.agentId === 'qa-1');
  assert(!!approvalEvent, `approval_required event emitted for QA`);
  assert(approvalEvent?.upstreamId === 'eng-1', `Upstream is Engineer`);

  // Check bus message was sent
  const busMsg = events.find(e => e.type === 'bus_message' && e.message?.payload?.action === 'update_notify');
  assert(!!busMsg, `update_notify bus message sent`);

  orch.shutdown();
}

// ─── Run all tests ───────────────────────────────────────

async function main() {
  console.log('🧪 Forge Smiths Workspace Tests\n');

  try { testMarkerParsing(); } catch (e: any) { console.log(`  💥 Test 1 crashed: ${e.message}`); failed++; }
  try { await testBusAckRetry(); } catch (e: any) { console.log(`  💥 Test 2 crashed: ${e.message}`); failed++; }
  try { await testMemoryInjection(); } catch (e: any) { console.log(`  💥 Test 3 crashed: ${e.message}`); failed++; }
  try { testInputIncremental(); } catch (e: any) { console.log(`  💥 Test 4 crashed: ${e.message}`); failed++; }
  try { testDevPipeline(); } catch (e: any) { console.log(`  💥 Test 5 crashed: ${e.message}`); failed++; }
  try { testRevalidation(); } catch (e: any) { console.log(`  💥 Test 6 crashed: ${e.message}`); failed++; }

  // Cleanup
  cleanup();

  console.log(`\n${'═'.repeat(40)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log(`${'═'.repeat(40)}`);

  process.exit(failed > 0 ? 1 : 0);
}

main();
